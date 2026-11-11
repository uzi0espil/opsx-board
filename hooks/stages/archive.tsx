// The Archive stage: `/opsx:archive` moves the change into the `archive` folder, which finishes it.
import { prWords } from '../hosts'
import { shipRow } from '../ui'
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

  /** The last step: archive the change once it is verified, or its pull request is open. */
  next(ctx: StageContext, stages: readonly Stage[]): NextStep | undefined {
    const { snap, change } = ctx
    if (snap === null || change === undefined) {
      return undefined
    }
    const { name } = prWords(snap.prHost)
    const partial = snap.groups.flatMap(group => group.tasks).filter(task => task.mark === '~').length
    const ready = stageOf(stages, 'pr') === undefined ? 'the change is verified' : `the ${name} is open`

    return {
      text: `/opsx:archive ${change}`,
      why: partial === 0 ? ready : `${ready}; ${partial} ${partial === 1 ? 'task stays' : 'tasks stay'} [~]`,
    }
  },

  shipRows(pane: PaneContext, stage: Stage) {
    return [shipRow(pane.kit, undefined, stage, stage.note)]
  },
}
