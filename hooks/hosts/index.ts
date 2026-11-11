// The code hosts whose pull requests the board reads, and how a change finds its pull request.
// This list is the only place that names them. A new host is a module that fills in the skeleton
// of ./base.ts, added to HOSTS. A host never takes `$`: it takes the Io that readPullRequest
// builds from it (see ../io.ts).
import type { EngineInterface } from 'claude-code'

import type { PrHost, Snapshot } from '../../types'
import { ioOf } from '../io'
import type { Io } from '../io'
import { hostKind, remoteHost } from '../parse'
import type { ArchiveCommit, PrHostReader, PrWords } from './base'
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

/** The commit that added the archive folder of a change. */
async function archiveCommit(io: Io, cwd: string, archivedAs: string): Promise<ArchiveCommit> {
  const log = await io.run(['git', 'log', '-1', '--diff-filter=A', '--format=%H%x09%s', '--', `openspec/changes/archive/${archivedAs}`], cwd)
  const [hash = '', subject = ''] = (log?.exitCode === 0 ? log.stdout.trim() : '').split('\t')

  return { hash, subject }
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
 * remote added later shows. An active change reads the pull request of its branch. An archived
 * change finds the pull request that merged it, and reads an open one again until it closes.
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
  if (archivedAs === undefined && isPrDue && branch !== undefined) {
    pr = (await reader.ofBranch(io, cwd, branch, isPrClosing)) ?? pr
  }
  if (archivedAs !== undefined && pr === undefined && isGitDue) {
    pr = await reader.ofArchive(io, cwd, await archiveCommit(io, cwd, archivedAs), change, branch)
  } else if (archivedAs !== undefined && pr?.state === 'OPEN' && isPrDue) {
    // The change was archived on its branch before the merge: read the pull request until it closes.
    const viewed = await reader.view(io, cwd, pr.number)
    pr = viewed === undefined ? pr : { ...pr, ...viewed }
  }

  return { pr, prHost }
}
