// The board pane: the stage rail, then one section per stage, the agents, and the next
// step. Every row acts on a click: an artifact opens in the reader view of the same pane, a
// design and the pull request in the browser. A task group row folds its tasks, and its
// agent cell opens the agent's session. register.tsx reads the session values (so the
// drawing subscribes to them) and hands them here with the actions that write them.
import type { EngineInterface, RenderChildren, RenderInput } from 'claude-code'

import type {
  AgentRun,
  ArtifactRow,
  Binding,
  BoardHints,
  DesignView,
  Flags,
  Live,
  MainUsage,
  Others,
  PlanningItem,
  ReaderDoc,
  Report,
  SessionFigures,
  Snapshot,
  Usage,
  Verdict,
} from '../types'
import { PRE_CHANGE, addUsage, agentTokens, sessionUsage, tokensOf, zeroUsage } from './ledger'
import type { GroupView, Stage, StageState } from './model'
import { currentStage, exploreRunsOf, groupViews, isExploring, isRunning, isViewInReview, isViewOpen, nextStep, stageText, stagesOf } from './model'
import { formatDuration, formatTokens, reflowTables } from './parse'

type Engine = EngineInterface

export const PANE = 'opsx-board'

export type PaneData = {
  binding: Binding
  snap: Snapshot | null
  live: Live
  agents: AgentRun[]
  main: MainUsage
  reports: Report[]
  others: Others
  figures: SessionFigures
  folded: Flags
  expanded: Flags
  hints: BoardHints | null
  now: number
}

export type PaneActions = {
  setFolded: (key: string, isFolded: boolean) => Promise<void>
  setExpanded: (key: string, isExpanded: boolean) => Promise<void>
  pick: (change: string) => Promise<void>
  /** Shows a file or a text in the reader view of the pane. */
  read: (doc: ReaderDoc) => Promise<void>
  /** Shows a planning item's block from its authoritative file in the reader view. */
  readPlanning: (item: PlanningItem) => Promise<void>
  /** Opens a URL in the browser, or a file in its default app. */
  openExternal: (target: string, what: string) => Promise<void>
}

export type ReaderActions = {
  /** Shows the board again, at the row that opened the document. */
  back: () => Promise<void>
  openExternal: (target: string, what: string) => Promise<void>
}

const STAGE_GLYPH: Record<StageState, string> = { done: '✔', active: '▶', pending: '○', blocked: '✖', na: '–' }
const STAGE_COLOR: Record<StageState, string | undefined> = {
  done: 'success',
  active: 'warning',
  pending: undefined,
  blocked: 'error',
  na: undefined,
}
const GROUP_GLYPH: Record<GroupView['state'], string> = { done: '✔', running: '▶', paused: '‖', partial: '◐', pending: '○' }
const GROUP_COLOR: Record<GroupView['state'], string | undefined> = {
  done: 'success',
  running: 'warning',
  paused: 'warning',
  partial: 'suggestion',
  pending: undefined,
}
const TASK_GLYPH: Record<string, string> = { x: '✔', '~': '◐', '-': '✕', '!': '✖', ' ': '○' }
const VERDICT_COLOR: Record<Verdict['level'], string> = { ok: 'success', warn: 'warning', block: 'error' }
const MARK_COLOR: Record<string, string | undefined> = { x: 'success', '~': 'warning', '!': 'error' }


// Layout, in character cells: section bodies sit under their header, and the tasks and
// spec files under their row, each with a tree connector.
const INDENT = 2
const TREE_INDENT = 5
// The right-hand notes and the row columns end this far from the pane edge, under the end of the stage chip.
const RIGHT_INSET = 2

const clip = (text: string, width: number): string =>
  width <= 1 ? text.slice(0, Math.max(0, width)) : text.length <= width ? text : `${text.slice(0, width - 1)}…`

const fit = (text: string, width: number): string => clip(text, width).padEnd(Math.max(0, width))

const barCells = (done: number, total: number, width: number): [number, number] => {
  const cells = Math.max(4, width)
  const filled = total === 0 ? 0 : Math.round((done / total) * cells)

  return [filled, cells - filled]
}

