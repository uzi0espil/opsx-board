// The skeleton of a work-item provider: one source of the items of the Plan stage. Each built-in
// provider fills it in, in a module of its own, and ./index.ts lists them. A board.yaml names a
// provider and gives it its settings; it never names a command, so a provider runs only the read
// commands it holds itself.
import type { PlanningItem, PullRequest, ReaderDoc, WorkItemRef } from '../../types'
import type { Check, Doc } from '../check'
import type { Io } from '../io'

export type { Io } from '../io'

/** What a provider reads beside its own items: the repository, its branch, and its pull request. */
export type ProviderContext = { cwd: string; branch?: string; pr?: PullRequest; now: number }

/** The items of a provider as they stand now, and the warnings of their read. */
export type Collected = { items: PlanningItem[]; warnings: string[] }

/** What a click on an item shows: a text in the reader, or a page in the browser. */
export type Opened = { doc: Omit<ReaderDoc, 'from'> } | { url: string; what: string }

export interface WorkItemProvider<Ref extends WorkItemRef = WorkItemRef> {
  /** The name a `work-item` ref gives as its `provider`. */
  readonly name: Ref['provider']
  /** Whether a board.yaml may give more than one ref of this provider. */
  readonly isMany: boolean
  /** Whether a read of git (another branch, a new pull request) changes its items. */
  readonly readsGit: boolean
  /** The start of each of its warnings, so that a refresh replaces them. */
  readonly warningPrefix?: string
  /** Its ref, from a `work-item` ref of board.yaml, checked. Undefined drops the ref; a warning says why. */
  ref(doc: Doc, check: Check, where: string): Ref | undefined
  /** The items one line of the proposal section names, found via `proposal`. */
  itemsOfLine(line: string, refs: readonly Ref[]): PlanningItem[]
  /** The repository files whose edits change its items. */
  files(refs: readonly Ref[]): string[]
  /** Its items as they stand now: their state, and the items it finds beyond the proposal. */
  collect(io: Io, proposal: readonly PlanningItem[], refs: readonly Ref[], context: ProviderContext): Promise<Collected>
  /** What a click on one of its items shows. */
  open(io: Io, item: PlanningItem, refs: readonly Ref[], context: ProviderContext): Promise<Opened>
}
