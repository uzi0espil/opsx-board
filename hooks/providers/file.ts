// The `file` provider: work items that a file of the repository holds, each as a checkbox line
// whose bold text starts with its ID, such as `- [~] **WI-12 · CSV export**`. The proposal names
// an item with the same line; the mark of its line in the file is its state, and an item gone
// from the file but in its history file is resolved. It reads files of the repository only.
import type { FileRef, PlanningItem } from '../../types'
import { hintRegex, pathHint, patternHint } from '../check'
import type { Check, Doc } from '../check'
import { lines } from '../parse'
import type { Collected, Io, Opened, ProviderContext, WorkItemProvider } from './base'

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

/** The live marker of a work item's checkbox line in the file that holds it. */
export const findMarker = (md: string, id: string): string | undefined => {
  const pattern = new RegExp(`^\\s*- \\[([ xX~!])\\]\\s+\\*\\*${escape(id)}\\b`, 'm')

  return pattern.exec(md)?.[1]?.toLowerCase()
}

/** A work item's checkbox line and the lines nested under it, for the reader. */
export const itemBlock = (md: string, id: string): string | undefined => {
  const all = lines(md)
  const head = new RegExp(`^(\\s*)- \\[[ xX~!]\\]\\s+\\*\\*${escape(id)}\\b`)
  const at = all.findIndex(line => head.test(line))
  if (at < 0) {
    return undefined
  }
  const indent = head.exec(all[at] ?? '')?.[1]?.length ?? 0
  const block = [all[at] ?? '']
  for (const line of all.slice(at + 1)) {
    const own = /^(\s*)/.exec(line)?.[1]?.length ?? 0
    if (line.trim() !== '' && (own <= indent || /^#{1,6}\s/.test(line))) {
      break
    }
    block.push(line)
  }

  return block.join('\n').trimEnd()
}

/** The files that may hold an item of a ref: the file, then its history. */
const filesOf = (item: PlanningItem, refs: readonly FileRef[]): string[] => {
  const ref = refs.find(candidate => candidate.file === item.file)

  return [item.file, ref?.history].filter((file): file is string => file !== undefined)
}

export const fileProvider: WorkItemProvider<FileRef> = {
  name: 'file',
  isMany: true,
  readsGit: false,

  /** An ID pattern, the file that holds the items, and the file they move to once resolved. */
  ref(doc: Doc, check: Check, where: string): FileRef | undefined {
    const pattern = patternHint(check, where, doc['pattern'])
    const file = pathHint(check, where, doc['file'])
    if (pattern !== undefined && file !== undefined && !file.includes('{')) {
      return { provider: 'file', pattern, file, history: pathHint(check, where, doc['history']) }
    }
    if (pattern !== undefined) {
      check.warnings.push(`${where}: a work-item reference needs a pattern and a file`)
    }

    return undefined
  },

  /** A checkbox line whose bold text starts with an ID of one of the refs. */
  itemsOfLine(line: string, refs: readonly FileRef[]): PlanningItem[] {
    for (const ref of refs) {
      const found = hintRegex(`^\\s*- \\[([ xX~!])\\]\\s+\\*\\*(${ref.pattern})\\s*(?:·\\s*)?([^*]*)\\*\\*`, '')?.exec(line)
      if (found) {
        // The title is the last group: the ID pattern may hold groups of its own.
        const title = (found[found.length - 1] ?? '').trim()

        return [{ id: found[2] ?? '', title, provider: 'file', via: 'proposal', file: ref.file, mark: (found[1] ?? ' ').toLowerCase() }]
      }
    }

    return []
  },

  files: refs => [...new Set(refs.flatMap(ref => [ref.file, ...(ref.history === undefined ? [] : [ref.history])]))],

  /** The live marker of each item in the file that holds it; an item gone from the file but in its history is resolved. */
  async collect(io: Io, proposal: readonly PlanningItem[], refs: readonly FileRef[], context: ProviderContext): Promise<Collected> {
    const texts = new Map<string, string | undefined>()
    const textOf = async (file: string | undefined) => {
      if (file === undefined) {
        return undefined
      }
      if (!texts.has(file)) {
        texts.set(file, await io.read(`${context.cwd}/${file}`))
      }

      return texts.get(file)
    }
    const items: PlanningItem[] = []
    for (const item of proposal) {
      const ref = refs.find(candidate => candidate.file === item.file)
      const live = findMarker((await textOf(item.file)) ?? '', item.id)
      const history = live === undefined ? await textOf(ref?.history) : undefined
      const isResolved = history !== undefined && findMarker(history, item.id) !== undefined
      items.push({ ...item, mark: isResolved ? 'x' : live })
    }

    return { items, warnings: [] }
  },

  /** The item's block in the file that holds it, else in that file's history. */
  async open(io: Io, item: PlanningItem, refs: readonly FileRef[], context: ProviderContext): Promise<Opened> {
    const files = filesOf(item, refs)
    for (const file of files) {
      const text = await io.read(`${context.cwd}/${file}`)
      const block = text === undefined ? undefined : itemBlock(text, item.id)
      if (block !== undefined) {
        return { doc: { title: `${item.id} · ${file}`, text: block } }
      }
    }

    return { doc: { title: item.id, text: `${item.id} is not in ${files.join(' or ')}.` } }
  },
}
