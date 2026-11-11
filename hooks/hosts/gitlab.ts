// GitLab as the host of the pull requests, its merge requests, read with `glab`. It runs `glab
// --version`, `glab auth status`, and `glab api` GET requests only, as an argument list with no
// shell. `:id` stands for the project of the working directory.
import type { PullRequest } from '../../types'
import type { CommitRef, Io, PrHostReader } from './base'

/** How long a failed `glab --version` stands before the board asks again. */
const GLAB_RETRY_MS = 300_000

// Per session: whether `glab` runs, and whether it is logged in to each host it was asked about.
let glabCheck: { at: number; isInstalled: boolean } | undefined
const glabHosts = new Map<string, boolean>()

async function glab(io: Io, args: readonly string[], cwd: string) {
  return io.run(['glab', ...args], cwd)
}

/** Whether `glab` runs at all. A yes stands for the session; a no is asked again after a while. */
async function hasGlab(io: Io, cwd: string, now: number): Promise<boolean> {
  if (glabCheck === undefined || (!glabCheck.isInstalled && now - glabCheck.at > GLAB_RETRY_MS)) {
    const ran = await glab(io, ['--version'], cwd)
    glabCheck = { at: now, isInstalled: ran?.exitCode === 0 }
  }

  return glabCheck.isInstalled
}

/**
 * Whether `glab` is logged in to a host whose name does not tell its kind, such as a GitLab
 * server with a name of its own. Asked once per host and session.
 */
async function isGlabHost(io: Io, cwd: string, host: string): Promise<boolean> {
  const known = glabHosts.get(host)
  if (known !== undefined) {
    return known
  }
  const ran = await glab(io, ['auth', 'status', '--hostname', host], cwd)
  const isLoggedIn = ran?.exitCode === 0
  glabHosts.set(host, isLoggedIn)

  return isLoggedIn
}

// A merge request's state in the words of a pull request. A locked one is being merged.
const STATES: Record<string, string> = { opened: 'OPEN', locked: 'OPEN', merged: 'MERGED', closed: 'CLOSED' }

/** A merge request of the GitLab API as a pull request: its `iid`, its state, and its page. */
export const fromMergeRequest = (json: unknown): PullRequest | undefined => {
  if (typeof json !== 'object' || json === null) {
    return undefined
  }
  const { iid, state, web_url: url } = json as { iid?: unknown; state?: unknown; web_url?: unknown }
  const known = typeof state === 'string' ? STATES[state] : undefined

  return typeof iid === 'number' && Number.isSafeInteger(iid) && iid > 0 && known !== undefined && typeof url === 'string' && /^https?:\/\//.test(url)
    ? { number: iid, state: known, url }
    : undefined
}

/** A GET request of the GitLab API, as JSON; undefined when `glab` fails. */
async function api(io: Io, endpoint: string, cwd: string): Promise<unknown> {
  const ran = await glab(io, ['api', endpoint], cwd)
  if (ran?.exitCode !== 0) {
    return undefined
  }
  try {
    return JSON.parse(ran.stdout) as unknown
  } catch {
    return undefined
  }
}

/** The merge request of a branch: its newest, in any state. */
async function branchMergeRequest(io: Io, cwd: string, branch: string): Promise<PullRequest | undefined> {
  if (branch === 'main' || branch === 'HEAD') {
    return undefined
  }
  const query = `source_branch=${encodeURIComponent(branch)}&order_by=created_at&sort=desc&per_page=1`
  const found = await api(io, `projects/:id/merge_requests?${query}`, cwd)

  return Array.isArray(found) ? fromMergeRequest(found[0]) : undefined
}

/**
 * The merge request of a commit, as GitLab relates them: the one that merged it, else an open
 * one, such as that of a change archived on its branch before the merge.
 */
async function commitMergeRequest(io: Io, cwd: string, hash: string): Promise<PullRequest | undefined> {
  if (!/^[0-9a-f]{40}$/.test(hash)) {
    return undefined
  }
  const found = await api(io, `projects/:id/repository/commits/${hash}/merge_requests`, cwd)
  const requests = (Array.isArray(found) ? found : []).flatMap(item => fromMergeRequest(item) ?? [])

  return requests.find(request => request.state === 'MERGED') ?? requests.find(request => request.state === 'OPEN') ?? requests[0]
}

/** A merge request by its `iid`, as `glab` reads it now. */
async function viewMergeRequest(io: Io, cwd: string, number: number): Promise<PullRequest | undefined> {
  if (!Number.isSafeInteger(number) || number < 1) {
    return undefined
  }

  return fromMergeRequest(await api(io, `projects/:id/merge_requests/${number}`, cwd))
}

export const gitlabHost: PrHostReader = {
  name: 'gitlab',
  words: { label: 'MR', name: 'merge request', title: 'Merge request', ref: number => `!${number}` },
  isInstalled: hasGlab,
  isLoggedIn: isGlabHost,
  ofBranch: (io, cwd, branch) => branchMergeRequest(io, cwd, branch),
  view: viewMergeRequest,

  /** GitLab relates a commit to its merge requests, so the commit that archived the change finds the one that archived it. */
  ofArchive: (io: Io, cwd: string, archive: CommitRef) => commitMergeRequest(io, cwd, archive.hash),
  ofCommit: (io: Io, cwd: string, commit: CommitRef) => commitMergeRequest(io, cwd, commit.hash),
}
