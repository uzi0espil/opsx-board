// The `clickup` provider: ClickUp tasks as work items. The proposal section links them
// (`https://app.clickup.com/t/<id>`), and the branch name may name one. With the `clickup` CLI
// installed and logged in, `clickup task view --json` gives each task's name and status, and a
// click shows its description in the reader. Without it, a task is a link to its page. It runs
// `clickup version` and `clickup task view` only, as an argument list with no shell; board.yaml
// chooses which tasks count.
import type { ClickupRef, ItemVia, PlanningItem } from '../../types'
import { hintRegex, isSafeId, patternHint } from '../check'
import type { Check, Doc } from '../check'
import { isListLine } from '../parse'
import type { Collected, Io, Opened, ProviderContext, WorkItemProvider } from './base'

/** How long the state of a task stays fresh before `clickup` reads it again. */
export const TASK_MS = 120_000
/** The most tasks one change shows. */
export const MAX_TASKS = 12
/** How long a failed `clickup version` stands before the board asks again. */
const CLICKUP_RETRY_MS = 300_000
/** Each warning of this provider starts with this, so a refresh can replace them. */
export const CLICKUP_WARNING = 'ClickUp: '

// ── the tasks a line links ──────────────────────────────────────────────────

// A task page: `https://app.clickup.com/t/<id>`, or `/t/<workspace>/<id>` for a custom task id.
const TASK_URL = /https:\/\/app\.clickup\.com\/t\/(?:\d+\/)?([A-Za-z0-9][\w-]{0,63})(?![\w/-])/g
const TASK_LINK = /\[[^\]]*\]\(https:\/\/app\.clickup\.com\/t\/[^)\s]*\)/g

/** The page of a ClickUp task. */
export const taskUrl = (id: string): string => `https://app.clickup.com/t/${id}`

/** The ClickUp tasks a line links, in their order and each once. */
export const taskRefs = (text: string): string[] => [
  ...new Set([...text.matchAll(TASK_URL)].flatMap(match => (match[1] === undefined || !isSafeId(match[1]) ? [] : [match[1]]))),
]

/** What a line says beside the one task it links: its text without the list marker, the link, and bold marks. */
const taskTitle = (line: string, tasks: number): string =>
  tasks !== 1
    ? ''
    : line
        .replace(TASK_LINK, '')
        .replace(TASK_URL, '')
        .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s*(?:\[[^\]]?\]\s*)?/, '')
        .replace(/\*\*|__/g, '')
        .replace(/^[\s·—–:-]+|[\s·—–:-]+$/g, '')
        .slice(0, 120)

/** The ClickUp task a branch name holds, by the branch pattern of the ref: its first group. */
export const taskFromBranch = (branch: string | undefined, pattern: string | undefined): string | undefined => {
  const id = branch === undefined || pattern === undefined ? undefined : hintRegex(pattern, '')?.exec(branch)?.[1]

  return id !== undefined && isSafeId(id) ? id : undefined
}

const taskItem = (id: string, title: string, via: ItemVia): PlanningItem => ({ id, title, provider: 'clickup', via, task: { url: taskUrl(id) } })

// ── the state of each task, read with clickup ───────────────────────────────

type TaskInfo = { name: string; status: string; type: string; url: string }
type Fetched = { at: number; info?: TaskInfo }

// Per session: whether `clickup` runs, and what it last gave for each task.
let clickupCheck: { at: number; isInstalled: boolean } | undefined
const fetched = new Map<string, Fetched>()

async function clickup(io: Io, args: readonly string[], cwd: string) {
  return io.run(['clickup', ...args], cwd)
}

/** Whether `clickup` runs at all. A yes stands for the session; a no is asked again after a while. */
async function hasClickup(io: Io, cwd: string, now: number): Promise<boolean> {
  if (clickupCheck === undefined || (!clickupCheck.isInstalled && now - clickupCheck.at > CLICKUP_RETRY_MS)) {
    const ran = await clickup(io, ['version'], cwd)
    clickupCheck = { at: now, isInstalled: ran?.exitCode === 0 }
  }

  return clickupCheck.isInstalled
}

/**
 * The checkbox mark of a task status, by its type: not started `[ ]`, in progress `[~]`, done or
 * closed `[x]`. A workspace names its statuses; the row shows the name beside the mark.
 */
