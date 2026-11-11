// The PR stage: the pull request of the change, read from its host (see ../hosts); on GitLab the
// MR stage. A stage only while the board reads a pull request, or holds one. Its row opens the
// pull request in the browser.
import { prWords } from '../hosts'
import { shipRow } from '../ui'
import type { PaneContext, Stage, StageContext, StageKind } from './base'

export const prStage: StageKind = {
  key: 'pr',

  /**
   * The pull request as it stands: none yet, open (in review), merged, or closed without the merge.
   * It shows only: a pull request may come before, during, or after Apply, and before or after
   * the archive, so it never holds Next back, and only the archive finishes a change.
   */
  evaluate(ctx: StageContext): Stage | undefined {
    const { snap } = ctx
    const pr = snap?.pr
    // Without a pull request to read, the board shows no PR stage.
    if (snap?.prHost === 'none' && pr === undefined) {
      return undefined
    }
    const words = prWords(snap?.prHost)
    const isOpen = pr?.state === 'OPEN'

    return {
      key: 'pr',
      label: words.label,
      isOptional: false,
      state: pr === undefined ? (ctx.isArchived ? 'na' : 'pending') : isOpen ? 'active' : pr.state === 'MERGED' ? 'done' : 'na',
      note: pr === undefined ? undefined : `${words.ref(pr.number)} ${pr.state.toLowerCase()}`,
      isInReview: isOpen,
      isInfo: true,
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
