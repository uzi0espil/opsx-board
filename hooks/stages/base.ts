// The skeleton of a stage of the board: a kind of step in the OpenSpec flow of a change, such as
// Propose or Apply. Each stage kind fills it in, in a module of its own, and ./index.ts lists
// them and puts them in the order of the flow. A stage works out its state from the evidence of
// the change and the session (./evidence.ts), offers the step that moves it on when its
// condition holds, and draws its part of the pane. Pure: a stage never takes `$`.
import type { RenderChildren } from 'claude-code'

import type { AgentRun, BoardHints, Flags, Live, MainUsage, Phase, PlanningItem, ReaderDoc, Snapshot, TaskGroup } from '../../types'
import type { Kit } from '../ui'

export type StageKey = 'plan' | 'explore' | 'design' | 'propose' | 'apply' | 'verify' | 'pr' | 'archive'
export type StageState = 'done' | 'active' | 'pending' | 'blocked' | 'na'

/**
 * A stage as the board shows it.
 * `isInReview`: the work of the stage is written, but the next step has not started.
 * `isRunning`: the work of the stage runs now, so Next offers nothing until it stops.
 */
export type Stage = {
  key: StageKey
  label: string
  state: StageState
  note?: string
  isOptional: boolean
  isInReview?: boolean
  isRunning?: boolean
}

/** The step Next offers: the command it puts in the prompt, and why. */
export type NextStep = { text: string; why: string }

export type GroupState = 'done' | 'running' | 'paused' | 'partial' | 'pending'
/** A task group as the Apply stage shows it: its count, its state, its agents, and its commit. */
export type GroupView = {
  group: TaskGroup
  done: number
  total: number
  state: GroupState
  agents: AgentRun[]
  runningTask?: string
  commit?: string
}

/** The evidence a stage reads: the change, the session, its agents, and the hints of the schema. */
export type StageContext = {
  snap: Snapshot | null
  live: Live
  agents: readonly AgentRun[]
  now: number
  /** The phases that hold tokens in the ledgers of the change, this session's and the others'. */
  seenPhases: readonly string[]
  hints: BoardHints | null
  /** The bound change. Design mode keeps an empty change name in its snapshot: none is bound. */
  change: string | undefined
  isArchived: boolean
  /** The last workflow command, while it is recent. */
  recentCommand: string | undefined
  /** The phase of the last workflow command. */
  commandPhase: Phase | undefined
  /** An agent of one of these phases runs now. */
  isAgentRunning: (...phases: Phase[]) => boolean
  /** The main turn of the last workflow command runs now, and the command is of this phase and change. */
  isCommandRunning: (phase: Phase) => boolean
}

/** What a section may do: show a text in the reader, open a page, fold a row, tell, or show an agent. */
export type StageActions = {
  read: (doc: ReaderDoc) => Promise<void>
  readPlanning: (item: PlanningItem) => Promise<void>
  openExternal: (target: string, what: string) => Promise<void>
  setExpanded: (key: string, isExpanded: boolean) => Promise<void>
  toast: (text: string) => void
  /** Opens the agent's session; the first call of the press, as the engine asks. */
  openAgent: (agent: AgentRun) => () => Promise<void>
}

/** What a stage draws from: its evidence, the stages around it, the pane's state, and the kit. */
export type PaneContext = {
  ctx: StageContext
  /** Whether a change is bound; before one is, the pane draws Explore and Design alone. */
  isBound: boolean
  stages: readonly Stage[]
  current: Stage | undefined
  views: readonly GroupView[]
  kit: Kit
  actions: StageActions
  expanded: Flags
  main: MainUsage
  /** The key of the session's tokens: the bound change, else the tokens before any change. */
  usageKey: string
  changeAgents: readonly AgentRun[]
}

export interface StageKind {
  readonly key: StageKey
  /** Its state from its own evidence, or undefined when the change has no such stage (Plan and Design without their hints). */
  evaluate(ctx: StageContext): Stage | undefined
  /**
   * The step that moves it on, when its condition holds. Next offers the step of the first stage
   * of the flow that has one; `stages` are the stages of the flow, evaluated.
   */
  next?(ctx: StageContext, stages: readonly Stage[]): NextStep | undefined
  /** Its own section of the pane. */
  section?(pane: PaneContext, stage: Stage | undefined): RenderChildren
  /** Its rows of the pane's shared "& ship" section. */
  shipRows?(pane: PaneContext, stage: Stage): RenderChildren[]
}

/** One stage of the evaluated flow. */
export const stageOf = (stages: readonly Stage[], key: StageKey): Stage | undefined => stages.find(stage => stage.key === key)
