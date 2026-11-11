// The `gh` CLI: whether it runs, which hosts it is logged in to, and what its errors mean. The
// PR stage and the `github` work-item provider (./providers/github.ts) read GitHub through it.
// It runs `gh` as an argument list with no shell; board.yaml never names a command.
import type { IssueRef } from '../types'
import { isRepoName } from './check'
import type { Io } from './io'

/** How long a failed `gh --version` stands before the board asks again. */
const GH_RETRY_MS = 300_000

// Per session: whether `gh` runs, and whether it is logged in to each host it was asked about.
let ghCheck: { at: number; isInstalled: boolean } | undefined
const ghHosts = new Map<string, boolean>()

/** Runs `gh` with these arguments; undefined when it cannot start. */
export async function runGh(io: Io, args: readonly string[], cwd: string) {
  return io.run(['gh', ...args], cwd)
}

/** Whether `gh` runs at all. A yes stands for the session; a no is asked again after a while. */
export async function hasGh(io: Io, cwd: string, now: number): Promise<boolean> {
  if (ghCheck === undefined || (!ghCheck.isInstalled && now - ghCheck.at > GH_RETRY_MS)) {
    const ran = await runGh(io, ['--version'], cwd)
    ghCheck = { at: now, isInstalled: ran?.exitCode === 0 }
  }

  return ghCheck.isInstalled
}

/**
 * Whether `gh` is logged in to a host whose name does not tell its kind, such as a GitHub
 * Enterprise server with a name of its own. Asked once per host and session.
 */
export async function isGhHost(io: Io, cwd: string, host: string): Promise<boolean> {
  const known = ghHosts.get(host)
  if (known !== undefined) {
    return known
  }
  const ran = await runGh(io, ['auth', 'status', '--hostname', host], cwd)
  const isLoggedIn = ran?.exitCode === 0
  ghHosts.set(host, isLoggedIn)

  return isLoggedIn
}

/** The `owner/name` of a GitHub issue or pull request URL. */
export const repoOfUrl = (url: string | undefined): string | undefined => {
  const repo = url === undefined ? undefined : /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:pull|issues)\/\d+/.exec(url)?.[1]

  return repo !== undefined && isRepoName(repo) ? repo : undefined
}

/** The `closingIssuesReferences` of `gh pr list --json`, as issue references. */
export const closingRefs = (value: unknown): IssueRef[] =>
  (Array.isArray(value) ? value : []).flatMap(item => {
    if (typeof item !== 'object' || item === null) {
      return []
    }
    const ref = item as { number?: unknown; repository?: { name?: unknown; owner?: { login?: unknown } } }
    const repo = `${String(ref.repository?.owner?.login ?? '')}/${String(ref.repository?.name ?? '')}`
    const number = ref.number

    return typeof number === 'number' && Number.isInteger(number) && number > 0 && isRepoName(repo) ? [{ repo, number }] : []
  })

/** What `gh` said when it failed, in a few words. */
export const ghError = (stderr: string): string => {
  if (/gh auth login|not logged in|authentication required|HTTP 401/i.test(stderr)) {
    return 'gh is not logged in: run gh auth login'
  }
  if (/Could not resolve to an? (?:issue|pull request)/i.test(stderr)) {
    return 'not found'
  }
  if (/none of the git remotes|no git remotes|not a git repository|could not determine (?:the )?base repo|set-default/i.test(stderr)) {
    return 'gh finds no GitHub repository here: name one with repo in board.yaml'
  }
  const line = stderr.trim().split(/\r?\n/)[0] ?? ''

  return line === '' ? 'gh failed' : `gh: ${line.slice(0, 100)}`
}

/** For the tests: the session's answers about `gh` start empty. */
export const resetGithub = (): void => {
  ghCheck = undefined
  ghHosts.clear()
}
