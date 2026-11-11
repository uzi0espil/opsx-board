// Pure: the artifact graph of an OpenSpec schema, and the board.yaml hints beside it. No `$` here.
//
// A board.yaml can come with any repository, so its check is strict. It names built-in providers
// only, its paths stay inside the repository, a design opens only a document file, and each
// pattern must compile and stay short. A part that fails the check is dropped with a warning.
// A provider runs only the read commands the board holds itself: board.yaml names no command.
// Each provider checks the keys of its own refs (see ./providers).
import type { BoardHints, CommitHints, DesignHints, PlanHints, StageKey, StageSetting, VerdictHints, WorkItemRef } from '../types'
import { asString, asStrings, isDoc, pathHint, patternHint } from './check'
import type { Check, Doc } from './check'
import { isWorkItemProvider, readWorkItemRef } from './providers'
import { YamlError, parseYaml } from './yaml'

export { checkPattern, hintRegex, isRepoName, isSafeId, isSafePath, sectionHeading } from './check'

export type SchemaArtifact = { id: string; generates: string; requires: string[] }
export type SchemaInfo = { name: string; artifacts: SchemaArtifact[]; applyRequires: string[]; tracks?: string }

/** The artifacts and the apply step of a `schema.yaml`. Throws a YamlError on a file it cannot read. */
export const readSchema = (text: string): SchemaInfo | undefined => {
  const doc = parseYaml(text)
  if (!isDoc(doc)) {
    return undefined
  }
  const artifacts = (Array.isArray(doc['artifacts']) ? doc['artifacts'] : []).flatMap(item => {
    if (!isDoc(item)) {
      return []
    }
    const id = asString(item['id'])
    const generates = asString(item['generates'])

    return id === undefined || generates === undefined ? [] : [{ id, generates, requires: asStrings(item['requires']) }]
  })
  const apply = isDoc(doc['apply']) ? doc['apply'] : {}

  return { name: asString(doc['name']) ?? '', artifacts, applyRequires: asStrings(apply['requires']), tracks: asString(apply['tracks']) }
}

