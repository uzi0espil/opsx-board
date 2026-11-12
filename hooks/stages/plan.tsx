// The Plan stage: the work items a change is for, which the proposal section of the hints names
// (see ../providers). Optional; a stage only when board.yaml defines it.
import { MARK_COLOR, clip } from '../ui'
import type { PaneContext, Stage, StageContext, StageKind } from './base'
import { isRunning } from './evidence'

export const planStage: StageKind = {
  key: 'plan',

  /** Active while the agent of the stage runs; done once the proposal names its items, or none. */
  evaluate(ctx: StageContext): Stage | undefined {
    const { hints, snap, agents } = ctx
    if (hints?.plan === undefined) {
      return undefined
    }
    const planAgent = hints.plan.agent
    const pmRunning = planAgent !== undefined && agents.some(agent => agent.type === planAgent && isRunning(agent))

    return {
      key: 'plan',
      label: hints.plan.label,
      isOptional: true,
      state: pmRunning ? 'active' : snap !== null && (snap.planning.length > 0 || snap.planningNone !== undefined) ? 'done' : 'na',
      note: snap?.planning.map(item => item.id).join(', ') || snap?.planningNone,
      isRunning: pmRunning || ctx.isAgentRunning('plan'),
    }
  },

  /** A row per work item, as its provider marks it; a click shows it as its provider decides. */
  section(pane: PaneContext, stage: Stage | undefined) {
    const snap = pane.ctx.snap
    if (snap === null || (snap.planning.length === 0 && snap.planningNone === undefined)) {
      return null
    }
    const { Text, Button, body, section } = pane.kit

    return section('plan', stage?.label ?? 'Plan', stage?.state, stage?.state === 'active', null, () => [
      ...snap.planning.map(item => {
        const mark = item.mark ?? '?'
        // An item that the proposal does not name says where the board found it.
        const via = item.via === 'branch' ? ' · branch' : item.via === 'pr' ? ' · closed by the PR' : ''
        const after = `${item.note === undefined ? '' : ` · ${item.note}`}${via}`

        return (
          <Button key={`plan:${item.id}`} plain onPress={() => void pane.actions.readPlanning(item)}>
            {item.isLink === true ? (
              // An item with no state on the board is a link to its page.
              <Text dimColor>{' ↗ '}</Text>
            ) : (
              <Text color={mark === '?' ? 'error' : MARK_COLOR[mark]}>{`[${mark}]`}</Text>
            )}
            <Text bold>{` ${item.id}`}</Text>
            <Text dimColor>{`  ${clip(item.title, Math.max(10, body - item.id.length - after.length - 8))}${after}`}</Text>
          </Button>
        )
      }),
      snap.planningNone === undefined ? null : <Text dimColor>{clip(`None — ${snap.planningNone}`, body)}</Text>,
    ])
  },
}
