// Pure: what stage a change is in, what runs, and what comes next. No `$` here.
// OpenSpec gives Explore, Propose (the schema's artifacts), Apply, Verify, and Archive. The
// board.yaml hints add the stages outside OpenSpec (Plan, Design) and the project's names.
import type { AgentRun, BoardHints, DesignView, Live, Phase, Report, Snapshot, TaskGroup } from '../types'
import { agentTokens } from './ledger'
import { changeFromArgs, countDone, formatTokens, phaseOfCommand } from './parse'

export type StageKey = 'plan' | 'explore' | 'design' | 'propose' | 'apply' | 'verify' | 'pr' | 'archive'
export type StageState = 'done' | 'active' | 'pending' | 'blocked' | 'na'
/** `isInReview`: the work of the stage is written, but the next step has not started. */
export type Stage = { key: StageKey; label: string; state: StageState; note?: string; isOptional: boolean; isInReview?: boolean }

export type GroupState = 'done' | 'running' | 'paused' | 'partial' | 'pending'
export type GroupView = {
  group: TaskGroup
  done: number
  total: number
  state: GroupState
  agents: AgentRun[]
  runningTask?: string
  commit?: string
}

const RECENT_MS = 30 * 60 * 1000

export const isRunning = (agent: AgentRun): boolean => agent.status === 'running'

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

/** The session designs while the design command of the hints is its last workflow command, as it explores with `/opsx:explore`. */
export const isDesigning = (live: Live, hints: BoardHints | null): boolean =>
  hints?.design?.command !== undefined && live.command?.name === hints.design.command

/** The verdict that blocks the change, if one does. */
export const blockingVerdict = (snap: Snapshot | null) => snap?.verdicts?.find(verdict => verdict.level === 'block')

/** The last workflow command was for this change: the change it bound, else the change its argument names, else any. */
const isCommandFor = (live: Live, change: string | undefined): boolean => {
  const named = live.command?.change ?? (live.command === undefined ? undefined : changeFromArgs(live.command.args))

  return named === undefined || named === change
}

/** The change has apply work: a checked task, or a commit of the apply run. */
const hasApplyWork = (snap: Snapshot): boolean =>
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

const designStage = (designs: readonly DesignView[], live: Live, createdAt: string | undefined, hints: BoardHints | null): Stage => {
  const base = { key: 'design' as const, label: hints?.design?.label ?? 'Design', isOptional: true }
  if (designs.length === 0) {
    return { ...base, state: 'na' }
  }
  const open = designs.filter(view => isViewOpen(view, createdAt) || isViewInReview(view, live, hints))
  if (open.length === 0) {
    return { ...base, state: 'done', note: `${designs.length} approved` }
  }
  const inSession = open.some(view => view.isInSession || live.designRuns.some(run => run.view === view.view))
  if (inSession) {
    const names = open.map(view => (isViewOpen(view, createdAt) ? view.view : `${view.view} in review`))

    return { ...base, state: 'active', note: names.join(', ') }
  }
  const blocking = open.filter(view => view.isNeedsDesign)

  return blocking.length > 0
    ? { ...base, state: 'blocked', note: `needs-design: ${blocking.map(view => view.view).join(', ')}` }
    : { ...base, state: 'pending' }
}

/**
 * The session explores while `/opsx:explore` is its last workflow command, with no time
 * limit: explore is a stance that lasts until the next command, not one step.
 */
export const isExploring = (live: Live): boolean => live.command?.name === 'opsx:explore'

/**
 * Explore is optional. It is active while the session explores, and done when this session
 * explored earlier, or when a ledger of the change holds tokens spent in the explore phase.
 */
/** The explore runs of one change, or the runs before any change when `change` is undefined. */
export const exploreRunsOf = (live: Live, change: string | undefined) =>
  (live.exploreRuns ?? []).filter(run => run.change === change)

const exploreStage = (live: Live, change: string | undefined, seenPhases: readonly string[]): Stage => {
  const runs = exploreRunsOf(live, change)
  const base = { key: 'explore' as const, label: 'Explore', isOptional: true, note: runs.at(-1)?.topic || undefined }
  if (isExploring(live) && live.exploreRuns?.at(-1)?.change === change) {
    return { ...base, state: 'active' }
  }

  return { ...base, state: runs.length > 0 || seenPhases.includes('explore') ? 'done' : 'na' }
}

/**
 * The stages of a change, in workflow order. `seenPhases` names the phases that hold tokens
 * in the ledgers of the change, this session's and the others'. Only Explore reads it:
 * Propose ends on direct signs of Apply, because older ledgers hold review tokens under `apply`.
 * Plan and Design are stages only when the hints define them.
 */
