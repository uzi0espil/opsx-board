// The GitHub provider: the state of the issues a change names, and the issues its pull request
// closes, read with `gh`. It runs `gh --version` and `gh issue view` only, as an argument list
// with no shell. board.yaml chooses which issues count; it never names a command.
import type { EngineInterface } from 'claude-code'

import type { GithubSource, IssueRef, IssueVia, PlanningItem, PullRequest } from '../types'
import { issueFromBranch, issueId } from './parse'
import { isRepoName } from './schema'

type Engine = EngineInterface

/** How long the state of an issue stays fresh before `gh` reads it again. */
export const ISSUE_MS = 120_000
/** How long a failed `gh --version` stands before the board asks again. */
const GH_RETRY_MS = 300_000
/** The most issues one change shows: each one costs a `gh` call. */
export const MAX_ISSUES = 12
/** Each warning of this provider starts with this, so a refresh can replace them. */
export const GITHUB_WARNING = 'GitHub: '

type IssueInfo = { title: string; state: string; stateReason?: string; url: string }
type Fetched = { at: number; info?: IssueInfo; error?: string }

// Per session: whether `gh` runs, and what it last gave for each issue.
let ghCheck: { at: number; isInstalled: boolean } | undefined
const fetched = new Map<string, Fetched>()

async function gh($: Engine, args: readonly string[], cwd: string) {
  return $.process.run(['gh', ...args], { cwd, timeoutMs: 20_000 }).catch(() => undefined)
}

