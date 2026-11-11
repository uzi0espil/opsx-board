// The Apply stage: `/opsx:apply` works through the tasks of the change, group by group, often
// with an agent per group. Its section lists the task groups, their agents, and their commits.
import type { AgentRun, BoardHints, Live, Report, Snapshot } from '../../types'
import { prWords } from '../hosts'
import { agentTokens } from '../ledger'
import { countDone, formatDuration, formatTokens } from '../parse'
import { GROUP_COLOR, GROUP_GLYPH, INDENT, MARK_COLOR, TASK_GLYPH, TREE_INDENT, branch, clip, elapsed, fit, hoverCard, wrapWords } from '../ui'
import type { GroupState, GroupView, NextStep, PaneContext, Stage, StageContext, StageKind } from './base'
import { stageOf } from './base'
import { designPending } from './design'
import { hasApplyWork, isApplyRefused, isApplyRun, isCommandFor, isDesigning, isRunning, isTasksSettled } from './evidence'

/**
 * Apply has started: the change is archived, it has apply work, or the last workflow command
 * for it is of Apply or a later stage, and the strict validation did not refuse it.
 */
export const isApplyStarted = (ctx: StageContext): boolean => {
  const { snap, live, commandPhase } = ctx

  return (
    ctx.isArchived ||
    (snap !== null && hasApplyWork(snap)) ||
    ((commandPhase === 'apply' || commandPhase === 'verify' || commandPhase === 'archive') && isCommandFor(live, snap?.change) && !isApplyRefused(live, snap))
  )
}

/** The task groups of a change as the Apply section shows them. */
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

const barCells = (done: number, total: number, width: number): [number, number] => {
  const cells = Math.max(4, width)
  const filled = total === 0 ? 0 : Math.round((done / total) * cells)

  return [filled, cells - filled]
}