export const stagesOf = (
  snap: Snapshot | null,
  live: Live,
  agents: readonly AgentRun[],
  now: number,
  seenPhases: readonly string[] = [],
  hints: BoardHints | null = null,
): Stage[] => {
  const recentCommand = live.command !== undefined && now - live.command.at < RECENT_MS ? live.command.name : undefined
  const isProposeCommand = recentCommand !== undefined && phaseOfCommand(recentCommand, hints) === 'propose'
  const planAgent = hints?.plan?.agent
  const pmRunning = planAgent !== undefined && agents.some(agent => agent.type === planAgent && isRunning(agent))
  const reviewAgent = hints?.reviewAgent
  const reviewRunning = reviewAgent !== undefined && agents.some(agent => agent.type === reviewAgent && isRunning(agent))
  const designs = snap?.designs ?? []
  const groups = snap?.groups ?? []
  const total = groups.reduce((sum, group) => sum + group.tasks.length, 0)
  const done = groups.reduce((sum, group) => sum + countDone(group), 0)
  const isArchived = snap?.archivedAs !== undefined
  const commits = snap?.commits ?? []
  // Propose ends when Apply starts. Until then, the person reviews the artifacts and they can still change.
  // A pull request of the branch is no sign: the branch can hold one before the change applies.
  const commandPhase = live.command === undefined ? undefined : phaseOfCommand(live.command.name, hints)
  const isApplyStarted =
    isArchived ||
    (snap !== null && hasApplyWork(snap)) ||
    ((commandPhase === 'apply' || commandPhase === 'verify' || commandPhase === 'archive') &&
      isCommandFor(live, snap?.change) &&
      !isApplyRefused(live, snap))

  const plan: Stage | undefined =
    hints?.plan === undefined
      ? undefined
      : {
          key: 'plan',
          label: hints.plan.label,
          isOptional: true,
          state: pmRunning ? 'active' : snap !== null && (snap.planning.length > 0 || snap.planningNone !== undefined) ? 'done' : 'na',
          note: snap?.planning.map(item => item.id).join(', ') || snap?.planningNone,
        }

  const proposeState: StageState =
    snap === null
      ? 'pending'
      : isArchived || (snap.isPlanningComplete && isApplyStarted)
        ? 'done'
        : blockingVerdict(snap) !== undefined
          ? 'blocked'
          : snap.exists || isProposeCommand
            ? 'active'
            : 'pending'
  const verdictNote = snap?.verdicts?.map(verdict => verdict.value).join(', ')
  const propose: Stage = {
    key: 'propose',
    label: 'Propose',
    isOptional: false,
    state: proposeState,
    note: verdictNote === '' ? undefined : verdictNote,
    isInReview: proposeState === 'active' && snap?.isPlanningComplete === true,
  }

  const applyRunning =
    isApplyRun(live, snap) ||
    agents.some(agent => agent.phase === 'apply' && isRunning(agent)) ||
    commits.some(commit => commit.kind === 'artifacts' || commit.kind === 'task')
  const apply: Stage = {
    key: 'apply',
    label: 'Apply',
    isOptional: false,
    state:
      snap === null || (!snap.isPlanningComplete && !isArchived)
        ? 'pending'
        : total > 0 && done === total
          ? 'done'
          : isArchived
            ? 'done'
            : done > 0 || applyRunning
              ? 'active'
              : 'pending',
    note: total > 0 ? `${done}/${total}` : undefined,
  }

  // Verify: `/opsx:verify`, or the review agent of the hints, under the label of the hints.
  const hasPr = snap?.pr !== undefined
  const verify: Stage = {
    key: 'verify',
    label: hints?.verifyLabel ?? 'Verify',
    isOptional: false,
    state:
      reviewRunning || (recentCommand === 'opsx:verify' && live.verifyVerdict === undefined && isCommandFor(live, snap?.change))
        ? 'active'
        : isArchived ||
            hasPr ||
            live.reviewCounts !== undefined ||
            live.verifyVerdict !== undefined ||
            commits.some(commit => commit.kind === 'review-fix')
          ? 'done'
          : 'pending',
    note: live.reviewCounts !== undefined ? findingsNote(live.reviewCounts) : live.verifyVerdict,
  }

  // Without gh the board cannot see a pull request, so it shows no PR stage.
  const pr: Stage | undefined =
    snap?.isGhMissing === true && !hasPr
      ? undefined
      : {
          key: 'pr',
          label: 'PR',
          isOptional: false,
          state: hasPr || isArchived ? 'done' : 'pending',
          note: snap?.pr === undefined ? undefined : `#${snap.pr.number} ${snap.pr.state.toLowerCase()}`,
        }

  const archive: Stage = {
    key: 'archive',
    label: 'Archive',
    isOptional: false,
    state: isArchived ? 'done' : recentCommand === 'opsx:archive' ? 'active' : 'pending',
    note: snap?.archivedAs?.slice(0, 10),
  }

  // Design mode keeps an empty change name in its snapshot: no change is bound.
  const change = snap === null || snap.change === '' ? undefined : snap.change

  const explore = exploreStage(live, change, seenPhases)
  const design = hints?.design === undefined ? undefined : designStage(designs, live, snap?.createdAt, hints)
  const before = hints?.plan?.isBeforeExplore === true ? [plan, explore] : [explore, plan]

  return [...before, design, propose, apply, verify, pr, archive].filter((stage): stage is Stage => stage !== undefined)
}