/** The schema an `.openspec.yaml` or an `openspec/config.yaml` names. */
export const schemaNameOf = (yaml: string): string | undefined => {
  const name = /^schema:\s*['"]?([A-Za-z0-9][\w.-]*)['"]?\s*(#.*)?$/m.exec(yaml)?.[1]

  return name !== undefined && isSchemaName(name) ? name : undefined
}

/** A schema name that may name a folder: no path separator and no `..`. */
export const isSchemaName = (name: string): boolean => /^[A-Za-z0-9][\w.-]{0,63}$/.test(name) && !name.includes('..')

/**
 * The level of each artifact: 0 when it requires nothing, else one more than the deepest
 * artifact it requires. A cycle or an unknown name counts as level 0.
 */
export const artifactLevels = (rows: readonly { id: string; requires?: readonly string[] }[]): Map<string, number> => {
  const byId = new Map(rows.map(row => [row.id, row]))
  const levels = new Map<string, number>()
  const visit = (id: string, path: Set<string>): number => {
    const known = levels.get(id)
    if (known !== undefined) {
      return known
    }
    const row = byId.get(id)
    if (row === undefined || path.has(id)) {
      return -1
    }
    path.add(id)
    const level = Math.max(-1, ...(row.requires ?? []).map(dep => visit(dep, path))) + 1
    path.delete(id)
    levels.set(id, level)

    return level
  }
  for (const row of rows) {
    visit(row.id, new Set())
  }

  return levels
}

/** The rows in `requires` order: by level, else in their declared order. */
export const inRequiresOrder = <T extends { id: string; requires?: readonly string[] }>(rows: readonly T[]): (T & { level: number })[] => {
  const levels = artifactLevels(rows)

  return rows
    .map((row, index) => ({ row: { ...row, level: levels.get(row.id) ?? 0 }, index }))
    .sort((a, b) => a.row.level - b.row.level || a.index - b.index)
    .map(item => item.row)
}

// ── board.yaml ──────────────────────────────────────────────────────────────

// A design opens with the system opener, so only a document type; never a program or a script.
const OPEN_TYPES = /\.(html?|pdf|png|jpe?g|gif|svg|webp|md|txt)$/i

export const defaultHints = (schema: string): BoardHints => ({
  schema,
  verdicts: {},
  commits: {},
  verifyLabel: 'Verify',
  skipReportAgents: [],
  warnings: [],
})

type Refs = { work: WorkItemRef[]; design?: Omit<DesignHints, 'label' | 'section' | 'skipArgs'> }

const readRefs = (check: Check, refs: unknown): Refs => {
  const work: WorkItemRef[] = []
  let design: Omit<DesignHints, 'label' | 'section' | 'skipArgs'> | undefined
  ;(Array.isArray(refs) ? refs : []).forEach((ref, index) => {
    const where = `refs[${index}]`
    if (!isDoc(ref)) {
      check.warnings.push(`${where}: not a mapping`)
      return
    }
    const kind = asString(ref['kind'])
    // A work-item ref goes to the provider it names, which checks its own keys.
    if (kind === 'work-item') {
      const read = readWorkItemRef(ref, work, check, where)
      if (read !== undefined) {
        work.push(read)
      }
      return
    }
    const provider = asString(ref['provider']) ?? 'file'
    if (provider !== 'file') {
      check.warnings.push(
        isWorkItemProvider(provider) ? `${where}: provider "${provider}" gives work items only` : `${where}: provider "${provider}" is not built in yet`,
      )
      return
    }
    if (kind === 'design') {
      if (design !== undefined) {
        check.warnings.push(`${where}: only the first design reference counts`)
        return
      }
      const path = patternHint(check, where, ref['pattern'])
      const dir = pathHint(check, where, ref['dir'])
      const open = pathHint(check, where, ref['open'])
      if (open !== undefined && (open.includes('/') || !OPEN_TYPES.test(open))) {
        check.warnings.push(`${where}: open must name a document file in the design folder, such as artifact.html`)
      }
      if (path === undefined || dir === undefined || !dir.includes('{id}')) {
        check.warnings.push(`${where}: a design reference needs a pattern and a dir with {id}`)
        return
      }
      design = {
        path,
        dir,
        open: open !== undefined && !open.includes('/') && OPEN_TYPES.test(open) ? open : undefined,
        screenshots: pathHint(check, where, ref['screenshots']),
        decisions: pathHint(check, where, ref['decisions']),
        needs: patternHint(check, where, ref['needs'], 'i'),
      }
      return
    }
    check.warnings.push(`${where}: kind "${kind ?? ''}" is not known`)
  })

  return { work, design }
}

function readVerdicts(check: Check, artifacts: unknown): Record<string, VerdictHints> {
  const out: Record<string, VerdictHints> = {}
  for (const [id, value] of Object.entries(isDoc(artifacts) ? artifacts : {})) {
    const verdict = isDoc(value) && isDoc(value['verdict']) ? value['verdict'] : undefined
    if (verdict === undefined) {
      continue
    }
    const values = asStrings(verdict['values']).filter(item => /^[\w -]{1,40}$/.test(item))
    if (values.length === 0) {
      check.warnings.push(`artifacts.${id}.verdict: no values`)
      continue
    }
    const notes = (Array.isArray(verdict['notes']) ? verdict['notes'] : []).flatMap((note, index) => {
      const pattern = isDoc(note) ? patternHint(check, `artifacts.${id}.verdict.notes[${index}]`, note['pattern'], 'i') : undefined
      const text = isDoc(note) ? asString(note['text']) : undefined

      return pattern === undefined || text === undefined ? [] : [{ pattern, text: text.slice(0, 60) }]
    })
    out[id] = {
      values,
      block: asStrings(verdict['block']).filter(item => values.includes(item)),
      warn: asStrings(verdict['warn']).filter(item => values.includes(item)),
      next: nextCommand(check, `artifacts.${id}.verdict.next`, verdict['next']),
      notes,
    }
  }

  return out
}

const readCommits = (check: Check, commits: unknown): CommitHints => {
  const doc = isDoc(commits) ? commits : {}

  return {
    artifacts: patternHint(check, 'commits.artifacts', doc['artifacts'], 'i'),
    task: patternHint(check, 'commits.task', doc['task']),
    reviewFix: patternHint(check, 'commits.reviewFix', doc['reviewFix'], 'i'),
    archive: patternHint(check, 'commits.archive', doc['archive'], 'i'),
  }
}

/** A command, as board.yaml names it, without its slash. */
const commandName = (value: unknown): string | undefined => {
  const name = asString(value)?.replace(/^\//, '')

  return name !== undefined && /^[\w:.-]{1,64}$/.test(name) ? name : undefined
}

/**
 * A command line that Next may put in the prompt: one slash command and a short argument.
 * Next only fills the prompt, and the person runs the command.
 */
const nextCommand = (check: Check, where: string, value: unknown): string | undefined => {
  const text = asString(value)
  if (text === undefined) {
    return undefined
  }
  if (!/^\/[\w:.-]{1,64}( [\w{}. -]{0,80})?$/.test(text)) {
    check.warnings.push(`${where}: "${text}" is not a slash command with a short argument`)

    return undefined
  }

  return text
}

/** Every stage of the board, in the default order of the flow. */
export const STAGE_KEYS: readonly StageKey[] = ['explore', 'plan', 'design', 'propose', 'apply', 'verify', 'pr', 'archive']

/** A stage that board.yaml moves before or after another. */
type StageMove = { key: StageKey; before?: StageKey; after?: StageKey }

const stageKeyOf = (check: Check, where: string, name: string, value: unknown): StageKey | undefined => {
  const text = asString(value)
  if (text === undefined) {
    return undefined
  }
  const key = STAGE_KEYS.find(candidate => candidate === text)
  if (key === undefined) {
    check.warnings.push(`${where}: ${name} "${text}" is no stage of the board`)
  }

  return key
}

const flagOf = (check: Check, where: string, name: string, value: unknown): boolean | undefined => {
  if (value !== undefined && typeof value !== 'boolean') {
    check.warnings.push(`${where}: ${name} must be true or false`)

    return undefined
  }

  return value === true ? true : undefined
}

/** What a stage entry sets for its stage: its label, whether it shows, whether Next skips it, and its place. */
function readStageSetting(check: Check, where: string, entry: Doc, key: StageKey, settings: Map<StageKey, StageSetting>, moves: StageMove[]): void {
  const label = asString(entry['label'])?.slice(0, 24)
  const setting: StageSetting = { key }
  if (label !== undefined) {
    setting.label = label
  }
  const isHidden = flagOf(check, where, 'hidden', entry['hidden'])
  if (isHidden !== undefined) {
    setting.isHidden = isHidden
  }
  const isOptional = flagOf(check, where, 'optional', entry['optional'])
  if (isOptional !== undefined) {
    setting.isOptional = isOptional
  }
  settings.set(key, setting)
  const before = stageKeyOf(check, where, 'before', entry['before'])
  const after = stageKeyOf(check, where, 'after', entry['after'])
  if (before !== undefined || after !== undefined) {
    moves.push({ key, before, after })
  }
}

/** The order of the flow: the default order, with each stage moved as board.yaml says, in its order. */
const flowOrder = (moves: readonly StageMove[]): StageKey[] => {
  let order = [...STAGE_KEYS]
  for (const move of moves) {
    const target = move.before ?? move.after
    if (target === undefined || target === move.key) {
      continue
    }
    order = order.filter(key => key !== move.key)
    const at = order.indexOf(target)
    order.splice(move.before !== undefined ? at : at + 1, 0, move.key)
  }

  return order
}

/**
 * The hints of one board.yaml, checked. `file` is the path the text came from. A file the
 * YAML reader refuses gives the default hints with a warning.
 */
export const readHints = (schema: string, text: string, file: string): BoardHints => {
  const hints: BoardHints = { ...defaultHints(schema), file }
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (error) {
    const reason = error instanceof YamlError ? error.message : 'unreadable'
    hints.warnings.push(`board.yaml ${reason}`)

    return hints
  }
  if (!isDoc(doc)) {
    hints.warnings.push('board.yaml holds no mapping')

    return hints
  }
  const check: Check = { warnings: hints.warnings }
  const version = doc['version']
  if (version !== undefined && version !== 1) {
    check.warnings.push(`board.yaml version ${String(version)} is not known; the board reads it as version 1`)
  }
  const refs = readRefs(check, doc['refs'])
  const settings = new Map<StageKey, StageSetting>()
  const moves: StageMove[] = []
  for (const [index, stage] of (Array.isArray(doc['stages']) ? doc['stages'] : []).entries()) {
    if (!isDoc(stage)) {
      continue
    }
    const collects = asString(stage['collects'])
    const where = `stages[${index}]`
    // An entry without `collects` sets a stage of the board, which its id names.
    if (collects === undefined) {
      const id = asString(stage['id'])
      const key = STAGE_KEYS.find(candidate => candidate === id)
      if (key === undefined) {
        check.warnings.push(`${where}: "${id ?? ''}" is no stage of the board; a new stage needs collects`)
        continue
      }
      readStageSetting(check, where, stage, key, settings, moves)
      continue
    }
    readStageSetting(check, where, stage, collects === 'design' ? 'design' : 'plan', settings, moves)
    const label = (asString(stage['label']) ?? asString(stage['id']) ?? collects ?? 'Stage').slice(0, 24)
    const section = asString(stage['section'])
    if (section === undefined || section.trim() === '') {
      check.warnings.push(`stages[${index}]: a stage needs the proposal section it reads`)
      continue
    }
    if (collects === 'work-item' && hints.plan === undefined) {
      const plan: PlanHints = {
        label,
        section,
        agent: asString(stage['agent']),
        isBeforeExplore: asString(stage['before']) === 'explore',
        refs: refs.work,
      }
      hints.plan = plan
    } else if (collects === 'design' && hints.design === undefined) {
      if (refs.design === undefined) {
        check.warnings.push(`stages[${index}]: the design stage has no design reference in refs`)
        continue
      }
      const next = isDoc(stage['next']) ? stage['next'] : {}
      hints.design = {
        ...refs.design,
        label,
        section,
        command: commandName(stage['command']),
        skipArgs: asStrings(stage['skipArgs']),
        nextNew: nextCommand(check, `stages[${index}].next.new`, next['new']),
        nextUpdate: nextCommand(check, `stages[${index}].next.update`, next['update']),
      }
    } else {
      check.warnings.push(`stages[${index}]: collects "${collects ?? ''}" is not known, or a second stage collects it`)
    }
  }
  hints.flow = flowOrder(moves).map(key => settings.get(key) ?? { key })
  hints.verdicts = readVerdicts(check, doc['artifacts'])
  hints.commits = readCommits(check, doc['commits'])
  const verify = isDoc(doc['verify']) ? doc['verify'] : {}
  hints.verifyLabel = (asString(verify['label']) ?? 'Verify').slice(0, 16)
  hints.reviewAgent = asString(verify['agent'])
  hints.findings = patternHint(check, 'verify.findings', verify['findings'])
  const apply = isDoc(doc['apply']) ? doc['apply'] : {}
  hints.skipReportAgents = asStrings(apply['skipReportAgents'])

  return hints
}
