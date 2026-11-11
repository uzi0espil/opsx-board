// The stages the board knows, and the flow of a change through them. STAGES is the only list of
// them: the rail, Next, and the pane all go through it. A new kind of stage is a module that fills
// in the skeleton of ./base.ts, added to STAGES.
import type { AgentRun, BoardHints, Live, Snapshot, StageSetting } from '../../types'
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

/**
 * The stages of the flow and what board.yaml sets for them. Hints written before the flow existed
 * keep the default order, with Plan before or after Explore as they say.
 */
const flowSettings = (hints: BoardHints | null): StageSetting[] => {
  if (hints?.flow !== undefined) {
    return hints.flow
  }
  const keys: StageKey[] = ['explore', 'plan', 'design', 'propose', 'apply', 'verify', 'pr', 'archive']
  const order = hints?.plan?.isBeforeExplore === true ? ['plan' as const, 'explore' as const, ...keys.slice(2)] : keys

  return order.map(key => ({ key }))
}

/** A stage as board.yaml sets it: its label, and an optional stage that has not started shows as not applicable. */
const withSetting = (stage: Stage, setting: StageSetting): Stage => ({
  ...stage,
  label: setting.label ?? stage.label,
  isOptional: setting.isOptional === true || stage.isOptional,
  state: setting.isOptional === true && stage.state === 'pending' ? 'na' : stage.state,
})

/** The stages of a change, in the order of its flow, the evidence they were read from, and what board.yaml sets. */
export type Flow = { ctx: StageContext; stages: Stage[]; settings: StageSetting[] }

/** Whether board.yaml hides a stage. */
export const isHidden = (flow: Flow, key: StageKey): boolean => flow.settings.some(setting => setting.key === key && setting.isHidden === true)

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
  const settings = flowSettings(hints)
  const stages = settings.flatMap(setting => {
    const stage = setting.isHidden === true ? undefined : stageKind(setting.key)?.evaluate(ctx)

    return stage === undefined ? [] : [withSetting(stage, setting)]
  })

  return { ctx, stages, settings }
}

/** The stages of a change, in the order of its flow. */
export const stagesOf = (...args: Parameters<typeof flowOf>): Stage[] => flowOf(...args).stages

/**
 * The step Next offers: none while the work of a stage runs (Next shows once it stops), and none
 * for an archived change, which is finished. Else the step of the first stage of the flow whose
 * condition holds. Next skips a stage that board.yaml makes optional.
 */
export const nextStep = (flow: Flow): NextStep | undefined => {
  const { ctx, stages, settings } = flow
  if (stages.some(stage => stage.isRunning === true) || (ctx.change !== undefined && ctx.isArchived)) {
    return undefined
  }
  for (const stage of stages) {
    if (settings.some(setting => setting.key === stage.key && setting.isOptional === true)) {
      continue
    }
    const step = stageKind(stage.key)?.next?.(ctx, stages)
    if (step !== undefined) {
      return step
    }
  }

  return undefined
}

export type { GroupView, NextStep, PaneContext, Stage, StageKey, StageKind, StageState } from './base'