export const findingsNote = (counts: Record<string, number>): string => {
  const parts = Object.entries(counts).map(([kind, count]) => `${count} ${kind}`)

  return parts.length === 0 ? 'no findings' : parts.join(', ')
}

/**
 * The stage the work is at: the furthest active one (an optional stage left blocked
 * behind it does not hold the work back), else the first blocked, else the first pending.
 */
export const currentStage = (stages: readonly Stage[]): Stage | undefined =>
  [...stages].reverse().find(stage => stage.state === 'active') ??
  stages.find(stage => stage.state === 'blocked') ??
  stages.find(stage => stage.state === 'pending')

export const phaseOfStage = (stage: Stage | undefined): Phase => {
  switch (stage?.key) {
    case 'plan':
    case 'explore':
    case 'design':
    case 'propose':
    case 'apply':
    case 'archive':
      return stage.key
    // The ledgers keep the tokens of the review and the pull request under `review`.
    case 'verify':
    case 'pr':
      return 'review'
    default:
      return 'other'
  }
}

export const groupViews = (
  snap: Snapshot | null,
  agents: readonly AgentRun[],
  reports: readonly Report[],
  live: Live,
  hints: BoardHints | null = null,
): GroupView[] => {
  const isDesignRevising = live.designRuns.some(run => run.mode === 'update') && isDesigning(live, hints)

  return (snap?.groups ?? []).map(group => {
    const done = countDone(group)
    const total = group.tasks.length
    const own = agents.filter(agent => agent.group === group.num && agent.change === snap?.change)
    const isLive = own.some(isRunning)
    const latest = [...reports].reverse().find(report => report.group === group.num)
    const runningTask = latest?.state === 'start' ? latest.task : undefined
    const state: GroupState =
      total > 0 && done === total
        ? 'done'
        : isLive || runningTask !== undefined
          ? isDesignRevising
            ? 'paused'
            : 'running'
          : done > 0 || group.tasks.some(task => task.mark === '~')
            ? 'partial'
            : 'pending'
    const commit = snap?.commits.find(c => c.kind === 'task' && c.group === group.num)?.hash

    return { group, done, total, state, agents: own, runningTask, commit }
  })
}

export type NextStep = { text: string; why: string }

/** The command that designs a view, from the hints: the update form when the view has its artifact. */
const designCommand = (hints: BoardHints | null, view: DesignView | undefined): string | undefined => {
  const design = hints?.design
  if (design === undefined) {
    return undefined
  }
  const template = view?.hasArtifact === true ? (design.nextUpdate ?? design.nextNew) : design.nextNew
  if (template !== undefined) {
    return view === undefined ? template.replace(/\{id\}.*$/, '') : template.replace(/\{id\}/g, view.view)
  }

  return design.command === undefined ? undefined : `/${design.command} ${view?.view ?? ''}`
}