/** Whether `gh` runs at all. A yes stands for the session; a no is asked again after a while. */
export async function hasGh($: Engine, cwd: string, now: number): Promise<boolean> {
  if (ghCheck === undefined || (!ghCheck.isInstalled && now - ghCheck.at > GH_RETRY_MS)) {
    const ran = await gh($, ['--version'], cwd)
    ghCheck = { at: now, isInstalled: ran?.exitCode === 0 }
  }

  return ghCheck.isInstalled
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

/** The checkbox mark of an issue state: open `[ ]`, done `[x]`, closed without the work `[-]`. */
export const issueMark = (info: IssueInfo): string =>
  info.state === 'OPEN' ? ' ' : info.stateReason === 'NOT_PLANNED' || info.stateReason === 'DUPLICATE' ? '-' : 'x'

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

const issueUrl = (repo: string | undefined, number: number): string | undefined =>
  repo === undefined ? undefined : `https://github.com/${repo}/issues/${number}`

/** The repository arguments of a `gh issue view`: none when `gh` resolves it from the working directory. */
const repoArgs = (repo: string | undefined): string[] => (repo === undefined ? [] : ['-R', repo])

/** An issue's title and state; a fresh one comes from the cache. A failed read keeps the state it had. */
async function fetchIssue($: Engine, cwd: string, number: number, repo: string | undefined, now: number): Promise<Fetched> {
  const key = `${cwd}|${repo ?? ''}#${number}`
  const known = fetched.get(key)
  if (known !== undefined && now - known.at < ISSUE_MS) {
    return known
  }
  const ran = await gh($, ['issue', 'view', String(number), '--json', 'number,title,state,stateReason,url', ...repoArgs(repo)], cwd)
  let entry: Fetched
  if (ran?.exitCode === 0) {
    try {
      const json = JSON.parse(ran.stdout) as Partial<IssueInfo> & { stateReason?: string | null }
      entry =
        typeof json.title === 'string' && typeof json.state === 'string' && typeof json.url === 'string'
          ? { at: now, info: { title: json.title, state: json.state, stateReason: json.stateReason ?? undefined, url: json.url } }
          : { at: now, error: 'gh gave no issue' }
    } catch {
      entry = { at: now, error: 'gh gave no JSON' }
    }
  } else {
    entry = { at: now, error: ran === undefined ? 'gh did not run' : ghError(ran.stderr) }
  }
  if (entry.info === undefined && known?.info !== undefined) {
    entry = { at: now, info: known.info }
  }
  fetched.set(key, entry)

  return entry
}

export type IssueResult = { items: PlanningItem[]; warnings: string[] }

/**
 * The GitHub issues of a change, each once and in this order: those the proposal names, the
 * one the branch name holds, and those the pull request closes. An issue of the home
 * repository (the hints' `repo`, else the pull request's) shows as `#N`.
 */
export async function collectIssues(
  $: Engine,
  cwd: string,
  github: GithubSource,
  proposal: readonly PlanningItem[],
  branch: string | undefined,
  pr: PullRequest | undefined,
  now: number,
): Promise<IssueResult> {
  const home = github.repo ?? repoOfUrl(pr?.url)
  const found: { ref: IssueRef; via: IssueVia; title: string }[] = []
  const add = (ref: IssueRef, via: IssueVia, title: string) => {
    const local = ref.repo !== undefined && ref.repo.toLowerCase() === home?.toLowerCase() ? { number: ref.number } : ref
    if (!found.some(item => issueId(item.ref) === issueId(local))) {
      found.push({ ref: local, via, title })
    }
  }
  for (const item of proposal) {
    if (item.issue !== undefined) {
      add(item.issue, 'proposal', item.title)
    }
  }
  const fromBranch = issueFromBranch(branch, github.branch)
  if (fromBranch !== undefined) {
    add({ number: fromBranch }, 'branch', '')
  }
  for (const ref of github.isPrClosing ? (pr?.closes ?? []) : []) {
    add(ref, 'pr', '')
  }
  const warnings: string[] = []
  if (found.length > MAX_ISSUES) {
    warnings.push(`${GITHUB_WARNING}the board shows the first ${MAX_ISSUES} of ${found.length} issues`)
  }
  const shown = found.slice(0, MAX_ISSUES)
  const isInstalled = shown.length > 0 && (await hasGh($, cwd, now))
  if (shown.length > 0 && !isInstalled) {
    warnings.push(`${GITHUB_WARNING}gh is not installed, so the issues show no state`)
  }
  const results = await Promise.all(
    shown.map(item => (isInstalled ? fetchIssue($, cwd, item.ref.number, item.ref.repo ?? home, now) : Promise.resolve<Fetched>({ at: now }))),
  )
  const errors = new Set<string>()
  const items = shown.map((item, index): PlanningItem => {
    const result = results[index]
    const info = result?.info
    if (info === undefined && result?.error !== undefined && result.error !== 'not found') {
      errors.add(result.error)
    }

    return {
      id: issueId(item.ref),
      title: info?.title ?? (result?.error === 'not found' ? 'not found on GitHub' : item.title),
      mark: info === undefined ? undefined : issueMark(info),
      issue: { ...item.ref, via: item.via, url: info?.url ?? issueUrl(item.ref.repo ?? home, item.ref.number), state: info?.state },
    }
  })

  return { items, warnings: [...warnings, ...[...errors].map(error => `${GITHUB_WARNING}${error}`)] }
}

const VIA_TEXT: Record<IssueVia, string> = {
  proposal: 'the proposal names it',
  branch: 'the branch name names it',
  pr: 'the pull request closes it',
}

const STATE_TEXT: Record<string, string> = { OPEN: 'Open', CLOSED: 'Closed', MERGED: 'Merged' }

type IssueView = IssueInfo & {
  body?: string
  author?: { login?: string }
  createdAt?: string
  labels?: { name?: string }[]
  assignees?: { login?: string }[]
}

const MAX_BODY = 20_000

/**
 * An issue for the reader: its state, author, labels, and assignees, then its body as markdown.
 * `gh` reads it at each open, so it is current.
 */
export async function issueDoc($: Engine, cwd: string, item: PlanningItem, home: string | undefined): Promise<{ title: string; text: string; url?: string }> {
  const issue = item.issue
  if (issue === undefined) {
    return { title: item.id, text: `${item.id} is not a GitHub issue.` }
  }
  const repo = issue.repo ?? repoOfUrl(issue.url) ?? home
  const url = issue.url ?? issueUrl(repo, issue.number)
  const fields = 'number,title,state,stateReason,url,body,author,createdAt,labels,assignees'
  const ran = await gh($, ['issue', 'view', String(issue.number), '--json', fields, ...repoArgs(repo)], cwd)
  let view: IssueView | undefined
  try {
    view = ran?.exitCode === 0 ? (JSON.parse(ran.stdout) as IssueView) : undefined
  } catch {
    view = undefined
  }
  if (view === undefined) {
    const why = ran === undefined ? 'gh did not run' : ran.exitCode === 0 ? 'gh gave no JSON' : ghError(ran.stderr)

    return { title: item.id, text: `Cannot read ${item.id} with gh: ${why}.`, url }
  }
  const state = `${STATE_TEXT[view.state] ?? view.state}${view.stateReason === 'NOT_PLANNED' ? ' (not planned)' : view.stateReason === 'DUPLICATE' ? ' (duplicate)' : ''}`
  const opened = [view.author?.login === undefined ? '' : ` by @${view.author.login}`, view.createdAt === undefined ? '' : ` on ${view.createdAt.slice(0, 10)}`].join('')
  const labels = (view.labels ?? []).flatMap(label => (label.name === undefined ? [] : [`\`${label.name}\``]))
  const assignees = (view.assignees ?? []).flatMap(person => (person.login === undefined ? [] : [`@${person.login}`]))
  const body = (view.body ?? '').trim()
  const lines = [
    `**${state}** · opened${opened} · ${VIA_TEXT[issue.via]}`,
    [labels.length === 0 ? '' : `Labels: ${labels.join(' ')}`, assignees.length === 0 ? '' : `Assigned: ${assignees.join(', ')}`].filter(Boolean).join(' · '),
    '',
    '---',
    '',
    body === '' ? '_No description._' : body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n_… the rest is on GitHub._` : body,
  ]

  return { title: `${item.id} · ${view.title}`, text: lines.filter((line, index) => index !== 1 || line !== '').join('\n'), url: view.url || url }
}

/** For the tests: the session's caches start empty. */
export const resetGithub = (): void => {
  ghCheck = undefined
  fetched.clear()
}
