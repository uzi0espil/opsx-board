// Pure: what the change and the session show, which more than one stage reads. The last workflow
// command, what runs now, the apply run, the designs in review, and the verdict that blocks.
import type { AgentRun, BoardHints, DesignView, Live, Phase, Snapshot } from '../../types'
import { changeFromArgs, countDone, phaseOfCommand } from '../parse'
import type { StageContext } from './base'

/** How long the last workflow command counts as recent. */
export const RECENT_MS = 30 * 60 * 1000

export const isRunning = (agent: AgentRun): boolean => agent.status === 'running'

/** The last workflow command was for this change: the change it bound, else the change its argument names, else any. */
export const isCommandFor = (live: Live, change: string | undefined): boolean => {
  const named = live.command?.change ?? (live.command === undefined ? undefined : changeFromArgs(live.command.args))

  return named === undefined || named === change
}

/** The main turn that runs the last workflow command has not ended. */
export const isCommandTurn = (live: Live): boolean => live.command !== undefined && live.command.endedAt === undefined

/** A main turn has started and not ended. */
export const isTurnRunning = (live: Live): boolean => live.turnAt !== undefined && (live.turnEndedAt ?? 0) < live.turnAt

/** The change has apply work: a checked task, or a commit of the apply run. */
export const hasApplyWork = (snap: Snapshot): boolean =>
  snap.groups.some(group => countDone(group) > 0) || snap.commits.some(commit => commit.kind !== 'other')

/** The strict validation at the start of `/opsx:apply` refused the change, before any apply work. */
export const isApplyRefused = (live: Live, snap: Snapshot | null): boolean =>
  snap !== null &&
  live.command?.name === 'opsx:apply' &&
  isCommandFor(live, snap.change) &&
  live.isValidateOk === false &&
  (live.validateAt ?? 0) >= live.command.at &&
  !hasApplyWork(snap)

/**
 * An apply run starts with `/opsx:apply` for the change and lasts while that command is the last
 * workflow command of the session. It ends early when the strict validation at its start refuses
 * the change, or when a main turn ends by an interrupt, an error, or a refusal.
 */
export const isApplyRun = (live: Live, snap: Snapshot | null): boolean =>
  snap !== null &&
  snap.change !== '' &&
  live.command?.name === 'opsx:apply' &&
  isCommandFor(live, snap.change) &&
  (live.stoppedAt ?? 0) < live.command.at &&
  !isApplyRefused(live, snap)

/** The session designs while the design command of the hints is its last workflow command, as it explores with `/opsx:explore`. */
export const isDesigning = (live: Live, hints: BoardHints | null): boolean =>
  hints?.design?.command !== undefined && live.command?.name === hints.design.command

/**
 * A view still needs design work when it has no approval, or when the proposal asks for
 * a design (or an update) and the last approval or update predates the change.
 */
export const isViewOpen = (view: DesignView, createdAt: string | undefined): boolean => {
  if (view.approvedAt === undefined) {
    return true
  }
  if (!view.isNeedsDesign) {
    return false
  }
  const latest = [view.approvedAt, view.updatedAt ?? ''].sort().at(-1) ?? ''

  return createdAt === undefined || latest < createdAt
}

/**
 * The view that this session designs now: the design command is its last workflow command,
 * and this view is the view of that command. Its review is not over, approved or not,
 * until the next step starts.
 */
export const isViewInReview = (view: DesignView, live: Live, hints: BoardHints | null): boolean => {
  const run = live.designRuns.at(-1)

  return isDesigning(live, hints) && run !== undefined && run.view === view.view && run.at >= (live.command?.at ?? 0)
}

/**
 * The session explores while `/opsx:explore` is its last workflow command, with no time
 * limit: explore is a stance that lasts until the next command, not one step.
 */
export const isExploring = (live: Live): boolean => live.command?.name === 'opsx:explore'

/** The explore runs of one change, or the runs before any change when `change` is undefined. */
export const exploreRunsOf = (live: Live, change: string | undefined) => (live.exploreRuns ?? []).filter(run => run.change === change)

/** The verdict that blocks the change, if one does. */
export const blockingVerdict = (snap: Snapshot | null) => snap?.verdicts?.find(verdict => verdict.level === 'block')

/** The findings of a review report by kind, as a note. */
export const findingsNote = (counts: Record<string, number>): string => {
  const parts = Object.entries(counts).map(([kind, count]) => `${count} ${kind}`)

  return parts.length === 0 ? 'no findings' : parts.join(', ')
}

/** The evidence of a change and a session, as the stages read it. */
export const stageContext = (
  snap: Snapshot | null,
  live: Live,
  agents: readonly AgentRun[],
  now: number,
  seenPhases: readonly string[],
  hints: BoardHints | null,
): StageContext => {
  const commandPhase = live.command === undefined ? undefined : phaseOfCommand(live.command.name, hints)

  return {
    snap,
    live,
    agents,
    now,
    seenPhases,
    hints,
    change: snap === null || snap.change === '' ? undefined : snap.change,
    isArchived: snap?.archivedAs !== undefined,
    recentCommand: live.command !== undefined && now - live.command.at < RECENT_MS ? live.command.name : undefined,
    commandPhase,
    // The work of a stage runs now: the main turn of its command, or an agent of its phase.
    isAgentRunning: (...phases: Phase[]) => agents.some(agent => phases.includes(agent.phase) && isRunning(agent)),
    isCommandRunning: (phase: Phase) => isCommandTurn(live) && commandPhase === phase && isCommandFor(live, snap?.change),
    isTurnRunning: isTurnRunning(live),
  }
}