const agentLabel = (agent: AgentRun): string => (agent.group !== undefined ? `${agent.type} · G${agent.group}` : agent.type)

const elapsed = (agent: AgentRun, now: number): number =>
  agent.durationMs ?? (agent.status === 'running' ? now - agent.startedAt : (agent.endedAt ?? now) - agent.startedAt)

const artifactState = (artifact: ArtifactRow): StageState =>
  artifact.status === 'done' ? 'done' : artifact.status === 'ready' ? 'active' : artifact.status === 'skipped' ? 'na' : 'pending'

const designStep = (view: DesignView, isOpen: boolean, isInReview: boolean): string =>
  !isOpen
    ? `approved ${view.approvedAt ?? ''}${isInReview ? ' · in review' : ''}`
    : view.approvedAt !== undefined
      ? `needs an update (approved ${view.approvedAt}${view.updatedAt === undefined ? '' : `, updated ${view.updatedAt}`})`
      : view.isNeedsDesign && !view.hasArtifact
        ? 'needs-design'
        : view.screenshots > 0
          ? 'iterating'
          : view.hasArtifact
            ? 'drafting'
            : 'not started'

const branch = (index: number, count: number): string => (index === count - 1 ? '└ ' : '├ ')

/** Word-wraps `text` to `width` cells; a word longer than a line is cut across lines. */
export const wrapWords = (text: string, width: number): string[] => {
  const size = Math.max(1, width)
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word
    while (rest.length > size) {
      if (line !== '') {
        out.push(line)
        line = ''
      }
      out.push(rest.slice(0, size))
      rest = rest.slice(size)
    }
    if (line === '') {
      line = rest
    } else if (line.length + 1 + rest.length <= size) {
      line = `${line} ${rest}`
    } else {
      out.push(line)
      line = rest
    }
  }
  if (line !== '') {
    out.push(line)
  }

  return out
}

type Elements = ReturnType<Engine['ui']['resolve']>

/**
 * C: a card that appears while its task row is hovered (the row and the card share a hover
 * `scope`). A floating Box paints over what comes before it and under what comes after, so
 * the card sits just above its row, over the earlier rows, and never over its own row. Each
 * line is padded to the card's width, so the card's spaces hide the text beneath it.
 */
const hoverCard = (Box: Elements['Box'], Text: Elements['Text'], text: string, width: number, left: number, scope: string) => {
  const inner = Math.max(10, width - 4)
  const lines = wrapWords(text, inner).map(line => ` ${line.padEnd(inner)} `)

  return (
    <Box
      position="absolute"
      top={-(lines.length + 2)}
      left={left}
      width={inner + 4}
      display="none"
      hover={{ scope, display: 'flex' }}
      flexDirection="column"
      borderStyle="round"
      borderColor="suggestion"
    >
      <Text>{lines.join('\n')}</Text>
    </Box>
  )
}

/**
 * `← Main session` (hotkey `m`), while the main view shows an agent's session: a press shows
 * the main session again. The engine draws the pane again for each switch of the view, by
 * this button, an agent cell, or Claude Code's own list of agents, so the button shows only
 * while an agent is in view. `$.ui.view` is the press's first call: the engine switches the
 * view only while the call answers the person's press.
 */
function mainSessionButton($: Engine, e: RenderInput<'Pane'>, Button: Elements['Button']) {
  if (e.props.view?.agentId === undefined) {
    return null
  }

  return (
    <Button
      key="main-session"
      hotkey="m"
      onPress={async () => {
        const viewed = await $.ui.view({})
        if (viewed.deny !== undefined) {
          $.ui.toast(`Cannot show the main session: ${viewed.deny}`)
        }
      }}
    >
      ← Main session
    </Button>
  )
}

