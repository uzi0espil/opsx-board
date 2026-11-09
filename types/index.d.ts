export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Phase =
  | 'plan'
  | 'explore'
  | 'design'
  | 'propose'
  | 'apply'
  | 'review'
  | 'verify'
  | 'archive'
  | 'other'

export type Task = { id: string; text: string; mark: string; line: number }

export type TaskGroup = { num: string; title: string; tasks: Task[] }

/**
 * One artifact of the change's schema. `level` is the length of its longest `requires` chain,
 * so artifacts of one level can be written side by side. `missing` names the required
 * artifacts that are not done yet.
 */
export type ArtifactRow = { id: string; status: string; outputPath?: string; requires?: string[]; level?: number; missing?: string[] }

/** The verdict that a review artifact states, read with the verdict hints of board.yaml. */
export type Verdict = { artifact: string; value: string; level: 'ok' | 'warn' | 'block'; note?: string; next?: string }

/** A GitHub issue reference: `repo` is `owner/name`, absent for the repository of the working directory. */
export type IssueRef = { repo?: string; number: number }

/** Where the board found a GitHub issue: the proposal section, the branch name, or the pull request that closes it. */
export type IssueVia = 'proposal' | 'branch' | 'pr'

export type PlanningItem = {
  id: string
  title: string
  /** The file that holds the item, relative to the repository root. */
  file?: string
  mark?: string
  /** A GitHub issue: its reference, where the board found it, and what `gh` gave. */
  issue?: IssueRef & { via: IssueVia; url?: string; state?: string }
}

/** A work-item reference that a `file` provider resolves: an ID pattern and the file that holds the items. */
export type WorkItemSource = { pattern: string; file: string; history?: string }

/**
 * The GitHub issues of a change, which `gh` reads: those the proposal section names, the one
 * the branch name names, and those the pull request closes.
 */
export type GithubSource = {
  /** `owner/name`: the repository of a bare `#N`. Else the one `gh` resolves from the working directory. */
  repo?: string
  /** A pattern whose first group is an issue number in the branch name. */
  branch?: string
  /** Whether the issues that the pull request closes count. */
  isPrClosing: boolean
}

export type PlanHints = {
  label: string
  /** The proposal section that lists the items. */
  section: string
  /** A running agent of this type marks the stage active. */
  agent?: string
  isBeforeExplore: boolean
  sources: WorkItemSource[]
  github?: GithubSource
}

export type DesignHints = {
  label: string
  /** The proposal section that names the designs. */
  section: string
  /** The command that designs a view, without its slash, and the first words that name no view. */
  command?: string
  skipArgs: string[]
  /** The commands Next offers, with `{id}` for the design. */
  nextNew?: string
  nextUpdate?: string
  /** A pattern whose first group is the design id. */
  path: string
  /** The folder of a design, relative to the repository root, with `{id}`. */
  dir: string
  /** Files and folders inside the design folder. */
  open?: string
  screenshots?: string
  decisions?: string
  /** A pattern: a proposal row or section that matches it asks for design work. */
  needs?: string
}

export type VerdictHints = {
  values: string[]
  block: string[]
  warn: string[]
  /** The command Next offers on a blocking verdict, with `{change}`. */
  next?: string
  notes: { pattern: string; text: string }[]
}

/** Commit subject patterns; `{change}` stands for the change name. */
export type CommitHints = { artifacts?: string; task?: string; reviewFix?: string; archive?: string }

/**
 * What a board.yaml adds to an OpenSpec schema, after its check. Patterns stay strings, so
 * the value can live in the session state.
 */
export type BoardHints = {
  schema: string
  /** The board.yaml that was read, or undefined when the schema has none. */
  file?: string
  plan?: PlanHints
  design?: DesignHints
  verdicts: Record<string, VerdictHints>
  commits: CommitHints
  verifyLabel: string
  /** The agent whose report reviews the change, and the pattern of its finding lines. */
  reviewAgent?: string
  findings?: string
  skipReportAgents: string[]
  warnings: string[]
}

export type DesignView = {
  view: string
  statusText?: string
  isNeedsDesign: boolean
  hasArtifact: boolean
  /** The file a click opens in the browser, and the decision log the reader shows. */
  artifactPath?: string
  decisionsPath?: string
  screenshots: number
  approvedAt?: string
  updatedAt?: string
  revisions: number
  isInSession: boolean
}

export type CommitKind = 'artifacts' | 'task' | 'review-fix' | 'archive' | 'other'

