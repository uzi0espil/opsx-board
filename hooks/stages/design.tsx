// The Design stage: the views a proposal needs designed, and the design command of the hints.
// Optional; a stage only when board.yaml defines it. Before any change is bound, its section
// shows the views the design command touched.
import type { BoardHints, DesignView } from '../../types'
import { STAGE_COLOR, STAGE_GLYPH, clip } from '../ui'
import type { NextStep, PaneContext, Stage, StageContext, StageKind, StageState } from './base'
import { stageOf } from './base'
import { isCommandTurn, isDesigning, isViewInReview, isViewOpen } from './evidence'

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

/** The first view that the proposal asks for and that still needs design work. */
const openView = (ctx: StageContext): DesignView | undefined =>
  ctx.snap?.designs.find(item => item.isNeedsDesign && isViewOpen(item, ctx.snap?.createdAt))

/** What a later step adds to its reason while a blocked design still needs an update. */
export const designPending = (ctx: StageContext, stages: readonly Stage[]): string => {
  const view = openView(ctx)

  return stageOf(stages, 'design')?.state === 'blocked' && view !== undefined ? `; design ${view.view} still needs an update` : ''
}

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

/** A design row opens its artifact in the browser; its "decisions" button opens the decision log in the reader. */
const designRow = (pane: PaneContext, view: DesignView, createdAt: string | undefined) => {
  const { live, hints } = pane.ctx
  const { Box, Text, Button, body } = pane.kit
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
      ? void pane.actions.openExternal(artifactPath, `the ${view.view} design`)
      : pane.actions.toast(`${view.view} has no ${hints?.design?.open ?? 'design file'} yet`)
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
            void pane.actions.read({
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

export const designStage: StageKind = {
  key: 'design',

  /**
   * Done once every view is approved; active while the session designs one; blocked while the
   * proposal asks for a view that has none. It runs only while the turn of its command does.
   */
  evaluate(ctx: StageContext): Stage | undefined {
    const { hints, live, snap } = ctx
    if (hints?.design === undefined) {
      return undefined
    }
    const designs = snap?.designs ?? []
    const createdAt = snap?.createdAt
    const base = {
      key: 'design' as const,
      label: hints.design.label,
      isOptional: true,
      isRunning: (isDesigning(live, hints) && isCommandTurn(live)) || ctx.isAgentRunning('design'),
    }
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
  },

  /** A blocked design comes before the remaining artifacts; once planned, it only has to land before its tasks. */
  next(ctx: StageContext, stages: readonly Stage[]): NextStep | undefined {
    const snap = ctx.snap
    if (snap === null || ctx.change === undefined || stageOf(stages, 'design')?.state !== 'blocked' || snap.isPlanningComplete) {
      return undefined
    }
    const text = designCommand(ctx.hints, openView(ctx))

    return text === undefined ? undefined : { text, why: 'the proposal needs an approved design first' }
  },

  section(pane: PaneContext, stage: Stage | undefined) {
    const { snap, hints } = pane.ctx
    const { section, noteText } = pane.kit
    const designs = snap?.designs ?? []
    if (designs.length === 0) {
      return null
    }
    // Before any change is bound: the views of the session, with no stage state.
    if (!pane.isBound) {
      return section('design', hints?.design?.label ?? 'Design', undefined, true, null, () => designs.map(view => designRow(pane, view, undefined)))
    }

    return section('design', stage?.label ?? 'Design', stage?.state, stage?.state !== 'done', noteText(stage?.note), () =>
      designs.map(view => designRow(pane, view, snap?.createdAt)),
    )
  },
}