export const nextStep = (snap: Snapshot | null, stages: readonly Stage[], live: Live, hints: BoardHints | null = null): NextStep | undefined => {
  const byKey = (key: StageKey) => stages.find(stage => stage.key === key)
  const design = byKey('design')
  // No change yet: design mode keeps an empty change name in its snapshot.
  if (snap === null || snap.change === '') {
    const designs = snap?.designs ?? []
    const isApproved = live.designRuns.length > 0 && designs.length > 0 && designs.every(view => view.approvedAt !== undefined)
    if (isApproved) {
      return { text: '/opsx:propose ', why: 'the design is approved' }
    }
    if (byKey('explore')?.state === 'active') {
      const command = hints?.design?.command
      const first = command === undefined ? '' : `. Work with a design runs /${command} <name> first`

      return { text: '/opsx:propose ', why: `when the exploration settles, it becomes a change${first}` }
    }

    return undefined
  }
  const change = snap.change
  if (snap.archivedAs !== undefined) {
    return undefined
  }
  const openView = snap.designs.find(item => item.isNeedsDesign && isViewOpen(item, snap.createdAt))
  const isPlanned = snap.isPlanningComplete
  const pending = design?.state === 'blocked' && openView !== undefined ? `; design ${openView.view} still needs an update` : ''
  // A blocked design comes before the remaining artifacts; once planned, it only has to land before its tasks.
  const designNext = designCommand(hints, openView)
  if (design?.state === 'blocked' && !isPlanned && designNext !== undefined) {
    return { text: designNext, why: 'the proposal needs an approved design first' }
  }
  if (!snap.exists) {
    return { text: `/opsx:propose ${change}`, why: 'no change folder yet' }
  }
  const blocking = blockingVerdict(snap)
  if (byKey('propose')?.state === 'blocked' && blocking !== undefined) {
    return {
      text: (blocking.next ?? '/opsx:continue {change}').replace(/\{change\}/g, change),
      why: `the ${blocking.artifact} verdict is ${blocking.value}. Revise the artifacts`,
    }
  }
  if (!isPlanned) {
    const ready = snap.artifacts.filter(artifact => artifact.status === 'ready').map(artifact => artifact.id)

    return { text: `/opsx:continue ${change}`, why: ready.length === 0 ? 'planning artifacts remain' : `next: ${ready.join(', ')}` }
  }
  if (isApplyRefused(live, snap)) {
    return { text: `/opsx:apply ${change}`, why: `openspec validate --strict refused the change. Fix the artifacts, then apply again${pending}` }
  }
  if (byKey('propose')?.state === 'active') {
    return { text: `/opsx:apply ${change}`, why: `all artifacts are written. Apply when their review is over${pending}` }
  }
  // A task left `[~]` or `[-]` does not hold the change back: the repository keeps owner steps open.
  const tasks = snap.groups.flatMap(group => group.tasks)
  const isTasksSettled = tasks.length > 0 && tasks.every(task => task.mark !== ' ')
  // Without a PR stage (no gh), the change goes from its tasks to verify, then to the archive.
  const prStage = byKey('pr')
  if (!isTasksSettled || (prStage !== undefined && prStage.state !== 'done')) {
    // The apply run of this session goes on to the pull request: it needs no hint.
    if (isApplyRun(live, snap)) {
      return undefined
    }
    const isStopped = live.command?.name === 'opsx:apply' && (live.stoppedAt ?? 0) >= live.command.at
    const why = isStopped ? 'the apply run stopped. Apply again to go on' : prStage === undefined ? 'tasks remain' : 'tasks, review, or the pull request remain'

    return { text: `/opsx:apply ${change}`, why: `${why}${pending}` }
  }
  if (prStage === undefined && byKey('verify')?.state !== 'done') {
    return { text: `/opsx:verify ${change}`, why: `the tasks are done. Verify the change before the archive${pending}` }
  }
  const partial = tasks.filter(task => task.mark === '~').length
  const ready = prStage === undefined ? 'the change is verified' : 'the pull request is open'

  return {
    text: `/opsx:archive ${change}`,
    why: partial === 0 ? ready : `${ready}; ${partial} ${partial === 1 ? 'task stays' : 'tasks stay'} [~]`,
  }
}

/** The label of a stage with its short state: the task count of Apply, or "in review". */
export const stageText = (stage: Stage): string =>
  stage.key === 'apply' && stage.note !== undefined ? `${stage.label} ${stage.note}` : stage.isInReview ? `${stage.label} in review` : stage.label

export const statusLine = (snap: Snapshot | null, stages: readonly Stage[], views: readonly GroupView[], live: Live): string | undefined => {
  if (snap === null) {
    const design = live.designRuns.at(-1)
    const explore = exploreRunsOf(live, undefined).at(-1)
    if (explore !== undefined && (design === undefined || explore.at >= design.at)) {
      const topic = explore.topic.length > 48 ? `${explore.topic.slice(0, 47)}…` : explore.topic

      return `opsx explore${topic === '' ? '' : ` ${topic}`}`
    }

    return design === undefined ? undefined : `opsx design ${design.view}`
  }
  const stage = currentStage(stages)
  const running = views.find(view => view.state === 'running')
  const parts = [`opsx ${snap.change}`]
  if (snap.archivedAs !== undefined) {
    parts.push('archived')
  } else if (stage !== undefined) {
    parts.push(stageText(stage))
  }
  if (running !== undefined) {
    const tokens = running.agents.reduce((sum, agent) => sum + agentTokens(agent), 0)
    parts.push(`G${running.group.num} ▶ ${formatTokens(tokens)}`)
  }

  return parts.join(' · ')
}
