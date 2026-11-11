// The `github` provider: GitHub issues as work items. The proposal section names them (`#12`,
// `owner/name#12`, or an issue URL), the branch name may name one, and the pull request may close
// more. `gh issue view` gives each one's title and state. It runs `gh --version` and
// `gh issue view` only (through ../github.ts); board.yaml chooses which issues count.
import type { GithubRef, IssueRef, ItemVia, PlanHints, PlanningItem, PullRequest } from '../../types'
import { asString, hintRegex, isRepoName, patternHint } from '../check'
import type { Check, Doc } from '../check'
import { ghError, hasGh, repoOfUrl, runGh } from '../github'
import { isListLine } from '../parse'
import type { Collected, Io, Opened, ProviderContext, WorkItemProvider } from './base'

/** How long the state of an issue stays fresh before `gh` reads it again. */
export const ISSUE_MS = 120_000
/** The most issues one change shows: each one costs a `gh` call. */
export const MAX_ISSUES = 12
/** Each warning of this provider starts with this, so a refresh can replace them. */
export const GITHUB_WARNING = 'GitHub: '

// ── the issues a line names ─────────────────────────────────────────────────

const REPO = '[A-Za-z0-9][A-Za-z0-9-]{0,38}/[\\w.-]{1,100}'
const ISSUE_URL = new RegExp(`https://github\\.com/(${REPO})/issues/(\\d{1,9})(?![\\w/])`, 'g')
// `#12` or `owner/name#12`, not inside a word, a path, a heading, an anchor such as
// `#12-notes`, or an HTML entity.
const ISSUE_REF = new RegExp(`(?<![\\w/#&.-])(?:(${REPO}))?#(\\d{1,9})(?![\\w-])`, 'g')
// A number after "PR" or "pull request" names a pull request, not an issue.
const AFTER_PULL_REQUEST = /\b(?:PRs?|pull requests?|MRs?|merge requests?)\s*$/i

/** The id the board shows for an issue: `#12`, or `owner/name#12` for another repository. */
export const issueId = (ref: IssueRef): string => `${ref.repo ?? ''}#${ref.number}`

/**
 * The GitHub issues a line names, in their order: issue URLs, `owner/name#12`, and `#12`. A
 * number after "PR" or "pull request" does not count.
 */
export const issueRefs = (text: string): IssueRef[] => {
  const found: { at: number; ref: IssueRef }[] = []
  const rest = text.replace(ISSUE_URL, (match, repo: string, number: string, at: number) => {
    found.push({ at, ref: { repo, number: Number(number) } })

    return ' '.repeat(match.length)
  })
  for (const match of rest.matchAll(ISSUE_REF)) {
    const repo = match[1]
    const at = match.index ?? 0
    if ((repo === undefined || isRepoName(repo)) && !AFTER_PULL_REQUEST.test(rest.slice(Math.max(0, at - 24), at))) {
      found.push({ at, ref: { repo, number: Number(match[2]) } })
    }
  }
  const seen = new Set<string>()

  return found
    .sort((a, b) => a.at - b.at)
    .map(item => item.ref)
    .filter(ref => ref.number > 0 && !seen.has(issueId(ref)) && seen.add(issueId(ref)) !== undefined)
}

/** The issue number a branch name holds, by the branch pattern of the ref: its first group. */
export const issueFromBranch = (branch: string | undefined, pattern: string | undefined): number | undefined => {
  const digits = branch === undefined || pattern === undefined ? undefined : hintRegex(pattern, '')?.exec(branch)?.[1]

  return digits !== undefined && /^\d{1,9}$/.test(digits) && Number(digits) > 0 ? Number(digits) : undefined
}

/** What a line says beside the one issue it names: its text without the list marker, the reference, and bold marks. */
const issueTitle = (line: string, refs: number): string =>
  refs !== 1
    ? ''
    : line
        .replace(ISSUE_URL, '')
        .replace(ISSUE_REF, '')
        .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s*(?:\[[^\]]?\]\s*)?/, '')
        .replace(/\*\*|__/g, '')
        .replace(/^[\s·—–:-]+|[\s·—–:-]+$/g, '')
        .slice(0, 120)

// ── the state of each issue, read with gh ───────────────────────────────────

type IssueInfo = { title: string; state: string; stateReason?: string; url: string }
type Fetched = { at: number; info?: IssueInfo; error?: string }

// Per session: what `gh` last gave for each issue.
const fetched = new Map<string, Fetched>()

/** The checkbox mark of an issue state: open `[ ]`, done `[x]`, closed without the work `[-]`. */
export const issueMark = (info: IssueInfo): string =>
  info.state === 'OPEN' ? ' ' : info.stateReason === 'NOT_PLANNED' || info.stateReason === 'DUPLICATE' ? '-' : 'x'

const issueUrl = (repo: string | undefined, number: number): string | undefined =>
  repo === undefined ? undefined : `https://github.com/${repo}/issues/${number}`

/** The repository arguments of a `gh issue view`: none when `gh` resolves it from the working directory. */
const repoArgs = (repo: string | undefined): string[] => (repo === undefined ? [] : ['-R', repo])

