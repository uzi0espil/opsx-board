// Pure: where a change stands, from the stages of its flow (./stages). The current stage, the
// phase the ledgers keep its tokens under, and the status line. No `$` here.
import type { Live, Phase, Snapshot } from '../types'
import { agentTokens } from './ledger'
import { formatTokens } from './parse'
import type { GroupView, Stage } from './stages/base'
import { exploreRunsOf } from './stages/evidence'

/**
 * The stage the work is at: the furthest active one (an optional stage left blocked
 * behind it does not hold the work back), else the first blocked, else the first pending. A
 * stage that only shows how something stands, such as the pull request, is never the one.
 */
export const currentStage = (stages: readonly Stage[]): Stage | undefined => {
  const work = stages.filter(stage => stage.isInfo !== true)

  return (
    [...work].reverse().find(stage => stage.state === 'active') ??
    work.find(stage => stage.state === 'blocked') ??
    work.find(stage => stage.state === 'pending')
  )
}

export const phaseOfStage = (stage: Stage | undefined): Phase => {
  switch (stage?.key) {
    case 'plan':
    case 'explore':
    case 'design':
    case 'propose':
    case 'apply':
    case 'archive':
      return stage.key
    // The ledgers keep the tokens of the review and the pull request under `review`.
    case 'verify':
    case 'pr':
      return 'review'
    default:
      return 'other'
  }
}

/** The label of a stage with its short state: the task count of Apply, or "in review". */
export const stageText = (stage: Stage): string =>
  stage.key === 'apply' && stage.note !== undefined ? `${stage.label} ${stage.note}` : stage.isInReview ? `${stage.label} in review` : stage.label

export const statusLine = (snap: Snapshot | null, stages: readonly Stage[], views: readonly GroupView[], live: Live): string | undefined => {
  if (snap === null) {
    const design = live.designRuns.at(-1)
    const explore = exploreRunsOf(live, undefined).at(-1)
    if (explore !== undefined && (design === undefined || explore.at >= design.at)) {
      const topic = explore.topic.length > 48 ? `${explore.topic.slice(0, 47)}…` : explore.topic

      return `opsx explore${topic === '' ? '' : ` ${topic}`}`
    }

    return design === undefined ? undefined : `opsx design ${design.view}`
  }
  const stage = currentStage(stages)
  const running = views.find(view => view.state === 'running')
  const parts = [`opsx ${snap.change}`]
  if (snap.archivedAs !== undefined) {
    parts.push('archived')
  } else if (stage !== undefined) {
    parts.push(stageText(stage))
  }
  if (running !== undefined) {
    const tokens = running.agents.reduce((sum, agent) => sum + agentTokens(agent), 0)
    parts.push(`G${running.group.num} ▶ ${formatTokens(tokens)}`)
  }

  return parts.join(' · ')
}