export const taskMark = (type: string): string => (type === 'open' ? ' ' : type === 'custom' ? '~' : 'x')

/** A task of `clickup task view --json` as the board keeps it; anything else is none. */
export const taskInfo = (json: unknown): (TaskInfo & { id: string }) | undefined => {
  if (typeof json !== 'object' || json === null) {
    return undefined
  }
  const { id, name, status, url } = json as { id?: unknown; name?: unknown; status?: { status?: unknown; type?: unknown }; url?: unknown }
  const text = status?.status
  const type = status?.type

  return typeof id === 'string' && typeof name === 'string' && typeof text === 'string' && typeof type === 'string' && typeof url === 'string' && /^https:\/\//.test(url)
    ? { id, name, status: text, type, url }
    : undefined
}

/** What `clickup` said when it failed, in a few words. */
export const clickupError = (stderr: string, exitCode: number): string => {
  if (exitCode === 4 || /authentication required|auth login/i.test(stderr)) {
    return 'clickup is not logged in: run clickup auth login'
  }
  const line = stderr.trim().split(/\r?\n/)[0] ?? ''

  return line === '' ? 'clickup failed' : `clickup: ${line.slice(0, 100)}`
}

/**
 * The state of the tasks: a fresh one from the cache, the stale ones from one `clickup task view`,
 * which skips a task it cannot read. A failed read keeps the state a task had.
 */
async function fetchTasks(io: Io, cwd: string, ids: readonly string[], now: number): Promise<{ infos: Map<string, TaskInfo>; error?: string }> {
  const key = (id: string) => `${cwd}|${id}`
  const stale = ids.filter(id => {
    const known = fetched.get(key(id))

    return known === undefined || now - known.at >= TASK_MS
  })
  let error: string | undefined
  if (stale.length > 0) {
    const ran = await clickup(io, ['task', 'view', ...stale, '--json'], cwd)
    const read = new Map<string, TaskInfo>()
    if (ran?.exitCode === 0) {
      try {
        const json = JSON.parse(ran.stdout) as unknown
        for (const item of Array.isArray(json) ? json : [json]) {
          const info = taskInfo(item)
          if (info !== undefined) {
            read.set(info.id, { name: info.name, status: info.status, type: info.type, url: info.url })
          }
        }
      } catch {
        error = 'clickup gave no JSON'
      }
    } else if (ran === undefined) {
      error = 'clickup did not run'
    } else if (!/failed to fetch task/i.test(ran.stderr)) {
      // One task it cannot read (not found, or of another workspace) is no failure of the CLI.
      error = clickupError(ran.stderr, ran.exitCode)
    }
    for (const id of stale) {
      fetched.set(key(id), { at: now, info: read.get(id) ?? fetched.get(key(id))?.info })
    }
  }
  const infos = new Map<string, TaskInfo>()
  for (const id of ids) {
    const info = fetched.get(key(id))?.info
    if (info !== undefined) {
      infos.set(id, info)
    }
  }

  return { infos, error }
}

// ── a task in the reader ────────────────────────────────────────────────────

const VIA_TEXT: Record<ItemVia, string> = {
  proposal: 'the proposal links it',
  branch: 'the branch name names it',
  pr: 'the pull request names it',
}

const MAX_BODY = 20_000

type TaskView = TaskInfo & {
  markdown_description?: string
  list?: { name?: string }
  priority?: { priority?: string } | null
  creator?: { username?: string }
  assignees?: { username?: string }[]
  date_created?: string
}

