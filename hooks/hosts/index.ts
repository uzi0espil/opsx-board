// The code hosts whose pull requests the board reads, and how a change finds its pull request.
// This list is the only place that names them. A new host is a module that fills in the skeleton
// of ./base.ts, added to HOSTS. A host never takes `$`: it takes the Io that readPullRequest
// builds from it (see ../io.ts).
import type { EngineInterface } from 'claude-code'

import type { PrHost, PullRequest, Snapshot } from '../../types'
import { ioOf } from '../io'
import type { Io } from '../io'
import { hostKind, remoteHost } from '../parse'
import type { CommitRef, PrHostReader, PrWords } from './base'
import { githubHost } from './github'
import { gitlabHost } from './gitlab'

export type { PrHostReader, PrWords } from './base'

// In this order: a host whose name tells neither is the one whose CLI is logged in to it, the
// first of these.
const HOSTS: readonly PrHostReader[] = [githubHost, gitlabHost]

const hostNamed = (name: PrHost | undefined): PrHostReader | undefined => HOSTS.find(host => host.name === name)

/** The words for the pull request of a host. A snapshot without a host keeps the GitHub words. */
export const prWords = (host: PrHost | undefined): PrWords => (hostNamed(host) ?? githubHost).words

/**
 * The host whose pull requests the board reads, from the `origin` remote: the host its name
 * tells, GitHub or GitLab, when that host's CLI is installed. A host whose name tells neither is
 * the one whose CLI is logged in to it. None without a remote or such a CLI.
 */
async function readPrHost(io: Io, cwd: string, now: number): Promise<PrHost> {
  const ran = await io.run(['git', 'remote', 'get-url', 'origin'], cwd)
  const host = ran?.exitCode === 0 ? remoteHost(ran.stdout) : undefined
  if (host === undefined) {
    return 'none'
  }
  const kind = hostKind(host)
  if (kind !== undefined) {
    const reader = hostNamed(kind)

    return reader !== undefined && (await reader.isInstalled(io, cwd, now)) ? kind : 'none'
  }
  for (const reader of HOSTS) {
    if ((await reader.isInstalled(io, cwd, now)) && (await reader.isLoggedIn(io, cwd, host))) {
      return reader.name
    }
  }

  return 'none'
}

/** The last commit of `git log` that `args` name: its hash and its subject. */
async function lastCommit(io: Io, cwd: string, args: readonly string[]): Promise<CommitRef | undefined> {
  const log = await io.run(['git', 'log', '-1', ...args.slice(0, 1), '--format=%H%x09%s', '--', ...args.slice(1)], cwd)
  const [hash = '', subject = ''] = (log?.exitCode === 0 ? log.stdout.trim() : '').split('\t')

  return /^[0-9a-f]{40}$/.test(hash) ? { hash, subject } : undefined
}

/** The commit that added the archive folder of a change. */
const archiveCommit = (io: Io, cwd: string, archivedAs: string) => lastCommit(io, cwd, ['--diff-filter=A', `openspec/changes/archive/${archivedAs}`])

/** The last commit that added or changed a file of the active folder of a change. */
const changeCommit = (io: Io, cwd: string, change: string) => lastCommit(io, cwd, ['--diff-filter=AM', `openspec/changes/${change}`])

const isMainBranch = (branch: string | undefined): boolean => branch === 'main' || branch === 'HEAD'

// Per session: the last commit of each active change that the board asked its host about.
const askedCommits = new Map<string, string>()

/**
 * The pull request that merged a change into the main branch: the one of the last commit that
 * changed its folder, such as the squash commit of its pull request. Each commit is asked about
 * once, so a change that no pull request merged costs one read.
 */
async function changePullRequest(io: Io, cwd: string, reader: PrHostReader, change: string): Promise<PullRequest | undefined> {
  const commit = await changeCommit(io, cwd, change)
  const key = `${cwd}|${change}`
  if (commit === undefined || askedCommits.get(key) === commit.hash) {
    return undefined
  }
  askedCommits.set(key, commit.hash)

  return reader.ofCommit(io, cwd, commit)
}

export type PullRequestOptions = {
  change: string
  branch?: string
  archivedAs?: string
  isGitDue: boolean
  isPrDue: boolean
  /** Whether the pull request of the branch should list the issues it closes. */
  isPrClosing: boolean
  now: number
}

/**
 * The host of a change's pull request, and the pull request; what is not due comes from
 * `previous`. The host is read with git, so the PR stage hides from the first snapshot on, and a
 * remote added later shows. An active change reads the pull request of its branch; on the main
 * branch, the pull request of its last commit. An archived change finds the pull request that
 * merged it: the one of its archive commit, else, when a CI job archived it on the main branch
 * after the merge, the one of its last commit. A pull request no branch read finds is read again
 * while it is open.
 */
export async function readPullRequest(
  $: EngineInterface,
  cwd: string,
  previous: Pick<Snapshot, 'pr' | 'prHost'> | null,
  options: PullRequestOptions,
): Promise<Pick<Snapshot, 'pr' | 'prHost'>> {
  const { change, branch, archivedAs, isGitDue, isPrDue, isPrClosing, now } = options
  const io = ioOf($)
  const prHost = isGitDue || previous?.prHost === undefined ? await readPrHost(io, cwd, now) : previous.prHost
  const reader = hostNamed(prHost)
  let pr = previous?.pr
  if (reader === undefined) {
    return { pr, prHost }
  }
  // No branch read finds the pull request of an archived change, or of one seen from the main branch.
  const isOffBranch = archivedAs !== undefined || isMainBranch(branch)
  if (archivedAs === undefined && isPrDue && branch !== undefined) {
    pr = (await reader.ofBranch(io, cwd, branch, isPrClosing)) ?? pr
  }
  if (archivedAs !== undefined && pr === undefined && isGitDue) {
    const archive = await archiveCommit(io, cwd, archivedAs)
    pr = (archive === undefined ? undefined : await reader.ofArchive(io, cwd, archive, branch)) ?? (await changePullRequest(io, cwd, reader, change))
  } else if (archivedAs === undefined && isMainBranch(branch) && pr === undefined && isGitDue) {
    pr = await changePullRequest(io, cwd, reader, change)
  } else if (isOffBranch && pr?.state === 'OPEN' && isPrDue) {
    const viewed = await reader.view(io, cwd, pr.number)
    pr = viewed === undefined ? pr : { ...pr, ...viewed }
  }

  return { pr, prHost }
}
