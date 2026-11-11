// The Verify stage: `/opsx:verify`, or the review agent of the hints, under the label of the hints
// (such as Review). Its rows in the "& ship" section open the last report in the reader.
import { prWords } from '../hosts'
import { fit, shipRow } from '../ui'
import type { NextStep, PaneContext, Stage, StageContext, StageKind } from './base'
import { stageOf } from './base'
import { designPending } from './design'
import { findingsNote, isCommandFor, isRunning } from './evidence'

export const verifyStage: StageKind = {
  key: 'verify',

  /**
   * Active while the review agent or `/opsx:verify` runs; done once a report or a verdict came, a
   * review fix landed, the pull request is open, or the change is archived.
   */
  evaluate(ctx: StageContext): Stage {
    const { snap, live, agents, hints, recentCommand } = ctx
    const reviewAgent = hints?.reviewAgent
    const reviewRunning = reviewAgent !== undefined && agents.some(agent => agent.type === reviewAgent && isRunning(agent))
    const commits = snap?.commits ?? []

    return {
      key: 'verify',
      label: hints?.verifyLabel ?? 'Verify',
      isOptional: false,
      state:
        reviewRunning || (recentCommand === 'opsx:verify' && live.verifyVerdict === undefined && isCommandFor(live, snap?.change))
          ? 'active'
          : ctx.isArchived ||
              snap?.pr !== undefined ||
              live.reviewCounts !== undefined ||
              live.verifyVerdict !== undefined ||
              commits.some(commit => commit.kind === 'review-fix')
            ? 'done'
            : 'pending',
      note: live.reviewCounts !== undefined ? findingsNote(live.reviewCounts) : live.verifyVerdict,
      isRunning: reviewRunning || ctx.isCommandRunning('verify') || ctx.isAgentRunning('verify', 'review'),
    }
  },

  /** Without a PR stage, the change goes from its tasks to verify, then to the archive. */
  next(ctx: StageContext, stages: readonly Stage[]): NextStep | undefined {
    const { snap, change } = ctx
    if (snap === null || change === undefined || stageOf(stages, 'pr') !== undefined || stageOf(stages, 'verify')?.state === 'done') {
      return undefined
    }

    return { text: `/opsx:verify ${change}`, why: `the tasks are done. Verify the change before the archive${designPending(ctx, stages)}` }
  },

  /**
   * The stage row shows the review agent's report, else the report of `/opsx:verify`. The verify
   * row shows the second one, when both ran.
   */
  shipRows(pane: PaneContext, stage: Stage) {
    const { snap, live, hints } = pane.ctx
    if (snap === null) {
      return []
    }
    const { Text, Button } = pane.kit
    const { actions } = pane
    const reviewer = hints?.reviewAgent
    const fixCommit = snap.commits.find(commit => commit.kind === 'review-fix')
    const words = prWords(snap.prHost)
    const stageReport =
      live.reviewReport !== undefined && reviewer !== undefined
        ? { title: `${reviewer} · ${snap.change}`, text: live.reviewReport }
        : live.verifyReport === undefined
          ? undefined
          : { title: `opsx:verify · ${snap.change}`, text: live.verifyReport }
    const isVerifyRow = live.verifyVerdict !== undefined && live.verifyReport !== undefined && stageReport?.text !== live.verifyReport

    return [
      shipRow(
        pane.kit,
        'review',
        stage,
        stage.note ??
          (fixCommit ? `fixes ${fixCommit.hash}` : reviewer === undefined ? '/opsx:verify checks the change against its artifacts' : `${reviewer} runs before the ${words.name}`),
        () =>
          stageReport === undefined
            ? actions.toast(`No ${reviewer ?? 'verify'} report in this session yet`)
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
    ]
  },
}
