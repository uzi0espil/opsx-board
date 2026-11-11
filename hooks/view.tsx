// The board pane: the header card, the stage rail, then the section of each stage, the agents,
// the shared "& ship" section, and the next step. Each stage draws its own section (./stages);
// the pane frames them. Every row acts on a click: an artifact opens in the reader view of the
// same pane, a design and the pull request in the browser. register.tsx reads the session
// values (so the drawing subscribes to them) and hands them here with the actions that write them.
import type { EngineInterface, RenderChildren, RenderInput } from 'claude-code'

import type { AgentRun, Binding, BoardHints, Flags, Live, MainUsage, Others, PlanningItem, ReaderDoc, Report, SessionFigures, Snapshot, Usage } from '../types'
import { prWords } from './hosts'
import { PRE_CHANGE, addUsage, agentTokens, sessionUsage, tokensOf } from './ledger'
import { currentStage, stageText } from './model'
import { formatDuration, formatTokens, reflowTables } from './parse'
import { STAGES, flowOf, isHidden, nextStep, stageKind } from './stages'
import type { PaneContext, StageKind, StageState } from './stages'
import { groupViews } from './stages/apply'
import { stageOf } from './stages/base'
import { exploreRunsOf, isExploring, isRunning } from './stages/evidence'
import { INDENT, RIGHT_INSET, STAGE_COLOR, STAGE_GLYPH, elapsed, fit } from './ui'
import type { Elements, Kit } from './ui'

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
  /** Shows a planning item as its provider decides: in the reader view, or in the browser. */
  readPlanning: (item: PlanningItem) => Promise<void>
  /** Opens a URL in the browser, or a file in its default app. */
  openExternal: (target: string, what: string) => Promise<void>
}

export type ReaderActions = {
  /** Shows the board again, at the row that opened the document. */
  back: () => Promise<void>
  openExternal: (target: string, what: string) => Promise<void>
}

const agentLabel = (agent: AgentRun): string => (agent.group !== undefined ? `${agent.type} · G${agent.group}` : agent.type)

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
  const flow = flowOf(snap, live, changeAgents, now, seenPhases, hints)
  const stages = flow.stages
  const views = groupViews(snap, changeAgents, reports, live, hints)
  const next = nextStep(flow)
  const current = currentStage(stages)

  const isOpen = (key: string, byDefault: boolean): boolean => (folded[key] === undefined ? byDefault : !folded[key])
  const toggle = (key: string, byDefault: boolean) => () => void actions.setFolded(key, isOpen(key, byDefault))
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

  const kit: Kit = { Box, Text, Button, body, section, noteText }
  const isBound = change !== undefined && snap !== null && snap.change === change
  const pane: PaneContext = {
    ctx: flow.ctx,
    isBound,
    stages,
    current,
    views,
    kit,
    actions: {
      read: actions.read,
      readPlanning: actions.readPlanning,
      openExternal: actions.openExternal,
      setExpanded: actions.setExpanded,
      toast: text => $.ui.toast(text),
      openAgent,
    },
    expanded,
    main,
    usageKey,
    changeAgents,
  }
  // The section a stage draws, from its own state. A stage board.yaml hides draws none.
  const draw = (kind: StageKind | undefined) =>
    kind?.section === undefined || isHidden(flow, kind.key) ? null : kind.section(pane, stageOf(stages, kind.key))

  const nextCard =
    next === undefined ? null : (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
        <Button key="next" variant="primary" onPress={() => void $.prompt.fill({ text: next.text })}>
          {`Next: ${next.text.trim()}`}
        </Button>
        <Text dimColor wrap="truncate-end">{`fills the prompt · ${next.why}`}</Text>
      </Box>
    )

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

  const exploreSection = draw(stageKind('explore'))

  // ── no change bound yet (or design mode, whose snapshot has an empty change) ──
  if (!isBound || snap === null || change === undefined) {
    const hasPreChangeWork = isExploring(live) || exploreRunsOf(live, change).length > 0 || live.designRuns.length > 0
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
        {draw(stageKind('design'))}
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

  // The stages after Apply share one section: each stage of the flow adds its rows.
  const shippers = STAGES.filter(kind => kind.shipRows !== undefined && stageOf(stages, kind.key) !== undefined)
  const verify = stageOf(stages, 'verify')
  const shipSection =
    shippers.length === 0
      ? null
      : section('ship', verify === undefined ? 'Ship' : `${verify.label} & ship`, undefined, true, null, () =>
          shippers.flatMap(kind => {
            const stage = stageOf(stages, kind.key)

            return stage === undefined || kind.shipRows === undefined ? [] : kind.shipRows(pane, stage)
          }),
        )

  return (
    <Box flexDirection="column">
      {headerCard}
      {rail}
      {snap.warnings.map(warning => (
        <Box paddingX={1}>
          <Text color="warning" wrap="truncate-end">{`⚠  ${warning}`}</Text>
        </Box>
      ))}
      {STAGES.map(kind => (stageOf(stages, kind.key) === undefined ? null : draw(kind)))}
      {agentsSection}
      {shipSection}
      {nextCard}
      <Box paddingX={1} marginTop={1}>
        <Text dimColor italic wrap="truncate-end">
          {`click a row · artifact, work item → reader · design, ${prWords(snap.prHost).label} → browser · group → its tasks · agent → its session · task → full text`}
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
