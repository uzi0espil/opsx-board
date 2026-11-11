// The Explore stage: `/opsx:explore`, a stance that lasts until the next workflow command.
// Optional; before any change is bound, its section still shows the topics of the session.
import { formatDuration, formatTokens } from '../parse'
import { agentTokens, tokensOf, zeroUsage } from '../ledger'
import type { PaneContext, Stage, StageContext, StageKind } from './base'
import { exploreRunsOf, isCommandTurn, isExploring } from './evidence'

export const exploreStage: StageKind = {
  key: 'explore',

  /**
   * Active while the session explores; done when this session explored earlier, or when a ledger
   * of the change holds tokens spent in the explore phase. It runs only while the turn of its
   * command does.
   */
  evaluate(ctx: StageContext): Stage {
    const { live, change, seenPhases } = ctx
    const runs = exploreRunsOf(live, change)
    const base = { key: 'explore' as const, label: 'Explore', isOptional: true, note: runs.at(-1)?.topic || undefined }
    const isActive = isExploring(live) && live.exploreRuns?.at(-1)?.change === change
    const state = isActive ? 'active' : runs.length > 0 || seenPhases.includes('explore') ? 'done' : 'na'

    return { ...base, state, isRunning: (state === 'active' && isCommandTurn(live)) || ctx.isAgentRunning('explore') }
  },

  /** The topics this session explored for the bound change, and the tokens spent on them. */
  section(pane: PaneContext, stage: Stage | undefined) {
    if (stage === undefined || stage.state === 'na') {
      return null
    }
    const { live, change, now } = pane.ctx
    const { Text, section, noteText } = pane.kit
    const runs = exploreRunsOf(live, change)
    const tokens =
      tokensOf(pane.main[pane.usageKey]?.['explore'] ?? zeroUsage()) +
      pane.changeAgents.filter(agent => agent.phase === 'explore').reduce((sum, agent) => sum + agentTokens(agent), 0)

    return section('explore', 'Explore', stage.state, stage.state === 'active', noteText(tokens > 0 ? `${formatTokens(tokens)} tok` : undefined), () =>
      runs.length === 0 ? (
        <Text dimColor>explored in another session</Text>
      ) : (
        runs.slice(-5).map((run, index, shown) => {
          const isLive = stage.state === 'active' && index === shown.length - 1

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
  },
}
