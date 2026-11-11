// The stages the board knows, and the flow of a change through them. STAGES is the only list of
// them: the rail, Next, and the pane all go through it. A new kind of stage is a module that fills
// in the skeleton of ./base.ts, added to STAGES.
import type { AgentRun, BoardHints, Live, Snapshot } from '../../types'
import type { NextStep, Stage, StageContext, StageKey, StageKind } from './base'
import { applyStage } from './apply'
import { archiveStage } from './archive'
import { designStage } from './design'
import { stageContext } from './evidence'
import { exploreStage } from './explore'
import { planStage } from './plan'
import { prStage } from './pr'
import { proposeStage } from './propose'
import { verifyStage } from './verify'

/** Every kind of stage, in the order the pane draws their sections. */
export const STAGES: readonly StageKind[] = [planStage, exploreStage, designStage, proposeStage, applyStage, verifyStage, prStage, archiveStage]

/** The kind of a stage. */
export const stageKind = (key: StageKey): StageKind | undefined => STAGES.find(kind => kind.key === key)

/** The order of the flow: Plan before or after Explore, as the hints say, then the other stages. */
const flowOrder = (hints: BoardHints | null): StageKind[] => {
  const [plan, explore, ...rest] = STAGES
  const before = hints?.plan?.isBeforeExplore === true ? [plan, explore] : [explore, plan]

  return [...before, ...rest].filter((kind): kind is StageKind => kind !== undefined)
}

/** The stages of a change, in the order of its flow, and the evidence they were read from. */
export type Flow = { ctx: StageContext; stages: Stage[] }

/**
 * The flow of a change. `seenPhases` names the phases that hold tokens in the ledgers of the
 * change, this session's and the others'. Only Explore reads it: Propose ends on direct signs
 * of Apply, because older ledgers hold review tokens under `apply`. Plan and Design are stages
 * only when the hints define them.
 */
export const flowOf = (
  snap: Snapshot | null,
  live: Live,
  agents: readonly AgentRun[],
  now: number,
  seenPhases: readonly string[] = [],
  hints: BoardHints | null = null,
): Flow => {
  const ctx = stageContext(snap, live, agents, now, seenPhases, hints)

  return { ctx, stages: flowOrder(hints).flatMap(kind => kind.evaluate(ctx) ?? []) }
}

/** The stages of a change, in the order of its flow. */
export const stagesOf = (...args: Parameters<typeof flowOf>): Stage[] => flowOf(...args).stages

/**
 * The step Next offers: none while the work of a stage runs (Next shows once it stops), and none
 * for an archived change. Else the step of the first stage of the flow whose condition holds.
 */
export const nextStep = (flow: Flow): NextStep | undefined => {
  const { ctx, stages } = flow
  if (stages.some(stage => stage.isRunning === true) || (ctx.change !== undefined && ctx.isArchived)) {
    return undefined
  }
  for (const stage of stages) {
    const step = stageKind(stage.key)?.next?.(ctx, stages)
    if (step !== undefined) {
      return step
    }
  }

  return undefined
}

export type { GroupView, NextStep, PaneContext, Stage, StageKey, StageKind, StageState } from './base'