export type Commit = {
  hash: string
  subject: string
  kind: CommitKind
  group?: string
}

/** `closes`: the issues the pull request closes, when the hints ask for them. */
export type PullRequest = { number: number; state: string; url: string; closes?: IssueRef[] }

/**
 * The host whose pull requests the board reads: `github` with `gh`. `none` when it reads none:
 * the repository's `origin` remote is not on GitHub, or `gh` is not installed.
 */
export type PrHost = 'github' | 'none'

export type Snapshot = {
  change: string
  /** The repository root the session reads (its working directory). */
  root: string
  /** The change folder, active or archived; empty in design mode. */
  dir: string
  /** The capability folders under `specs/`. */
  specs: string[]
  schema?: string
  branch?: string
  exists: boolean
  createdAt?: string
  archivedAs?: string
  artifacts: ArtifactRow[]
  isPlanningComplete: boolean
  specsCount: number
  groups: TaskGroup[]
  /** Optional: a snapshot written before this field existed survives a hot reload. */
  verdicts?: Verdict[]
  planning: PlanningItem[]
  planningNone?: string
  designs: DesignView[]
  commits: Commit[]
  pr?: PullRequest
  /**
   * The host whose pull requests the board reads; with `none`, the board shows no PR stage.
   * Optional: a snapshot written before this field existed survives a hot reload.
   */
  prHost?: PrHost
  refreshedAt: number
  warnings: string[]
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  type: string
  description: string
  phase: Phase
  change?: string
  group?: string
  task?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  usage: Usage
  totalTokens?: number
  toolUses?: number
  durationMs?: number
  isBackground: boolean
}

export type Report = {
  agentId?: string
  group: string
  task?: string
  state: string
  note?: string
  at: number
}

export type DesignRun = { view: string; mode: 'new' | 'update'; at: number }

/**
 * One `/opsx:explore` of the session: its argument, a topic or a change name, empty for
 * none, and the change the session was bound to. A run before any change moves into the
 * change that the session binds later, as its tokens do.
 */
export type ExploreRun = { topic: string; at: number; change?: string }

export type Live = {
  /**
   * `change`: the change the session was bound to after the command. Optional for older state.
   * `endedAt`: when the main turn that ran the command ended; absent while it runs.
   */
  command?: { name: string; args: string; at: number; change?: string; endedAt?: number }
  isValidateOk?: boolean
  /** When the last `openspec validate --strict` ran. */
  validateAt?: number
  /** When a main turn ended by an interrupt, an error, or a refusal. The next main turn clears it. */
  stoppedAt?: number
  reviewCounts?: Record<string, number>
  reviewAt?: number
  reviewReport?: string
  verifyVerdict?: string
  verifyReport?: string
  designRuns: DesignRun[]
  /** Optional: a session state written before this field existed survives a hot reload. */
  exploreRuns?: ExploreRun[]
}

/**
 * What the reader view of the board pane shows: a file it reads at each draw, or a text it
 * was handed. `from` is the key of the board row that opened it, where `← Board` returns.
 * `url` is the page of the text, such as a GitHub issue, which a button opens in the browser.
 * Optional: a reader value written before this field existed survives a hot reload.
 */
export type ReaderDoc = { title: string; path?: string; text?: string; from?: string; url?: string }

export type BindingSource = 'command' | 'pinned' | 'list' | 'branch' | 'pick'

export type Binding = {
  change?: string
  source?: BindingSource
  candidates: string[]
  dismissedFor?: string
}

/** The other sessions of the bound change: their tokens, their count, and the phases they spent tokens in. */
export type Others = { usage: Usage; sessions: number; activeChanges: string[]; phases?: string[] }

export type SessionFigures = { contextPercent?: number; costUsd?: number }

/** Main-loop usage: change name (or `_pre` before one is bound) → phase → usage. */
export type MainUsage = { [change: string]: { [phase: string]: Usage } }

export type Flags = { [key: string]: boolean }

declare module 'claude-code' {
  interface PluginState {
    'opsx-board': {
      binding: Binding
      snapshot: Snapshot | null
      live: Live
      agents: AgentRun[]
      main: MainUsage
      reports: Report[]
      others: Others
      figures: SessionFigures
      folded: Flags
      expanded: Flags
      reader: ReaderDoc | null
      /** The hints of the bound change's schema, else of the project's default schema. */
      hints: BoardHints | null
    }
  }
}
