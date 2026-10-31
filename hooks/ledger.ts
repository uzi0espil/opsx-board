// Token arithmetic and the per-session ledger files that carry a change's totals
// across sessions: <home>/.claude/openspec-board/ledgers/<change>/<sessionId>.json.
// One file per session, so parallel sessions never write the same file.
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
  updatedAt: number
  main: Record<string, Usage>
  agents: { id: string; type: string; group?: string; usage: Usage; totalTokens?: number }[]
}

export async function ledgerRoot($: Engine): Promise<string | undefined> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

  return home === undefined ? undefined : `${home.replace(/[\\/]+$/, '')}/.claude/openspec-board/ledgers`
}

export async function writeLedger($: Engine, root: string, file: LedgerFile): Promise<void> {
  // The change and the session name a folder and a file under the ledger root, and nothing else.
  const isSafe = (name: string) => /^[A-Za-z0-9_][\w-]*$/.test(name)
  if (!isSafe(file.change) || !isSafe(file.sessionId)) {
    return
  }
  await $.fs.write(`${root}/${file.change}/${file.sessionId}.json`, JSON.stringify(file))
}

/** Sums the ledgers other sessions wrote for `change`, and names changes other sessions work on now. */
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
