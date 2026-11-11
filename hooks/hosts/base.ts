// The skeleton of a code host whose pull requests the board reads with its CLI: GitHub with `gh`,
// GitLab with `glab`. Each host fills it in, in a module of its own, and ./index.ts lists them.
// A host takes Io, never `$` (see ../io.ts): it is called through an object.
import type { PrHost, PullRequest } from '../../types'
import type { Io } from '../io'

export type { Io } from '../io'

/** The words for the pull request of a host. GitLab calls it a merge request, MR, and numbers it `!N`. */
export type PrWords = {
  label: 'PR' | 'MR'
  name: 'pull request' | 'merge request'
  /** The name at the start of a sentence. */
  title: 'Pull request' | 'Merge request'
  ref: (number: number) => string
}

/** A commit: its hash and its subject. */
export type CommitRef = { hash: string; subject: string }

export interface PrHostReader {
  /** The host, as the snapshot names it. */
  readonly name: Exclude<PrHost, 'none'>
  readonly words: PrWords
  /** Whether its CLI runs. */
  isInstalled(io: Io, cwd: string, now: number): Promise<boolean>
  /** Whether its CLI is logged in to a host whose name does not tell its kind. */
  isLoggedIn(io: Io, cwd: string, host: string): Promise<boolean>
  /** The pull request of a branch; with `withCloses`, also the issues it closes. */
  ofBranch(io: Io, cwd: string, branch: string, withCloses: boolean): Promise<PullRequest | undefined>
  /** A pull request by its number, as the CLI reads it now. */
  view(io: Io, cwd: string, number: number): Promise<PullRequest | undefined>
  /** The pull request that merged an archived change, from the commit that archived it. */
  ofArchive(io: Io, cwd: string, archive: CommitRef, branch: string | undefined): Promise<PullRequest | undefined>
  /** The pull request a commit of the main branch came with. */
  ofCommit(io: Io, cwd: string, commit: CommitRef): Promise<PullRequest | undefined>
}
