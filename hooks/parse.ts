// Pure parsers for the files and outputs the OpenSpec workflow writes. No `$` here.
// What a project adds to OpenSpec (its planning items, designs, verdicts, and commit
// subjects) is read with the patterns of its board.yaml hints.
import type { BoardHints, Commit, CommitHints, CommitKind, DesignHints, Phase, PlanHints, PlanningItem, TaskGroup, Verdict, VerdictHints } from '../types'
import { hintRegex, isSafeId, sectionHeading } from './schema'

// The checkbox pattern of the OpenSpec CLI (dist/utils/task-progress.js).
// Only `x` / `X` counts as done; `[~]`, `[-]` and `[ ]` do not.
const CHECKBOX = /^\s*(?:[-*+]|\d{1,9}[.)])\s*\[(?:\s*([^\]\s]?)\s*\](?![([])|\s+\])\s*(.*)/
const GROUP = /^##\s+(\d+)\.\s+(.*?)\s*$/
const TASK_ID = /^(\d+(?:\.\d+)+)\s+/
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

const lines = (text: string): string[] => text.split(/\r?\n/)

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

/** The lines under the first `## ` heading that matches, up to the next `## ` heading. */
const section = (md: string, heading: RegExp): string[] | undefined => {
  const all = lines(md)
  const at = all.findIndex(line => heading.test(line))
  if (at < 0) {
    return undefined
  }
  const rest = all.slice(at + 1)
  const end = rest.findIndex(line => /^##\s/.test(line))

  return end < 0 ? rest : rest.slice(0, end)
}

export const parseTasks = (md: string): TaskGroup[] => {
  const groups: TaskGroup[] = []
  let current: TaskGroup | undefined
  lines(md).forEach((line, index) => {
    const heading = GROUP.exec(line)
    if (heading) {
      current = { num: heading[1] ?? '?', title: heading[2] ?? '', tasks: [] }
      groups.push(current)
      return
    }
    const box = CHECKBOX.exec(line)
    if (!box) {
      return
    }
    if (!current) {
      current = { num: '-', title: 'Tasks', tasks: [] }
      groups.push(current)
    }
    const text = box[2] ?? ''
    const id = TASK_ID.exec(text)?.[1] ?? `${current.num}.${current.tasks.length + 1}`
    const mark = (box[1] ?? '').toLowerCase() || ' '
    current.tasks.push({ id, text: text.replace(TASK_ID, ''), mark, line: index + 1 })
  })

  return groups
}

export const countDone = (group: TaskGroup): number => group.tasks.filter(task => task.mark === 'x').length

/**
 * The verdict a review artifact states: the first line under a `## Verdict` heading, as
 * `**VALUE**`, else a `VERDICT: value` anywhere. The values, and which of them block or warn,
 * come from the hints. The first note pattern that matches gives a note, `{1}` its group.
 */
export const readVerdict = (md: string, artifact: string, hints: VerdictHints): Verdict | undefined => {
  const values = [...hints.values].sort((a, b) => b.length - a.length).map(escape).join('|')
  const all = lines(md)
  const at = all.findIndex(line => /^##\s+Verdict\s*$/i.test(line))
  let value: string | undefined
  for (const line of at < 0 ? [] : all.slice(at + 1)) {
    const text = line.trim()
    if (text === '' || text.startsWith('<!--')) {
      continue
    }
    if (!/^##\s/.test(text)) {
      value = new RegExp(`^\\*\\*(${values})\\*\\*`, 'i').exec(text)?.[1]
    }
    break
  }
  value ??= new RegExp(`VERDICT:\\s*\\**\\s*(${values})(?![\\w-])`, 'i').exec(md)?.[1]
  const known = hints.values.find(item => item.toLowerCase() === value?.toLowerCase())
  if (known === undefined) {
    return undefined
  }
  const level = hints.block.includes(known) ? 'block' : hints.warn.includes(known) ? 'warn' : 'ok'
  let note: string | undefined
  for (const item of level === 'warn' ? hints.notes : []) {
    const pattern = hintRegex(item.pattern, '', 'i')
    const match = all.map(line => pattern?.exec(line)).find(found => found)
    if (match) {
      note = item.text.replace(/\{1\}/g, match[1] ?? '')
      break
    }
  }

  return { artifact, value: known, level, note, next: level === 'block' ? hints.next : undefined }
}

/**
 * The work items a proposal names in its planning section: each checkbox line whose bold text
 * starts with an ID of one of the sources, and a `None — <reason>` line.
 */
export const parsePlanning = (md: string, hints: PlanHints): { items: PlanningItem[]; none?: string } => {
  const body = section(md, sectionHeading(hints.section))
  const items: PlanningItem[] = []
  let none: string | undefined
  const sources = hints.sources.flatMap(source => {
    const pattern = hintRegex(`^\\s*- \\[([ xX~!])\\]\\s+\\*\\*(${source.pattern})\\s*(?:·\\s*)?([^*]*)\\*\\*`, '')

    return pattern === undefined ? [] : [{ source, pattern }]
  })
  for (const line of body ?? []) {
    const found = sources.map(({ source, pattern }) => ({ source, item: pattern.exec(line) })).find(match => match.item)
    if (found?.item) {
      const groups = found.item.length
      items.push({
        id: found.item[2] ?? '',
        // The title is the last group: the ID pattern may hold groups of its own.
        title: (found.item[groups - 1] ?? '').trim(),
        file: found.source.file,
        mark: (found.item[1] ?? ' ').toLowerCase(),
      })
      continue
    }
    const empty = /^None\s*[—–-]\s*(.*)$/.exec(line.trim())
    if (empty) {
      none = empty[1] ?? ''
    }
  }

  return { items, none }
}

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

export type DesignRow = { label: string; view?: string; statusText: string; isNeedsDesign: boolean }

/**
 * The designs a proposal names in its design section. A table gives one row per design: the
 * design id from the first cell that holds a design path, the status from the last cell. A
 * section written as prose gives each design path it names. An id that could leave the design
 * folder is dropped.
 */
export const parseVisualDesign = (md: string, hints: DesignHints): DesignRow[] => {
  const body = section(md, sectionHeading(hints.section)) ?? []
  const needs = hints.needs === undefined ? undefined : hintRegex(hints.needs, '', 'i')
  const path = hintRegex(hints.path, '')
  const idOf = (text: string): string | undefined => {
    const id = path?.exec(text)?.[1]

    return id !== undefined && isSafeId(id) ? id : undefined
  }
  const table = body.filter(line => line.trim().startsWith('|'))
  const isDivider = (line: string | undefined) => line !== undefined && /^\s*\|?\s*:?-{3,}/.test(line)
  const rows = (isDivider(table[1]) ? table.slice(2) : table)
    .filter(line => !isDivider(line))
    .map(tableCells)
    .filter(cells => cells.length >= 2)
    .map(cells => {
      const statusText = cells.at(-1) ?? ''

      return {
        label: cells[0] ?? '',
        view: cells.slice(1, -1).map(idOf).find(id => id !== undefined),
        statusText,
        isNeedsDesign: needs?.test(statusText) ?? false,
      }
    })
  if (rows.length > 0) {
    return rows
  }
  const prose = body.join('\n')
  const every = path === undefined ? [] : [...prose.matchAll(new RegExp(path.source, 'g'))]
  const views = [...new Set(every.map(match => match[1] ?? ''))].filter(isSafeId)

  return views.map(view => ({ label: view, view, statusText: 'named in the proposal', isNeedsDesign: needs?.test(prose) ?? false }))
}

export const parseDecisions = (md: string): { approvedAt?: string; updatedAt?: string; revisions: number } => {
  const head = lines(md).slice(0, 12)
  const line = head.find(text => /^(Approved:|Status:.*Approved)/i.test(text.trim()))
  const approvedAt = line === undefined ? undefined : (/(\d{4}-\d{2}-\d{2})/.exec(line)?.[1] ?? 'yes')
  const stated = Number(/revision\s+(\d+)/i.exec(line ?? '')?.[1] ?? 0)
  const updates = (section(md, /^##\s+Updates/) ?? []).filter(text => /^\s*-\s*\d{4}-\d{2}-\d{2}/.test(text))
  const updatedAt = updates
    .map(text => /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? '')
    .sort()
    .at(-1)

  return { approvedAt, updatedAt: updatedAt === '' ? undefined : updatedAt, revisions: Math.max(stated, updates.length) }
}

/** `created: YYYY-MM-DD` of a change's `.openspec.yaml`. */
export const parseCreated = (yaml: string): string | undefined => /^created:\s*['"]?(\d{4}-\d{2}-\d{2})/m.exec(yaml)?.[1]

/**
 * `git log --format=%h%x09%s` lines whose subject carries the change as its scope, as
 * `feat(<change>): ...`. The commit hints tell the kinds apart; without them every commit is `other`.
 */
export const classifyCommits = (log: string, change: string, hints: CommitHints = {}): Commit[] => {
  const pattern = (text: string | undefined, flags: string) => (text === undefined ? undefined : hintRegex(text, change, flags))
  const artifacts = pattern(hints.artifacts, 'i')
  const task = pattern(hints.task, '')
  const reviewFix = pattern(hints.reviewFix, 'i')
  const archive = pattern(hints.archive, 'i')

  return lines(log)
    .map(line => {
      const [hash = '', ...rest] = line.split('\t')

      return { hash, subject: rest.join('\t') }
    })
    .filter(commit => commit.hash !== '' && commit.subject.includes(`(${change})`))
    .map(commit => {
      const group = task?.exec(commit.subject)?.[1]
      const kind: CommitKind = artifacts?.test(commit.subject)
        ? 'artifacts'
        : group !== undefined
          ? 'task'
          : reviewFix?.test(commit.subject)
            ? 'review-fix'
            : archive?.test(commit.subject)
              ? 'archive'
              : 'other'

      return { ...commit, kind, group }
    })
}

/** Counts the finding lines of a review report by kind: the first group of the findings pattern. */
export const countFindings = (report: string, findings: string | undefined): Record<string, number> => {
  const counts: Record<string, number> = {}
  const pattern = findings === undefined ? undefined : hintRegex(findings, '')
  for (const line of pattern === undefined ? [] : lines(report)) {
    const kind = pattern?.exec(line)?.[1]
    if (kind) {
      counts[kind] = (counts[kind] ?? 0) + 1
    }
  }

  return counts
}

export const parseVerifyVerdict = (report: string): string | undefined => {
  const critical = /(\d+) critical issue\(s\) found/i.exec(report)
  if (critical) {
    return `${critical[1]} critical`
  }
  if (/All checks passed/i.test(report)) {
    return 'all checks passed'
  }
  if (/Ready for archive \(with noted improvements\)/i.test(report)) {
    return 'ready, with notes'
  }
  if (/No critical issues found in the checks that ran/i.test(report)) {
    return 'partly verified'
  }

  return undefined
}

/** The task group an agent works on, from its description and prompt. */
export const inferGroup = (text: string, groups: readonly TaskGroup[]): string | undefined => {
  const nums = new Set(groups.map(group => group.num))
  const explicit = [/\btask\s+group\s+#?(\d+)\b/i, /\bgroup\s+#?(\d+)\b/i, /^##\s*(\d+)\./m, /\bTask\s+(\d+)\b(?!\.\d)/]
  for (const pattern of explicit) {
    const num = pattern.exec(text)?.[1]
    if (num !== undefined && nums.has(num)) {
      return num
    }
  }
  const lower = text.toLowerCase()
  const byTitle = groups.find(group => group.title.length >= 6 && lower.includes(group.title.toLowerCase()))
  if (byTitle) {
    return byTitle.num
  }
  const ids = new Set(groups.flatMap(group => group.tasks.map(task => task.id)))
  for (const match of text.matchAll(/\b(\d+)\.(\d+)\b/g)) {
    if (ids.has(`${match[1]}.${match[2]}`)) {
      return match[1]
    }
  }

  return undefined
}

/**
 * A change name the mod accepts: kebab-case, as OpenSpec writes it. Each name that reaches
 * a command line (`cmd /c openspec` on Windows) or a ledger path passes this check first.
 */
export const isChangeName = (name: string): boolean => NAME.test(name)

/**
 * The change name an `/opsx:*` command names: a single kebab-case argument, as the
 * session-title hook reads `/opsx:propose <name>`. A sentence names no change.
 */
export const changeFromArgs = (args: string): string | undefined => {
  const token = args.trim()

  return NAME.test(token) ? token : undefined
}

/**
 * The design that a design command names: `<view>` or `update <view>`. A first word in
 * `skipArgs` (such as `component <name>`, a shared component and no view) names none.
 */
export const designFromArgs = (args: string, skipArgs: readonly string[] = []): { view: string; mode: 'new' | 'update' } | undefined => {
  const tokens = args.trim().split(/\s+/).filter(token => token !== '')
  if (tokens[0] !== undefined && skipArgs.includes(tokens[0])) {
    return undefined
  }
  const isUpdate = tokens[0] === 'update'
  const view = isUpdate ? tokens[1] : tokens[0]

  return view !== undefined && NAME.test(view) ? { view, mode: isUpdate ? 'update' : 'new' } : undefined
}

/** Names a branch could carry a change under: `worktree-<x>`, `feat/<x>`, or the bare name. */
export const changeFromBranch = (branch: string, changes: readonly string[]): string | undefined => {
  const base = branch.replace(/^worktree-/, '').replace(/^[a-z]+\//, '')

  return changes.find(change => change === base || change === branch)
}

/** The phase of a workflow command: an `/opsx:*` command, or the design command of the hints. */
export const phaseOfCommand = (name: string, hints?: BoardHints | null): Phase | undefined => {
  if (hints?.design?.command !== undefined && name === hints.design.command) {
    return 'design'
  }
  switch (name) {
    case 'opsx:propose':
    case 'opsx:new':
    case 'opsx:continue':
    case 'opsx:update':
      return 'propose'
    case 'opsx:explore':
      return 'explore'
    case 'opsx:apply':
      return 'apply'
    case 'opsx:verify':
      return 'verify'
    case 'opsx:sync':
    case 'opsx:archive':
      return 'archive'
    default:
      return undefined
  }
}

export const isTracked = (name: string, hints?: BoardHints | null): boolean => phaseOfCommand(name, hints) !== undefined

const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/
const FENCE = /^\s*(```|~~~)/
// A cell this long or shorter rides on the row's title line; a longer one is a paragraph.
const SHORT_CELL = 32
// The second cell joins the first in the title up to this length.
const TITLE_CELL = 60

/** The cells of one GFM table row: split on every unescaped pipe, as GFM does, `\|` kept as `|`. */
export const tableCells = (line: string): string[] => {
  const text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  const cells: string[] = []
  let cell = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '\\' && text[index + 1] === '|') {
      cell += '|'
      index++
    } else if (char === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell.trim())

  return cells
}

const tableAsList = (header: readonly string[], rows: readonly string[][]): string[] => {
  const out: string[] = []
  for (const row of rows) {
    const [first = '', second = ''] = row
    const isPair = second !== '' && second.length <= TITLE_CELL
    const title = isPair ? (first === '' ? second : `${first} · ${second}`) : first
    const rest = row
      .map((cell, index) => ({ head: header[index] ?? '', cell }))
      .slice(isPair ? 2 : 1)
      .filter(item => item.cell !== '')
    const inline = rest.filter(item => item.cell.length <= SHORT_CELL).map(item => `${item.head}: ${item.cell}`)
    const blocks = rest.filter(item => item.cell.length > SHORT_CELL)
    out.push(`- **${title}**${inline.length > 0 ? ` — ${inline.join(' · ')}` : ''}`)
    for (const block of blocks) {
      out.push('', `  ${blocks.length > 1 ? `*${block.head}:* ` : ''}${block.cell}`)
    }
    out.push('')
  }

  return out
}

/**
 * Redraws each GFM table wider than `width` as a list, one item per row, so a narrow
 * pane shows the text instead of a squeezed grid. A table that fits stays a table.
 */
export const reflowTables = (md: string, width: number): { text: string; reflowed: number } => {
  const all = lines(md)
  const out: string[] = []
  let isFence = false
  let reflowed = 0
  for (let index = 0; index < all.length; index++) {
    const line = all[index] ?? ''
    if (FENCE.test(line)) {
      isFence = !isFence
    }
    const divider = all[index + 1]
    if (isFence || !line.trim().startsWith('|') || divider === undefined || !TABLE_DIVIDER.test(divider)) {
      out.push(line)
      continue
    }
    const header = tableCells(line)
    let end = index + 2
    const rows: string[][] = []
    while (end < all.length && (all[end] ?? '').trim().startsWith('|')) {
      rows.push(tableCells(all[end] ?? ''))
      end++
    }
    const widths = header.map((head, column) => Math.max(head.length, ...rows.map(row => (row[column] ?? '').length)))
    const natural = widths.reduce((sum, cell) => sum + cell + 3, 1)
    if (natural <= width) {
      out.push(...all.slice(index, end))
    } else {
      out.push(...tableAsList(header, rows))
      reflowed++
    }
    index = end - 1
  }

  return { text: out.join('\n'), reflowed }
}

/** The JSON object a CLI printed, tolerating a banner line before it. */
export const parseJson = (stdout: string): unknown => {
  const at = stdout.indexOf('{')
  if (at < 0) {
    return undefined
  }
  try {
    return JSON.parse(stdout.slice(at))
  } catch {
    return undefined
  }
}

export const formatTokens = (count: number): string =>
  count < 1000
    ? `${count}`
    : count < 1_000_000
      ? `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
      : `${(count / 1_000_000).toFixed(2)}M`

export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  }

  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}