export const applyStage: StageKind = {
  key: 'apply',

  /**
   * Done when every task is; active once a task is done or the run works. The apply run goes on to
   * the pull request, and is over once the tasks are settled and the pull request is open.
   * Without a pull request to read (no gh or glab, or a repository on neither GitHub nor GitLab)
   * there is no PR stage: the tasks alone decide.
   */
  evaluate(ctx: StageContext): Stage {
    const { snap, live, agents, isArchived } = ctx
    const groups = snap?.groups ?? []
    const total = groups.reduce((sum, group) => sum + group.tasks.length, 0)
    const done = groups.reduce((sum, group) => sum + countDone(group), 0)
    const commits = snap?.commits ?? []
    const hasPr = snap?.pr !== undefined
    const isPrRead = snap?.prHost !== 'none'
    const isApplyOpen = !isTasksSettled(groups) || (isPrRead && !hasPr && !isArchived)
    const applyRunning =
      isApplyRun(live, snap) ||
      agents.some(agent => agent.phase === 'apply' && isRunning(agent)) ||
      commits.some(commit => commit.kind === 'artifacts' || commit.kind === 'task')

    return {
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
      isRunning:
        snap?.isPlanningComplete === true &&
        ((isApplyRun(live, snap) && isApplyOpen) || ctx.isCommandRunning('apply') || ctx.isAgentRunning('apply')),
    }
  },

  /** Apply once the artifacts are written, again after a refusal or a stop, and while tasks or the pull request remain. */
  next(ctx: StageContext, stages: readonly Stage[]): NextStep | undefined {
    const { snap, live, change } = ctx
    if (snap === null || change === undefined) {
      return undefined
    }
    const pending = designPending(ctx, stages)
    if (isApplyRefused(live, snap)) {
      return { text: `/opsx:apply ${change}`, why: `openspec validate --strict refused the change. Fix the artifacts, then apply again${pending}` }
    }
    if (stageOf(stages, 'propose')?.state === 'active') {
      return { text: `/opsx:apply ${change}`, why: `all artifacts are written. Apply when their review is over${pending}` }
    }
    const prStage = stageOf(stages, 'pr')
    if (!isTasksSettled(snap.groups) || (prStage !== undefined && prStage.state !== 'done')) {
      const isStopped = live.command?.name === 'opsx:apply' && (live.stoppedAt ?? 0) >= live.command.at
      const { name } = prWords(snap.prHost)
      const why = isStopped ? 'the apply run stopped. Apply again to go on' : prStage === undefined ? 'tasks remain' : `tasks, review, or the ${name} remain`

      return { text: `/opsx:apply ${change}`, why: `${why}${pending}` }
    }

    return undefined
  },

  /** A row per task group, which folds its tasks; its agent cell opens the agent's session. */
  section(pane: PaneContext, stage: Stage | undefined) {
    const { views, expanded, actions } = pane
    if (views.length === 0) {
      return null
    }
    const { Box, Text, Button, body, section } = pane.kit
    const now = pane.ctx.now
    const doneTasks = views.reduce((sum, view) => sum + view.done, 0)
    const allTasks = views.reduce((sum, view) => sum + view.total, 0)
    const isApplyCurrent = pane.current?.key === 'apply' || pane.current?.key === 'verify'
    const isGroupExpanded = (view: GroupView): boolean => expanded[view.group.num] ?? (view.state === 'running' || view.state === 'paused')
    // A group row folds or unfolds its tasks, and nothing else.
    const toggleGroup = (view: GroupView) => () => actions.setExpanded(view.group.num, !isGroupExpanded(view))
    const [filled, empty] = barCells(doneTasks, allTasks, Math.min(20, Math.max(6, body - 40)))
    const applyNote =
      allTasks === 0 ? null : (
        <Text>
          <Text dimColor>{`${doneTasks}/${allTasks} `}</Text>
          <Text color="success">{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(empty)}</Text>
        </Text>
      )
    const right = Math.min(32, Math.max(14, Math.floor(body * 0.34)))
    const titleWidth = Math.max(8, body - 16 - right)

    return section('apply', 'Apply', stage?.state, stage?.state !== 'done' || isApplyCurrent, applyNote, () =>
      views.flatMap(view => {
        const latest = view.agents.at(-1)
        const tokens = view.agents.reduce((sum, agent) => sum + agentTokens(agent), 0)
        const isLive = latest !== undefined && isRunning(latest)
        const who =
          latest === undefined
            ? (view.commit ?? '')
            : `${clip(latest.type, 16)} ${formatTokens(tokens)}${
                isLive ? ` ${formatDuration(elapsed(latest, now))}` : view.commit === undefined ? '' : ` ${view.commit}`
              }`
        const head = [
          <Text color={GROUP_COLOR[view.state]}>{`${GROUP_GLYPH[view.state]} `}</Text>,
          <Text mono dimColor>{` ${view.group.num.padStart(2)} `}</Text>,
          <Text mono bold={view.state === 'running'} dimColor={view.state === 'done'}>
            {` ${fit(view.group.title, titleWidth)} `}
          </Text>,
          <Text mono color={view.state === 'done' ? 'success' : undefined} dimColor={view.state !== 'done'}>
            {`${view.done}/${view.total}`.padStart(6)}
          </Text>,
        ]
        const cell = (
          <Text mono color={isLive ? 'warning' : undefined} dimColor={!isLive}>
            {clip(who, right)}
          </Text>
        )
        // The row folds its tasks; the agent cell, a press target of its own, opens the agent.
        // With no agent, the cell holds the commit and is part of the row.
        const row =
          latest === undefined ? (
            <Button key={`group:${view.group.num}`} plain onPress={toggleGroup(view)}>
              {head}
              {'  '}
              {cell}
            </Button>
          ) : (
            <Box flexDirection="row" gap={2}>
              <Button key={`group:${view.group.num}`} plain onPress={toggleGroup(view)}>
                {head}
              </Button>
              <Button key={`group-agent:${view.group.num}`} plain onPress={actions.openAgent(latest)}>
                {cell}
              </Button>
            </Box>
          )
        if (!isGroupExpanded(view)) {
          return [row]
        }
        const count = view.group.tasks.length
        const rowWidth = body - (TREE_INDENT - INDENT)

        return [
          row,
          <Box flexDirection="column" paddingLeft={TREE_INDENT - INDENT} marginBottom={1}>
            {view.group.tasks.map((task, index) => {
              const isActive = view.runningTask === task.id && task.mark !== 'x'
              const glyph = isActive ? '▶' : (TASK_GLYPH[task.mark] ?? '○')
              const reporter = isActive ? `  ← ${latest?.type ?? 'agent'}` : ''
              // branch (2) + glyph and its gap (3) + " id " — where the task text starts.
              const lead = 5 + task.id.length + 2
              const textWidth = Math.max(10, rowWidth - lead - reporter.length)
              const isClipped = task.text.length > textWidth
              const flag = `task:${task.id}`
              const isTaskOpen = isClipped && expanded[flag] === true
              // An unfolded task wraps in place, its first line on the row, the rest under it.
              const wrapped = isTaskOpen ? wrapWords(task.text, textWidth) : [clip(task.text, textWidth)]

              const hasCard = isClipped && !isTaskOpen
              const scope = `opsx-task-${task.id}`

              return (
                // No key: this Box is no hover scope, so a pointer over the card (on this Box)
                // lights no task and the card hides, letting the row beneath take the hover.
                <Box flexDirection="column">
                  <Button
                    key={flag}
                    plain
                    hover={hasCard ? { scope } : undefined}
                    onPress={() => (isClipped ? void actions.setExpanded(flag, !isTaskOpen) : undefined)}
                  >
                    <Text dimColor>{branch(index, count)}</Text>
                    <Text color={isActive ? 'warning' : MARK_COLOR[task.mark]}>{`${glyph} `}</Text>
                    <Text dimColor>{` ${task.id} `}</Text>
                    <Text bold={isActive} dimColor={task.mark === 'x'}>
                      {wrapped[0] ?? ''}
                    </Text>
                    {reporter === '' ? '' : <Text color="warning">{reporter}</Text>}
                  </Button>
                  {wrapped.slice(1).map(line => (
                    <Box paddingLeft={lead}>
                      <Text bold={isActive} dimColor={task.mark === 'x'}>
                        {line}
                      </Text>
                    </Box>
                  ))}
                  {/* Hovering a clipped, folded task floats its whole text over the rows above it. */}
                  {hasCard ? hoverCard(Box, Text, task.text, Math.max(20, rowWidth - lead - 2), lead, scope) : null}
                </Box>
              )
            })}
          </Box>,
        ]
      }),
    )
  },
}