/** A task for the reader: its status, list, priority, author, and assignees, then its description as markdown. */
const taskDoc = (item: PlanningItem, view: TaskView): { title: string; text: string; url: string } => {
  const created = Number(view.date_created)
  const head = [
    `**${view.status}**`,
    view.list?.name,
    view.priority?.priority === undefined ? undefined : `priority ${view.priority.priority}`,
    `opened${view.creator?.username === undefined ? '' : ` by ${view.creator.username}`}${Number.isFinite(created) && created > 0 ? ` on ${new Date(created).toISOString().slice(0, 10)}` : ''}`,
    VIA_TEXT[item.via ?? 'proposal'],
  ]
  const assignees = (view.assignees ?? []).flatMap(person => (person.username === undefined ? [] : [person.username]))
  const body = (view.markdown_description ?? '').trim()
  const lines = [
    head.filter((part): part is string => part !== undefined && part !== '').join(' · '),
    assignees.length === 0 ? '' : `Assigned: ${assignees.join(', ')}`,
    '',
    '---',
    '',
    body === '' ? '_No description._' : body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n_… the rest is on ClickUp._` : body,
  ]

  return { title: `${item.id} · ${view.name}`, text: lines.filter((line, index) => index !== 1 || line !== '').join('\n'), url: view.url }
}

// ── the provider ────────────────────────────────────────────────────────────

/** The items with the task of the branch after the others, unless the proposal links it already. */
const withBranchTask = (items: readonly PlanningItem[], branch: string | undefined, ref: ClickupRef | undefined): PlanningItem[] => {
  const rest = items.filter(item => item.via !== 'branch')
  const id = taskFromBranch(branch, ref?.branch)

  return id === undefined || rest.some(item => item.id === id) ? rest : [...rest, taskItem(id, '', 'branch')]
}

export const clickupProvider: WorkItemProvider<ClickupRef> = {
  name: 'clickup',
  isMany: false,
  readsGit: true,
  warningPrefix: CLICKUP_WARNING,

  /** An optional branch pattern, whose first group is a task id. */
  ref(doc: Doc, check: Check, where: string): ClickupRef {
    return { provider: 'clickup', branch: patternHint(check, where, doc['branch']) }
  },

  /** Each list item gives the tasks it links; a prose line names none. */
  itemsOfLine(line: string): PlanningItem[] {
    if (!isListLine(line)) {
      return []
    }
    const ids = taskRefs(line)

    return ids.map(id => taskItem(id, taskTitle(line, ids.length), 'proposal'))
  },

  files: () => [],

  /**
   * The tasks the proposal links, then the one the branch names. With `clickup`, each gets its
   * name, its status, and a mark; without it, each is a link.
   */
  async collect(io: Io, proposal: readonly PlanningItem[], refs: readonly ClickupRef[], context: ProviderContext): Promise<Collected> {
    const items = withBranchTask(proposal, context.branch, refs[0])
    const warnings: string[] = []
    if (items.length > MAX_TASKS) {
      warnings.push(`${CLICKUP_WARNING}the board shows the first ${MAX_TASKS} of ${items.length} tasks`)
    }
    const shown = items.slice(0, MAX_TASKS)
    if (shown.length === 0) {
      return { items: [], warnings }
    }
    const asLinks = () => shown.map(item => ({ ...item, mark: undefined, note: undefined, isLink: true }))
    if (!(await hasClickup(io, context.cwd, context.now))) {
      return { items: asLinks(), warnings }
    }
    const { infos, error } = await fetchTasks(
      io,
      context.cwd,
      shown.map(item => item.id),
      context.now,
    )
    if (error !== undefined) {
      warnings.push(`${CLICKUP_WARNING}${error}`)
    }
    if (infos.size === 0 && error !== undefined) {
      return { items: asLinks(), warnings }
    }

    return {
      items: shown.map(item => {
        const info = infos.get(item.id)

        return info === undefined
          ? { ...item, isLink: undefined }
          : { ...item, title: info.name, mark: taskMark(info.type), note: info.status, task: { url: info.url }, isLink: undefined }
      }),
      warnings,
    }
  },

  /** The task as `clickup` reads it now, in the reader; without `clickup`, its page in the browser. */
  async open(io: Io, item: PlanningItem, _refs: readonly ClickupRef[], context: ProviderContext): Promise<Opened> {
    const url = item.task?.url ?? taskUrl(item.id)
    const link: Opened = { url, what: `ClickUp task ${item.id}` }
    if (!isSafeId(item.id) || !(await hasClickup(io, context.cwd, context.now))) {
      return link
    }
    const ran = await clickup(io, ['task', 'view', item.id, '--json'], context.cwd)
    if (ran?.exitCode !== 0) {
      return link
    }
    try {
      const json = JSON.parse(ran.stdout) as unknown
      const view = (Array.isArray(json) ? json[0] : json) as TaskView
      const info = taskInfo(view)

      return info === undefined ? link : { doc: taskDoc(item, { ...view, ...info }) }
    } catch {
      return link
    }
  },
}