export function renderPane($: Engine, e: RenderInput<'Pane'>, data: PaneData, actions: PaneActions) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const { binding, snap, live, agents, main, reports, others, figures, folded, expanded, hints, now } = data
  const width = Math.max(30, e.props.bodyColumns)
  const body = width - INDENT - RIGHT_INSET
  const change = binding.change
  const changeAgents = agents.filter(agent => agent.change === change)
  // Before a change is bound, the tokens of the session sit under `_pre`.
  const usageKey = change ?? PRE_CHANGE
  const seenPhases = [
    ...Object.entries(main[usageKey] ?? {})
      .filter(([, usage]) => tokensOf(usage) > 0)
      .map(([phase]) => phase),
    ...(others.phases ?? []),
  ]
  const stages = stagesOf(snap, live, changeAgents, now, seenPhases, hints)
  const views = groupViews(snap, changeAgents, reports, live, hints)
  const next = nextStep(snap, stages, live, hints)
  const current = currentStage(stages)

  const isOpen = (key: string, byDefault: boolean): boolean => (folded[key] === undefined ? byDefault : !folded[key])
  const toggle = (key: string, byDefault: boolean) => () => void actions.setFolded(key, isOpen(key, byDefault))
  const isGroupExpanded = (view: GroupView): boolean =>
    expanded[view.group.num] ?? (view.state === 'running' || view.state === 'paused')
  // A group row folds or unfolds its tasks, and nothing else.
  const toggleGroup = (view: GroupView) => () => actions.setExpanded(view.group.num, !isGroupExpanded(view))
  // An agent cell or row opens the agent's transcript. `$.ui.view` is the press's first call:
  // the engine switches the view only while the call answers the person's press.
  const openAgent = (agent: AgentRun) => async () => {
    const viewed = await $.ui.view({ agentId: agent.id })
    if (viewed.deny !== undefined) {
      $.ui.toast(`Cannot open the ${agent.type} session: ${viewed.deny}`)
    }
  }

  /** A section: its header (fold arrow, title in the stage's color, a note on the right), then its rows, indented. */
  const section = (
    key: string,
    title: string,
    state: StageState | undefined,
    byDefault: boolean,
    note: RenderChildren,
    rows: () => RenderChildren,
  ) => {
    const open = isOpen(key, byDefault)

    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={2} paddingRight={RIGHT_INSET}>
          <Button key={`fold:${key}`} plain onPress={toggle(key, byDefault)}>
            <Text dimColor>{open ? '▾  ' : '▸  '}</Text>
            <Text bold color={state === undefined ? undefined : STAGE_COLOR[state]}>
              {title}
            </Text>
          </Button>
          {note}
        </Box>
        {open ? (
          <Box flexDirection="column" paddingLeft={INDENT}>
            {rows()}
          </Box>
        ) : null}
      </Box>
    )
  }

  const noteText = (text: string | undefined) =>
    text === undefined || text === '' ? null : (
      <Text dimColor wrap="truncate-start">
        {text}
      </Text>
    )

  const nextCard =
    next === undefined ? null : (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
        <Button key="next" variant="primary" onPress={() => void $.prompt.fill({ text: next.text })}>
          {`Next: ${next.text.trim()}`}
        </Button>
        <Text dimColor wrap="truncate-end">{`fills the prompt · ${next.why}`}</Text>
      </Box>
    )

  // A design row opens artifact.html in the browser; its "decisions" button opens decisions.md in the reader.
  const designRow = (view: DesignView, createdAt: string | undefined) => {
    const isViewPending = isViewOpen(view, createdAt)
    // An approved view stays active while the session still designs it: the next step has not started.
    const isInReview = isViewInReview(view, live, hints)
    const state: StageState =
      !isViewPending && !isInReview ? 'done' : view.isInSession || isInReview ? 'active' : view.isNeedsDesign ? 'blocked' : 'pending'
    const parts = [
      designStep(view, isViewPending, isInReview),
      view.revisions > 0 ? `rev ${view.revisions}` : undefined,
      view.screenshots > 0 ? `${view.screenshots} shots` : undefined,
    ]
    const artifactPath = view.artifactPath
    const decisionsPath = view.decisionsPath
    const openDesign = () =>
      view.hasArtifact && artifactPath !== undefined
        ? void actions.openExternal(artifactPath, `the ${view.view} design`)
        : $.ui.toast(`${view.view} has no ${hints?.design?.open ?? 'design file'} yet`)
    const hasDecisions = decisionsPath !== undefined && (view.approvedAt !== undefined || view.revisions > 0)

    return (
      <Box flexDirection="row" gap={2}>
        <Button key={`design:${view.view}`} plain onPress={openDesign}>
          <Text color={STAGE_COLOR[state]}>{`${STAGE_GLYPH[state]} `}</Text>
          <Text bold>{` ${view.view}`}</Text>
          <Text dimColor>{`  ${clip(parts.filter(Boolean).join(' · '), Math.max(10, body - view.view.length - 16))}`}</Text>
        </Button>
        {hasDecisions ? (
          <Button
            key={`decisions:${view.view}`}
            plain
            dimColor
            onPress={() =>
              void actions.read({
                title: `${view.view} · ${decisionsPath?.split('/').at(-1) ?? 'decisions'}`,
                path: decisionsPath,
                from: `decisions:${view.view}`,
              })
            }
          >
            decisions
          </Button>
        ) : null}
      </Box>
    )
  }

  const rail = (
    <Box paddingX={1} marginTop={1}>
      <Text wrap="wrap">
        {stages.flatMap((stage, index) => [
          index === 0 ? '' : <Text dimColor>{' › '}</Text>,
          stage === current ? (
            <Text inverse bold color={STAGE_COLOR[stage.state]}>{` ${STAGE_GLYPH[stage.state]}  ${stage.label} `}</Text>
          ) : (
            <Text color={STAGE_COLOR[stage.state]} dimColor={stage.state === 'na' || stage.state === 'pending'}>
              {`${STAGE_GLYPH[stage.state]}  ${stage.label}`}
            </Text>
          ),
        ])}
      </Text>
    </Box>
  )

  // Explore: the topics this session explored for the bound change, and the tokens spent on them.
  const exploreRuns = exploreRunsOf(live, change)
  const explore = stages.find(stage => stage.key === 'explore')
  const exploreTokens =
    tokensOf(main[usageKey]?.['explore'] ?? zeroUsage()) +
    changeAgents.filter(agent => agent.phase === 'explore').reduce((sum, agent) => sum + agentTokens(agent), 0)
  const exploreSection =
    explore === undefined || explore.state === 'na'
      ? null
      : section(
          'explore',
          'Explore',
          explore.state,
          explore.state === 'active',
          noteText(exploreTokens > 0 ? `${formatTokens(exploreTokens)} tok` : undefined),
          () =>
            exploreRuns.length === 0 ? (
              <Text dimColor>explored in another session</Text>
            ) : (
              exploreRuns.slice(-5).map((run, index, shown) => {
                const isLive = explore.state === 'active' && index === shown.length - 1

                return (
                  <Text wrap="truncate-end">
                    <Text color={isLive ? 'warning' : 'success'}>{`${isLive ? '▶' : '✔'}  `}</Text>
                    <Text bold={isLive}>{run.topic === '' ? 'open exploration' : run.topic}</Text>
                    <Text dimColor>{`  ${formatDuration(now - run.at)} ago`}</Text>
                  </Text>
                )
              })
            ),
        )

  // ── no change bound yet (or design mode, whose snapshot has an empty change) ──
  if (change === undefined || snap === null || snap.change !== change) {
    const designs = snap?.designs ?? []
    const hasPreChangeWork = isExploring(live) || exploreRuns.length > 0 || live.designRuns.length > 0
    const commands = ['/opsx:explore', ...(hints?.design?.command === undefined ? [] : [`/${hints.design.command}`]), '/opsx:propose']
    const message =
      binding.candidates.length > 1
        ? 'Several active changes here. Pick the one this session works on.'
        : change !== undefined
          ? `Reading ${change}…`
          : isExploring(live)
            ? 'Explore mode: no change yet.'
            : live.designRuns.length > 0
              ? `${hints?.design?.label ?? 'Design'} mode: no change yet.`
              : `No OpenSpec change in this session yet. Run ${commands.slice(0, -1).join(', ')}, or ${commands.at(-1)}.`

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text bold color="claude">
            OpenSpec
          </Text>
          <Text dimColor wrap="wrap">
            {message}
          </Text>
        </Box>
        {hasPreChangeWork && change === undefined ? rail : null}
        {change === undefined ? exploreSection : null}
        {binding.candidates.length > 1 ? (
          <Box flexDirection="column" marginTop={1} paddingLeft={INDENT}>
            {binding.candidates.map(name => (
              <Button key={`pick:${name}`} plain onPress={() => void actions.pick(name)}>
                <Text dimColor>{'○  '}</Text>
                <Text bold>{name}</Text>
              </Button>
            ))}
          </Box>
        ) : null}
        {designs.length === 0
          ? null
          : section('design', hints?.design?.label ?? 'Design', undefined, true, null, () => designs.map(view => designRow(view, undefined)))}
        {nextCard}
      </Box>
    )
  }

  // ── header card and the stage rail ──────────────────────────────────────
  const mine = sessionUsage(main[change], changeAgents)
  const total = addUsage(mine, others.usage)
  const meta = [snap.schema, snap.branch, binding.source === 'pinned' ? 'pinned' : undefined].filter(Boolean).join(' · ')
  const figuresLine = [
    figures.contextPercent === undefined ? undefined : `ctx ${figures.contextPercent}%`,
    figures.costUsd === undefined ? undefined : `$${figures.costUsd.toFixed(2)} session`,
    `${formatTokens(tokensOf(total))} tok on this change` + (others.sessions > 0 ? ` (+${others.sessions} other sessions)` : ''),
  ]
    .filter(part => part !== undefined)
    .join(' · ')
  const chip =
    snap.archivedAs !== undefined
      ? { text: '✔  archived', color: 'success' }
      : current === undefined
        ? undefined
        : {
            text: `${STAGE_GLYPH[current.state]}  ${stageText(current)}`,
            color: STAGE_COLOR[current.state] ?? 'text',
          }
  const mainButton = mainSessionButton($, e, Button)
  const viewedAgent = agents.find(agent => agent.id === e.props.view?.agentId)
  const headerCard = (
    <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text bold color="claude" wrap="truncate-end">
          {change}
        </Text>
        {chip === undefined ? null : (
          <Text inverse bold color={chip.color}>
            {` ${chip.text} `}
          </Text>
        )}
      </Box>
      {mainButton === null ? (
        meta === '' ? null : (
          <Text dimColor wrap="truncate-end">
            {meta}
          </Text>
        )
      ) : (
        // Under the stage chip: which agent is in view, and the way back to the main session.
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text dimColor wrap="truncate-end">
            {meta}
          </Text>
          <Box flexDirection="row" gap={1}>
            {viewedAgent === undefined ? null : <Text dimColor>{`viewing ${viewedAgent.type}`}</Text>}
            {mainButton}
          </Box>
        </Box>
      )}
      <Text dimColor wrap="truncate-end">
        {figuresLine}
      </Text>
      {others.activeChanges.length === 0 ? null : (
        <Text dimColor wrap="truncate-end">{`also active: ${others.activeChanges.join(', ')}`}</Text>
      )}
    </Box>
  )

  // ── sections ───────────────────────────────────────────────────────────
  const stageOf = (key: Stage['key']) => stages.find(stage => stage.key === key)
  const plan = stageOf('plan')
  const design = stageOf('design')
  const propose = stageOf('propose')
  const apply = stageOf('apply')
  const doneTasks = views.reduce((sum, view) => sum + view.done, 0)
  const allTasks = views.reduce((sum, view) => sum + view.total, 0)
  const isApplyCurrent = current?.key === 'apply' || current?.key === 'verify'

  const planSection =
    snap.planning.length === 0 && snap.planningNone === undefined
      ? null
      : section('plan', plan?.label ?? 'Plan', plan?.state, plan?.state === 'active', null, () => [
          ...snap.planning.map(item => {
            const mark = item.mark ?? '?'
            // A GitHub issue that the proposal does not name says where the board found it.
            const via = item.issue?.via === 'branch' ? ' · branch' : item.issue?.via === 'pr' ? ' · closed by the PR' : ''

            return (
              <Button key={`plan:${item.id}`} plain onPress={() => void actions.readPlanning(item)}>
                <Text color={mark === '?' ? 'error' : MARK_COLOR[mark]}>{`[${mark}]`}</Text>
                <Text bold>{` ${item.id}`}</Text>
                <Text dimColor>{`  ${clip(item.title, Math.max(10, body - item.id.length - via.length - 8))}${via}`}</Text>
              </Button>
            )
          }),
          snap.planningNone === undefined ? null : <Text dimColor>{clip(`None — ${snap.planningNone}`, body)}</Text>,
        ])

  const designSection =
    snap.designs.length === 0
      ? null
      : section('design', design?.label ?? 'Design', design?.state, design?.state !== 'done', noteText(design?.note), () =>
          snap.designs.map(view => designRow(view, snap.createdAt)),
        )

  const artifactsDone = snap.artifacts.filter(artifact => artifact.status === 'done').length
  const verdicts = snap.verdicts ?? []
  const isSpecsOpen = expanded['specs'] === true
  // An artifact row opens its file in the reader; the specs row lists its spec files.
  const openArtifact = (artifact: ArtifactRow) => () => {
    if (artifact.status !== 'done') {
      $.ui.toast(`${artifact.id} is not written yet`)
      return
    }
    const output = artifact.outputPath ?? `${artifact.id}.md`
    if (output.includes('*')) {
      void actions.setExpanded('specs', !isSpecsOpen)
      return
    }
    void actions.read({ title: `${output} · ${snap.change}`, path: `${snap.dir}/${output}`, from: `artifact:${artifact.id}` })
  }
  const proposeNote = (
    <Text dimColor>
      {`${artifactsDone}/${snap.artifacts.length} artifacts`}
      {propose?.isInReview ? ' · in review' : ''}
      {verdicts.flatMap(verdict => [' · ', <Text color={VERDICT_COLOR[verdict.level]}>{verdict.value}</Text>])}
    </Text>
  )
  const idWidth = Math.max(...snap.artifacts.map(artifact => artifact.id.length), 8)
  const proposeSection = section('propose', 'Propose', propose?.state, propose?.state !== 'done', proposeNote, () =>
    snap.artifacts.flatMap(artifact => {
      const state = artifactState(artifact)
      const isGlob = (artifact.outputPath ?? '').includes('*')
      const verdict = verdicts.find(item => item.artifact === artifact.id)
      const detail =
        verdict !== undefined
          ? `${verdict.value}${verdict.note === undefined ? '' : ` (${verdict.note})`}`
          : isGlob && snap.specsCount > 0
            ? `${snap.specsCount} ${snap.specsCount === 1 ? 'file' : 'files'} ${isSpecsOpen ? '▾' : '▸'}`
            : artifact.status === 'blocked' && (artifact.missing?.length ?? 0) > 0
              ? `blocked · needs ${artifact.missing?.join(', ')}`
              : artifact.status === 'blocked' || artifact.status === 'ready'
                ? artifact.status
                : ''
      const row = (
        <Button key={`artifact:${artifact.id}`} plain onPress={openArtifact(artifact)}>
          <Text color={STAGE_COLOR[state]}>{`${STAGE_GLYPH[state]} `}</Text>
          <Text>{` ${fit(artifact.id, idWidth)}`}</Text>
          {detail === '' ? '' : <Text color={verdict === undefined ? undefined : VERDICT_COLOR[verdict.level]} dimColor={verdict === undefined}>{`  ${detail}`}</Text>}
        </Button>
      )
      if (!isGlob || !isSpecsOpen) {
        return [row]
      }

      return [
        row,
        <Box flexDirection="column" paddingLeft={TREE_INDENT - INDENT}>
          {snap.specs.map((name, index) => (
            <Button
              key={`spec:${name}`}
              plain
              onPress={() =>
                void actions.read({
                  title: `specs/${name}/spec.md · ${snap.change}`,
                  path: `${snap.dir}/specs/${name}/spec.md`,
                  from: `spec:${name}`,
                })
              }
            >
              <Text dimColor>{branch(index, snap.specs.length)}</Text>
              {name}
            </Button>
          ))}
        </Box>,
      ]
    }),
  )

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
  const applySection =
    views.length === 0
      ? null
      : section('apply', 'Apply', apply?.state, apply?.state !== 'done' || isApplyCurrent, applyNote, () =>
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
                  <Button key={`group-agent:${view.group.num}`} plain onPress={openAgent(latest)}>
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
                  // A: an unfolded task wraps in place, its first line on the row, the rest under it.
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
                      {/* C: hovering a clipped, folded task floats its whole text over the rows above it. */}
                      {hasCard ? hoverCard(Box, Text, task.text, Math.max(20, rowWidth - lead - 2), lead, scope) : null}
                    </Box>
                  )
                })}
              </Box>,
            ]
          }),
        )

  const agentRows = changeAgents.filter(agent => agent.phase !== 'other' || isRunning(agent))
  const mainPhases = Object.entries(main[change] ?? {}).filter(([, usage]) => tokensOf(usage) > 0)
  const labelWidth = Math.max(12, Math.min(34, body - 42))
  const agentsSection =
    agentRows.length === 0 && mainPhases.length === 0
      ? null
      : section('agents', 'Agents & tokens', undefined, true, noteText(`${formatTokens(tokensOf(mine))} this session`), () => [
          ...agentRows.slice(-12).map(agent => (
            <Button key={`agent:${agent.id}`} plain onPress={openAgent(agent)}>
              <Text color={isRunning(agent) ? 'warning' : agent.status === 'failed' ? 'error' : 'success'}>
                {`${isRunning(agent) ? '▶' : agent.status === 'failed' ? '✖' : '✔'} `}
              </Text>
              <Text mono bold={isRunning(agent)}>{` ${fit(agentLabel(agent), labelWidth)}`}</Text>
              <Text mono>{formatTokens(agentTokens(agent)).padStart(7)}</Text>
              <Text mono dimColor>
                {usageNote(agent.usage, agent.toolUses, elapsed(agent, now))}
              </Text>
            </Button>
          )),
          mainPhases.length === 0 ? null : (
            <Text dimColor wrap="truncate-end">
              {`main loop · ${mainPhases.map(([phase, usage]) => `${phase} ${formatTokens(tokensOf(usage))}`).join(' · ')}`}
            </Text>
          ),
        ])

  // Review and verify open their last report in the reader; the PR opens in the browser.
  const review = stageOf('verify')
  const pr = stageOf('pr')
  const archive = stageOf('archive')
  const fixCommit = snap.commits.find(commit => commit.kind === 'review-fix')
  const shipRow = (key: string | undefined, stage: Stage, note: string | undefined, onPress?: () => void) => {
    const content = [
      <Text color={STAGE_COLOR[stage.state]}>{`${STAGE_GLYPH[stage.state]} `}</Text>,
      <Text bold={stage.state !== 'pending'} dimColor={stage.state === 'pending'}>{` ${fit(stage.label, 8)}`}</Text>,
      note === undefined ? '' : <Text dimColor>{clip(note, body - 12)}</Text>,
    ]

    return key === undefined || onPress === undefined ? (
      <Text wrap="truncate-end">{content}</Text>
    ) : (
      <Button key={key} plain onPress={onPress}>
        {content}
      </Button>
    )
  }
  const reviewer = hints?.reviewAgent
  // The stage row shows the review agent's report, else the report of /opsx:verify. The verify
  // row shows the second one, when both ran.
  const stageReport =
    live.reviewReport !== undefined && reviewer !== undefined
      ? { title: `${reviewer} · ${snap.change}`, text: live.reviewReport }
      : live.verifyReport === undefined
        ? undefined
        : { title: `opsx:verify · ${snap.change}`, text: live.verifyReport }
  const isVerifyRow = live.verifyVerdict !== undefined && live.verifyReport !== undefined && stageReport?.text !== live.verifyReport
  const shipSection = section('ship', `${review?.label ?? 'Verify'} & ship`, undefined, true, null, () => [
    review === undefined
      ? null
      : shipRow(
          'review',
          review,
          review.note ??
            (fixCommit ? `fixes ${fixCommit.hash}` : reviewer === undefined ? '/opsx:verify checks the change against its artifacts' : `${reviewer} runs before the pull request`),
          () =>
            stageReport === undefined
              ? $.ui.toast(`No ${reviewer ?? 'verify'} report in this session yet`)
              : void actions.read({ ...stageReport, from: 'review' }),
        ),
    !isVerifyRow ? null : (
      <Button
        key="verify"
        plain
        onPress={() => void actions.read({ title: `opsx:verify · ${snap.change}`, text: live.verifyReport ?? '', from: 'verify' })}
      >
        <Text dimColor>{'· '}</Text>
        <Text>{` ${fit('Verify', 8)}`}</Text>
        <Text dimColor>{live.verifyVerdict}</Text>
      </Button>
    ),
    pr === undefined
      ? null
      : shipRow('pr', pr, snap.pr === undefined ? pr.note : `${pr.note ?? ''} · open in the browser ↗`, () =>
          snap.pr === undefined
            ? $.ui.toast('No pull request for this branch yet')
            : void actions.openExternal(snap.pr.url, `pull request #${snap.pr.number}`),
        ),
    archive === undefined ? null : shipRow(undefined, archive, archive.note),
  ])

  return (
    <Box flexDirection="column">
      {headerCard}
      {rail}
      {snap.warnings.map(warning => (
        <Box paddingX={1}>
          <Text color="warning" wrap="truncate-end">{`⚠  ${warning}`}</Text>
        </Box>
      ))}
      {planSection}
      {exploreSection}
      {designSection}
      {proposeSection}
      {applySection}
      {agentsSection}
      {shipSection}
      {nextCard}
      <Box paddingX={1} marginTop={1}>
        <Text dimColor italic wrap="truncate-end">
          click a row · artifact, work item → reader · design, PR → browser · group → its tasks · agent → its session · task → full text
        </Text>
      </Box>
    </Box>
  )
}

