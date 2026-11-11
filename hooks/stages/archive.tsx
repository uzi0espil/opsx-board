// The Archive stage: `/opsx:archive` moves the change into the `archive` folder, which finishes it.
import { prWords } from '../hosts'
import { shipRow } from '../ui'
import { taskCount, tasksNote } from './apply'
import type { NextStep, PaneContext, Stage, StageContext, StageKind } from './base'
import { stageOf } from './base'

export const archiveStage: StageKind = {
  key: 'archive',

  evaluate(ctx: StageContext): Stage {
    return {
      key: 'archive',
      label: 'Archive',
      isOptional: false,
      state: ctx.isArchived ? 'done' : ctx.recentCommand === 'opsx:archive' ? 'active' : 'pending',
      note: ctx.snap?.archivedAs?.slice(0, 10),
      isRunning: ctx.isCommandRunning('archive') || ctx.isAgentRunning('archive'),
    }
  },

  /**
   * The last step, once the stages before it are done: archive the change. A team may archive
   * before or after it opens the pull request, so the pull request never holds it back. Tasks
   * left open, such as those after the merge, show in the reason.
   */
  next(ctx: StageContext, stages: readonly Stage[]): NextStep | undefined {
    const { snap, change } = ctx
    if (snap === null || change === undefined) {
      return undefined
    }
    const { name } = prWords(snap.prHost)
    const { done, total } = taskCount(ctx)
    const isAllDone = total > 0 && done === total
    const ready =
      snap.pr?.state === 'OPEN'
        ? `the ${name} is open`
        : snap.pr?.state === 'MERGED'
          ? `the ${name} is merged`
          : stageOf(stages, 'verify')?.state === 'done'
            ? 'the change is verified'
            : undefined
    const why = [ready ?? (isAllDone ? 'the tasks are done' : undefined), isAllDone ? undefined : tasksNote(ctx)].filter(Boolean).join('; ')

    return { text: `/opsx:archive ${change}`, why }
  },

  shipRows(pane: PaneContext, stage: Stage) {
    return [shipRow(pane.kit, undefined, stage, stage.note)]
  },
}