/** An issue's title and state; a fresh one comes from the cache. A failed read keeps the state it had. */
async function fetchIssue(io: Io, cwd: string, number: number, repo: string | undefined, now: number): Promise<Fetched> {
  const key = `${cwd}|${repo ?? ''}#${number}`
  const known = fetched.get(key)
  if (known !== undefined && now - known.at < ISSUE_MS) {
    return known
  }
  const ran = await runGh(io, ['issue', 'view', String(number), '--json', 'number,title,state,stateReason,url', ...repoArgs(repo)], cwd)
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

/**
 * The GitHub issues of a change, each once and in this order: those the proposal names, the
 * one the branch name holds, and those the pull request closes. An issue of the home
 * repository (the ref's `repo`, else the pull request's) shows as `#N`.
 */
export async function collectIssues(
  io: Io,
  cwd: string,
  github: GithubRef,
  proposal: readonly PlanningItem[],
  branch: string | undefined,
  pr: PullRequest | undefined,
  now: number,
): Promise<Collected> {
  const home = github.repo ?? repoOfUrl(pr?.url)
  const found: { ref: IssueRef; via: ItemVia; title: string }[] = []
  const add = (ref: IssueRef, via: ItemVia, title: string) => {
    const local = ref.repo !== undefined && ref.repo.toLowerCase() === home?.toLowerCase() ? { number: ref.number } : ref
    if (!found.some(item => issueId(item.ref) === issueId(local))) {
      found.push({ ref: local, via, title })
    }
  }
  for (const item of proposal) {
    if (item.issue !== undefined) {
      add({ repo: item.issue.repo, number: item.issue.number }, 'proposal', item.title)
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
  const isInstalled = shown.length > 0 && (await hasGh(io, cwd, now))
  if (shown.length > 0 && !isInstalled) {
    warnings.push(`${GITHUB_WARNING}gh is not installed, so the issues show no state`)
  }
  const results = await Promise.all(
    shown.map(item => (isInstalled ? fetchIssue(io, cwd, item.ref.number, item.ref.repo ?? home, now) : Promise.resolve<Fetched>({ at: now }))),
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
      provider: 'github',
      via: item.via,
      mark: info === undefined ? undefined : issueMark(info),
      issue: { ...item.ref, url: info?.url ?? issueUrl(item.ref.repo ?? home, item.ref.number), state: info?.state },
    }
  })

  return { items, warnings: [...warnings, ...[...errors].map(error => `${GITHUB_WARNING}${error}`)] }
}

// ── an issue in the reader ──────────────────────────────────────────────────

const VIA_TEXT: Record<ItemVia, string> = {
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
export async function issueDoc(io: Io, cwd: string, item: PlanningItem, home: string | undefined): Promise<{ title: string; text: string; url?: string }> {
  const issue = item.issue
  if (issue === undefined) {
    return { title: item.id, text: `${item.id} is not a GitHub issue.` }
  }
  const repo = issue.repo ?? repoOfUrl(issue.url) ?? home
  const url = issue.url ?? issueUrl(repo, issue.number)
  const fields = 'number,title,state,stateReason,url,body,author,createdAt,labels,assignees'
  const ran = await runGh(io, ['issue', 'view', String(issue.number), '--json', fields, ...repoArgs(repo)], cwd)
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
    `**${state}** · opened${opened} · ${VIA_TEXT[item.via ?? 'proposal']}`,
    [labels.length === 0 ? '' : `Labels: ${labels.join(' ')}`, assignees.length === 0 ? '' : `Assigned: ${assignees.join(', ')}`].filter(Boolean).join(' · '),
    '',
    '---',
    '',
    body === '' ? '_No description._' : body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n_… the rest is on GitHub._` : body,
  ]

  return { title: `${item.id} · ${view.title}`, text: lines.filter((line, index) => index !== 1 || line !== '').join('\n'), url: view.url || url }
}

// ── the provider ────────────────────────────────────────────────────────────

/** Whether the pull request of a change should list the issues it closes, for a github ref that counts them. */
export const isPrClosing = (plan: PlanHints | undefined): boolean =>
  plan?.refs.some(ref => ref.provider === 'github' && ref.isPrClosing) === true

export const githubProvider: WorkItemProvider<GithubRef> = {
  name: 'github',
  isMany: false,
  readsGit: true,
  warningPrefix: GITHUB_WARNING,

  /** An optional repository and branch pattern, and whether the issues the pull request closes count. */
  ref(doc: Doc, check: Check, where: string): GithubRef | undefined {
    const repo = asString(doc['repo'])
    if (repo !== undefined && !isRepoName(repo)) {
      check.warnings.push(`${where}: repo "${repo}" is not owner/name`)

      return undefined
    }
    const pr = doc['pr']
    if (pr !== undefined && typeof pr !== 'boolean') {
      check.warnings.push(`${where}: pr must be true or false`)
    }

    return { provider: 'github', repo, branch: patternHint(check, where, doc['branch']), isPrClosing: pr !== false }
  },

  /** Each list item gives the issues it names; a prose line names none, as it mentions pull requests and earlier work. */
  itemsOfLine(line: string): PlanningItem[] {
    if (!isListLine(line)) {
      return []
    }
    const refs = issueRefs(line)

    return refs.map(ref => ({ id: issueId(ref), title: issueTitle(line, refs.length), provider: 'github', via: 'proposal', issue: ref }))
  },

  files: () => [],

  collect(io: Io, proposal: readonly PlanningItem[], refs: readonly GithubRef[], context: ProviderContext): Promise<Collected> {
    const github = refs[0]

    return github === undefined
      ? Promise.resolve({ items: [], warnings: [] })
      : collectIssues(io, context.cwd, github, proposal, context.branch, context.pr, context.now)
  },

  /** The issue as `gh` reads it now, in the reader, with a button that opens its page. */
  async open(io: Io, item: PlanningItem, refs: readonly GithubRef[], context: ProviderContext): Promise<Opened> {
    return { doc: await issueDoc(io, context.cwd, item, refs[0]?.repo ?? repoOfUrl(context.pr?.url)) }
  },
}
