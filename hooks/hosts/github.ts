// GitHub as the host of the pull requests, read with `gh` (through ../github.ts): `gh pr list`
// for the pull request of a branch, and `gh pr view` for one by its number.
import type { PullRequest } from '../../types'
import { closingRefs, hasGh, isGhHost, runGh } from '../github'
import type { CommitRef, Io, PrHostReader } from './base'

const isMainBranch = (branch: string): boolean => branch === 'main' || branch === 'HEAD'

/** The pull request of a branch; with `withCloses`, also the issues it closes. */
async function branchPullRequest(io: Io, cwd: string, branch: string, withCloses: boolean): Promise<PullRequest | undefined> {
  if (isMainBranch(branch)) {
    return undefined
  }
  const fields = withCloses ? 'number,state,url,closingIssuesReferences' : 'number,state,url'
  const ran = await runGh(io, ['pr', 'list', '--head', branch, '--state', 'all', '--json', fields, '--limit', '1'], cwd)
  if (ran?.exitCode !== 0) {
    return undefined
  }
  try {
    const found = (JSON.parse(ran.stdout) as (PullRequest & { closingIssuesReferences?: unknown })[])[0]
    if (found === undefined) {
      return undefined
    }
    const pr: PullRequest = { number: found.number, state: found.state, url: found.url }

    return withCloses ? { ...pr, closes: closingRefs(found.closingIssuesReferences) } : pr
  } catch {
    return undefined
  }
}

/**
 * The pull request of a branch whose own commits hold a commit. A branch can carry the commits
 * of more than one change, so the commit must be one of the pull request's own.
 */
async function pullRequestHolding(io: Io, cwd: string, branch: string, hash: string): Promise<PullRequest | undefined> {
  if (isMainBranch(branch)) {
    return undefined
  }
  const ran = await runGh(io, ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url,commits', '--limit', '1'], cwd)
  try {
    const found = ran?.exitCode === 0 ? (JSON.parse(ran.stdout) as (PullRequest & { commits?: { oid?: unknown }[] })[])[0] : undefined

    return found !== undefined && (found.commits ?? []).some(commit => commit.oid === hash)
      ? { number: found.number, state: found.state, url: found.url }
      : undefined
  } catch {
    return undefined
  }
}

/** The number a squash commit gives its pull request: the last `(#N)` of the subject; a `[skip ci]` may follow it. */
const squashNumber = (commit: CommitRef): number | undefined => {
  const number = [...commit.subject.matchAll(/\(#(\d+)\)/g)].at(-1)?.[1]

  return number === undefined ? undefined : Number(number)
}

/** The pull request a squash commit names. */
async function pullRequestOfSquash(io: Io, cwd: string, commit: CommitRef): Promise<PullRequest | undefined> {
  const number = squashNumber(commit)

  return number === undefined ? undefined : viewPullRequest(io, cwd, number)
}

/** A pull request by its number, as `gh` reads it now; the issues it closes stay with the caller. */
async function viewPullRequest(io: Io, cwd: string, number: number): Promise<PullRequest | undefined> {
  if (!Number.isSafeInteger(number) || number < 1) {
    return undefined
  }
  const ran = await runGh(io, ['pr', 'view', String(number), '--json', 'number,state,url'], cwd)
  try {
    return ran?.exitCode === 0 ? (JSON.parse(ran.stdout) as PullRequest) : undefined
  } catch {
    return undefined
  }
}

export const githubHost: PrHostReader = {
  name: 'github',
  words: { label: 'PR', name: 'pull request', title: 'Pull request', ref: number => `#${number}` },
  isInstalled: (io, cwd, now) => hasGh(io, cwd, now),
  isLoggedIn: (io, cwd, host) => isGhHost(io, cwd, host),
  ofBranch: branchPullRequest,
  view: viewPullRequest,

  /**
   * The squash commit that added the archive folder names its pull request as `(#N)`. In a
   * checkout of the change's own branch, the commit has no number: the pull request of the
   * branch counts when its commits hold that commit.
   */
  ofArchive(io: Io, cwd: string, archive: CommitRef, branch: string | undefined): Promise<PullRequest | undefined> {
    if (squashNumber(archive) === undefined) {
      return branch === undefined || !/^[0-9a-f]{40}$/.test(archive.hash) ? Promise.resolve(undefined) : pullRequestHolding(io, cwd, branch, archive.hash)
    }

    return pullRequestOfSquash(io, cwd, archive)
  },

  /** A squash commit names its pull request as `(#N)`. */
  ofCommit: pullRequestOfSquash,
}
