// Token arithmetic and the per-session ledger files that carry a change's totals across
// sessions: <home>/.claude/opsx-board/projects/<project>/ledgers/<change>/<sessionId>.json.
// One folder per project, so two projects never share a change's totals or its "also active"
// list, and one file per session, so parallel sessions never write the same file.
import type { EngineInterface, ModelUsage } from 'claude-code'

import type { AgentRun, Others, Usage } from '../types'

type Engine = EngineInterface

export const PRE_CHANGE = '_pre'
const ACTIVE_WINDOW_MS = 15 * 60 * 1000

export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

/** What `a` has beyond `b`, never below zero. */
export const usageBeyond = (a: Usage, b: Usage): Usage => ({
  input: Math.max(0, a.input - b.input),
  output: Math.max(0, a.output - b.output),
  cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
  cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
})

export const fromModelUsage =(usage: ModelUsage | undefined): Usage => ({
  input: usage?.input_tokens ?? 0,
  output: usage?.output_tokens ?? 0,
  cacheRead: usage?.cache_read_input_tokens ?? 0,
  cacheWrite: usage?.cache_creation_input_tokens ?? 0,
})

export const tokensOf = (usage: Usage): number => usage.input + usage.output + usage.cacheRead + usage.cacheWrite

export const agentTokens = (agent: AgentRun): number => {
  const counted = tokensOf(agent.usage)

  return counted > 0 ? counted : (agent.totalTokens ?? 0)
}

export const sumPhases = (byPhase: Record<string, Usage> | undefined): Usage =>
  Object.values(byPhase ?? {}).reduce(addUsage, zeroUsage())

/** Everything this session spent on one change: the main loop by phase, and its agents. */
export const sessionUsage = (main: Record<string, Usage> | undefined, agents: readonly AgentRun[]): Usage =>
  agents.reduce(
    (sum, agent) =>
      tokensOf(agent.usage) > 0
        ? addUsage(sum, agent.usage)
        : addUsage(sum, { ...zeroUsage(), input: agent.totalTokens ?? 0 }),
    sumPhases(main),
  )

export type LedgerFile = {
  change: string
  sessionId: string
  /** The project's root folder, for a person who reads the ledgers by hand. */
  root?: string
  updatedAt: number
  main: Record<string, Usage>
  agents: { id: string; type: string; group?: string; usage: Usage; totalTokens?: number }[]
}

// A change, a session, and a project name a folder or a file under the board's folder, and nothing else.
const isSafe = (name: string) => /^[A-Za-z0-9_][\w-]*$/.test(name)

// Marks an old ledger folder whose files a project has copied. Not `.json`: an older version of
// the board reads every `.json` file of a ledger folder as a ledger.
export const MOVED_MARK = 'MOVED.txt'

/** The board's own folder, `<home>/.claude/opsx-board`. */
export async function boardHome($: Engine): Promise<string | undefined> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

  return home === undefined ? undefined : `${home.replace(/[\\/]+$/, '')}/.claude/opsx-board`
}

/**
 * The folder name of a project: the name of its root folder, readable, then a hash of the
 * whole path, so two projects named `app` stay apart. A Windows path ignores case.
 */
export const projectKey = (root: string): string => {
  let path = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[A-Za-z]:/.test(path)) {
    path = path.toLowerCase()
  }
  // FNV-1a, 32 bits: the module has no crypto, and the hash only tells folders apart.
  let hash = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193) >>> 0
  }
  const name =
    (path.split('/').at(-1) ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project'

  return `${name}-${hash.toString(16).padStart(8, '0')}`
}

/** The ledger folder of the project at `root`. */
export const projectLedgers = (home: string, root: string): string => `${home}/projects/${projectKey(root)}/ledgers`

export async function writeLedger($: Engine, dir: string, file: LedgerFile): Promise<void> {
  if (!isSafe(file.change) || !isSafe(file.sessionId)) {
    return
  }
  await $.fs.write(`${dir}/${file.change}/${file.sessionId}.json`, JSON.stringify(file))
}

/**
 * Up to 0.2.0 the ledgers of every project shared one folder per change name,
 * `<home>/.claude/opsx-board/ledgers/<change>`. The first project that shows a change copies the
 * old ledgers of that name into its own folder, and marks the old folder so that no other project
 * takes them too. A file the project already has stays as it is. Says whether it copied.
 */
export async function claimOldLedgers($: Engine, home: string, dir: string, change: string, root: string): Promise<boolean> {
  if (change === PRE_CHANGE || !isSafe(change)) {
    return false
  }
  const old = `${home}/ledgers/${change}`
  const entries = await $.fs.list(old).catch(() => undefined)
  if (entries === undefined || entries.some(entry => entry.name === MOVED_MARK)) {
    return false
  }
  const present = new Set((await $.fs.list(`${dir}/${change}`).catch(() => [])).map(entry => entry.name))
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || !isSafe(entry.name.slice(0, -5)) || present.has(entry.name)) {
      continue
    }
    const text = await $.fs.read(`${old}/${entry.name}`).catch(() => undefined)
    if (typeof text === 'string') {
      await $.fs.write(`${dir}/${change}/${entry.name}`, text)
    }
  }
  await $.fs.write(`${old}/${MOVED_MARK}`, `The ledgers of this folder moved to the project at ${root}.\n`)

  return true
}

/**
 * Sums the ledgers other sessions of the project wrote for `change`, and names the project's
 * changes that other sessions work on now. `root` is the project's ledger folder (`projectLedgers`).
 */
export async function readOthers($: Engine, root: string, change: string | undefined, sessionId: string): Promise<Others> {
  const now = await $.clock.now()
  const others: Others = { usage: zeroUsage(), sessions: 0, activeChanges: [], phases: [] }
  const phases = new Set<string>()
  const folders = await $.fs.list(root).catch(() => [])
  for (const folder of folders) {
    if (folder.kind !== 'dir' || folder.name === PRE_CHANGE) {
      continue
    }
    const files = await $.fs.list(`${root}/${folder.name}`).catch(() => [])
    const mine = `${sessionId}.json`
    if (folder.name === change) {
      for (const entry of files) {
        if (entry.kind !== 'file' || entry.name === mine || !entry.name.endsWith('.json')) {
          continue
        }
        const text = await $.fs.read(`${root}/${folder.name}/${entry.name}`).catch(() => undefined)
        const parsed = typeof text === 'string' ? (JSON.parse(text) as LedgerFile) : undefined
        if (parsed) {
          const agents = parsed.agents.reduce(
            (sum, agent) =>
              tokensOf(agent.usage) > 0
                ? addUsage(sum, agent.usage)
                : addUsage(sum, { ...zeroUsage(), input: agent.totalTokens ?? 0 }),
            zeroUsage(),
          )
          others.usage = addUsage(others.usage, addUsage(sumPhases(parsed.main), agents))
          others.sessions += 1
          for (const [phase, usage] of Object.entries(parsed.main)) {
            if (tokensOf(usage) > 0) {
              phases.add(phase)
            }
          }
        }
      }
    } else if (files.some(entry => entry.name !== mine && now - entry.mtimeMs < ACTIVE_WINDOW_MS)) {
      others.activeChanges.push(folder.name)
    }
  }

  return { ...others, phases: [...phases].sort() }
}
