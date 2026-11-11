// The PR stage: the pull request of the change, read from its host (see ../hosts); on GitLab the
// MR stage. A stage only while the board reads a pull request, or holds one. Its row opens the
// pull request in the browser.
import { prWords } from '../hosts'
import { shipRow } from '../ui'
import type { PaneContext, Stage, StageContext, StageKind } from './base'

export const prStage: StageKind = {
  key: 'pr',

  /** Done once the pull request is open, or the change is archived. */
  evaluate(ctx: StageContext): Stage | undefined {
    const { snap } = ctx
    const hasPr = snap?.pr !== undefined
    // Without a pull request to read, the board shows no PR stage.
    if (snap?.prHost === 'none' && !hasPr) {
      return undefined
    }
    const words = prWords(snap?.prHost)

    return {
      key: 'pr',
      label: words.label,
      isOptional: false,
      state: hasPr || ctx.isArchived ? 'done' : 'pending',
      note: snap?.pr === undefined ? undefined : `${words.ref(snap.pr.number)} ${snap.pr.state.toLowerCase()}`,
    }
  },

  shipRows(pane: PaneContext, stage: Stage) {
    const snap = pane.ctx.snap
    if (snap === null) {
      return []
    }
    const words = prWords(snap.prHost)
    const pr = snap.pr

    return [
      shipRow(pane.kit, 'pr', stage, pr === undefined ? stage.note : `${stage.note ?? ''} · open in the browser ↗`, () =>
        pr === undefined
          ? pane.actions.toast(`No ${words.name} for this branch yet`)
          : void pane.actions.openExternal(pr.url, `${words.name} ${words.ref(pr.number)}`),
      ),
    ]
  },
}