/**
 * The reader view of the board pane: one artifact or report as markdown, with a way back to
 * the board. Escape never reaches a plugin (it hands the keys back to the prompt), so the
 * way back is `← Board` or its hotkey `b` while the pane holds the keys.
 */
export function renderReader($: Engine, e: RenderInput<'Pane'>, doc: ReaderDoc, text: string | undefined, actions: ReaderActions) {
  const { Box, Text, Button, Markdown } = $.ui.resolve(e)
  const path = doc.path
  const url = doc.url
  // The text area is the body less its padding; a wider table becomes a list.
  const shown = text === undefined ? undefined : reflowTables(text, Math.max(20, e.props.bodyColumns - 2))

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text bold color="claude" wrap="truncate-end">
            {doc.title}
          </Text>
          <Box flexDirection="row" gap={1}>
            {path === undefined ? null : (
              <Button key="external" dimColor onPress={() => void actions.openExternal(path, doc.title)}>
                Open in its app ↗
              </Button>
            )}
            {url === undefined ? null : (
              <Button key="browser" dimColor onPress={() => void actions.openExternal(url, doc.title)}>
                Open in the browser ↗
              </Button>
            )}
            {mainSessionButton($, e, Button)}
            <Button key="back" hotkey="b" onPress={() => actions.back()}>
              ← Board
            </Button>
          </Box>
        </Box>
        {path === undefined && url === undefined ? null : (
          <Text dimColor wrap="truncate-start">
            {path ?? url}
          </Text>
        )}
        {shown === undefined || shown.reflowed === 0 ? null : (
          <Text dimColor italic wrap="truncate-end">
            {`${shown.reflowed === 1 ? 'A wide table is' : `${shown.reflowed} wide tables are`} shown as a list; the app shows the original`}
          </Text>
        )}
      </Box>
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {shown === undefined ? (
          <Text color="error">{`Cannot read ${path ?? doc.title}.`}</Text>
        ) : (
          <Markdown key="doc" text={shown.text} />
        )}
      </Box>
    </Box>
  )
}

const usageNote = (usage: Usage, toolUses: number | undefined, ms: number): string =>
  [
    tokensOf(usage) > 0 ? `  out ${formatTokens(usage.output)} · cache ${formatTokens(usage.cacheRead)}` : '',
    toolUses === undefined ? '' : ` · ${toolUses} tools`,
    ms > 0 ? ` · ${formatDuration(ms)}` : '',
  ].join('')
