// Reads what the workflow writes: the openspec CLI, the change files, the schema and its
// board.yaml hints, the files the hints name, git, and gh. Every read goes through `$`.
import type { EngineInterface } from 'claude-code'

import type { ArtifactRow, BoardHints, DesignHints, DesignRun, DesignView, PlanHints, PlanningItem, PullRequest, Snapshot, TaskGroup, Verdict } from '../types'
import { GITHUB_WARNING, closingRefs, collectIssues, hasGh } from './github'
import { classifyCommits, findMarker, parseCreated, parseDecisions, parseJson, parsePlanning, parseTasks, parseVisualDesign, readVerdict } from './parse'
import { defaultHints, inRequiresOrder, isSafeId, isSafePath, isSchemaName, readHints, readSchema, schemaNameOf } from './schema'
import type { SchemaInfo } from './schema'
import { YamlError } from './yaml'

type Engine = EngineInterface

/** The schema OpenSpec uses when neither the change nor the project names one. */
const DEFAULT_SCHEMA = 'spec-driven'
const CHANGE_MARKERS = ['.openspec.yaml', 'proposal.md', 'tasks.md']

type StatusJson = {
  schemaName?: string
  isPlanningComplete?: boolean
  isComplete?: boolean
  artifacts?: { id: string; status: string; outputPath?: string; requires?: string[]; missingDeps?: string[] }[]
  artifactPaths?: Record<string, { existingOutputPaths?: string[] }>
}

type DesignFiles = Omit<DesignView, 'statusText' | 'isNeedsDesign' | 'isInSession'>

let isWindowsHost: boolean | undefined
let isMacHost: boolean | undefined
// Per session: where each schema resolves from, and the hints read for it.
const schemaDirs = new Map<string, string | null>()
const hintsCache = new Map<string, { key: string; hints: BoardHints }>()

async function isWindows($: Engine): Promise<boolean> {
  isWindowsHost ??= (await $.env.get('OS')) === 'Windows_NT'

  return isWindowsHost
}

async function isMac($: Engine): Promise<boolean> {
  if (isMacHost === undefined) {
    const ran = await $.process.run(['uname'], { timeoutMs: 5000 }).catch(() => undefined)
    isMacHost = ran?.stdout.trim() === 'Darwin'
  }

  return isMacHost
}

// The system opener runs a program or a script as it opens a document, so a file target must
// be a document type. The schema and board.yaml come with the repository, and they name files.
const OPEN_TYPES = /\.(html?|pdf|png|jpe?g|gif|svg|webp|md|markdown|txt|ya?ml|json)$/i

/**
 * Opens a URL in the default browser, or a document file in its default app (an `.html`
 * design in the browser), with the operating system's own opener. Any other file is refused.
 */
export async function openExternal($: Engine, target: string): Promise<boolean> {
  const isUrl = /^https?:\/\//.test(target)
  if (!isUrl && !OPEN_TYPES.test(target)) {
    return false
  }
  let argv: string[]
  if (await isWindows($)) {
    argv = ['rundll32', 'url.dll,FileProtocolHandler', isUrl ? target : target.replace(/\//g, '\\')]
  } else {
    argv = [(await isMac($)) ? 'open' : 'xdg-open', target]
  }
  const ran = await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)

  return ran?.exitCode === 0
}

/** A file's text, or undefined when it cannot be read. */
export async function readFile($: Engine, path: string): Promise<string | undefined> {
  return readText($, path)
}

async function run($: Engine, argv: readonly string[], cwd: string, timeoutMs = 20_000) {
  return $.process.run(argv, { cwd, timeoutMs }).catch(() => undefined)
}

async function readText($: Engine, path: string): Promise<string | undefined> {
  return $.fs.read(path).then(
    text => (typeof text === 'string' ? text : undefined),
    () => undefined,
  )
}

async function mtime($: Engine, path: string): Promise<string> {
  return $.fs.stat(path).then(
    stat => `${stat.mtimeMs}`,
    () => '-',
  )
}

/**
 * Runs the `openspec` CLI (an npm shim, so `cmd /c` on Windows) and parses its JSON.
 * `cmd` reads `&`, `|`, `<`, `>`, `^`, and `%` as its own syntax, so an argument with any
 * character outside letters, digits, `-`, `_`, `.`, `:`, and `/` never reaches the shell.
 */
export async function openspec($: Engine, args: readonly string[], cwd: string): Promise<unknown> {
  if (args.some(arg => !/^[\w.:/-]+$/.test(arg))) {
    return undefined
  }
  const argv = (await isWindows($)) ? ['cmd', '/c', 'openspec', ...args] : ['openspec', ...args]
  const ran = await run($, argv, cwd, 30_000)

  return ran?.exitCode === 0 ? parseJson(ran.stdout) : undefined
}

export async function currentBranch($: Engine, cwd: string): Promise<string | undefined> {
  const ran = await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd)

  return ran?.exitCode === 0 ? ran.stdout.trim() : undefined
}

// ── the schema and its hints ────────────────────────────────────────────────

/** The schema of the project: `schema:` of `openspec/config.yaml`, else OpenSpec's default. */
export async function projectSchema($: Engine, cwd: string): Promise<string> {
  const config = await readText($, `${cwd}/openspec/config.yaml`)

  return (config === undefined ? undefined : schemaNameOf(config)) ?? DEFAULT_SCHEMA
}

/** The folder of a schema, as `openspec schema which` resolves it, else the project's own schemas folder. */
export async function schemaDir($: Engine, cwd: string, name: string): Promise<string | undefined> {
  if (!isSchemaName(name)) {
    return undefined
  }
  const known = schemaDirs.get(name)
  if (known !== undefined) {
    return known ?? undefined
  }
  const which = (await openspec($, ['schema', 'which', name, '--json'], cwd)) as { path?: unknown } | undefined
  let dir = typeof which?.path === 'string' ? which.path.replace(/\\/g, '/').replace(/\/+$/, '') : undefined
  if (dir === undefined) {
    const local = `${cwd}/openspec/schemas/${name}`
    dir = (await $.fs.exists(`${local}/schema.yaml`).catch(() => false)) ? local : undefined
  }
  schemaDirs.set(name, dir ?? null)

  return dir
}

async function homeDir($: Engine): Promise<string | undefined> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

  return home?.replace(/[\\/]+$/, '')
}

/** The board.yaml of a schema in the person's own folder, which wins over the one beside the schema. */
export async function userHintsPath($: Engine, schema: string): Promise<string | undefined> {
  const home = await homeDir($)

  return home === undefined || !isSchemaName(schema) ? undefined : `${home}/.claude/opsx-board/schemas/${schema}/board.yaml`
}

/**
 * The hints of a schema: the person's own board.yaml for it, else the board.yaml beside the
 * schema, else none. They are read again when either file changes.
 */
export async function loadHints($: Engine, cwd: string, schema: string): Promise<BoardHints> {
  if (!isSchemaName(schema)) {
    return defaultHints(schema)
  }
  const user = await userHintsPath($, schema)
  const dir = await schemaDir($, cwd, schema)
  const repo = dir === undefined ? undefined : `${dir}/board.yaml`
  const key = `${user === undefined ? '-' : await mtime($, user)}|${repo === undefined ? '-' : await mtime($, repo)}`
  const cached = hintsCache.get(schema)
  if (cached?.key === key) {
    return cached.hints
  }
  let hints = defaultHints(schema)
  for (const path of [user, repo]) {
    const text = path === undefined ? undefined : await readText($, path)
    if (path !== undefined && text !== undefined) {
      hints = readHints(schema, text, path)
      break
    }
  }
  hintsCache.set(schema, { key, hints })

  return hints
}

async function schemaInfo($: Engine, cwd: string, name: string): Promise<SchemaInfo | string> {
  const dir = await schemaDir($, cwd, name)
  const text = dir === undefined ? undefined : await readText($, `${dir}/schema.yaml`)
  if (text === undefined) {
    return `schema ${name} not found`
  }
  try {
    return readSchema(text) ?? `schema ${name} holds no artifacts`
  } catch (error) {
    return `schema ${name}: ${error instanceof YamlError ? error.message : 'unreadable'}`
  }
}

/** Whether a change folder holds an output: a file, or for a glob any entry under the folder before its first wildcard. */
async function hasOutput($: Engine, dir: string, generates: string): Promise<boolean> {
  if (!generates.includes('*')) {
    return $.fs.exists(`${dir}/${generates}`).catch(() => false)
  }
  const parts = generates.split('/')
  const base = parts.slice(0, parts.findIndex(part => part.includes('*'))).join('/')
  const entries = await $.fs.list(base === '' ? dir : `${dir}/${base}`).catch(() => [])

  return entries.length > 0
}

/** The artifacts of a change the CLI cannot read (an archived one): from its schema, else from its files. */
async function artifactsFromSchema($: Engine, cwd: string, dir: string, schema: string): Promise<{ rows: ArtifactRow[]; warning?: string }> {
  const info = await schemaInfo($, cwd, schema)
  if (typeof info !== 'string') {
    const rows = await Promise.all(
      info.artifacts.map(async artifact => ({
        id: artifact.id,
        status: (await hasOutput($, dir, artifact.generates)) ? 'done' : 'missing',
        outputPath: artifact.generates,
        requires: artifact.requires,
      })),
    )

    return { rows }
  }
  const entries = await $.fs.list(dir).catch(() => [])
  const rows = entries
    .filter(entry => (entry.kind === 'file' && entry.name.endsWith('.md')) || (entry.kind === 'dir' && entry.name === 'specs'))
    .map(entry => ({
      id: entry.kind === 'dir' ? entry.name : entry.name.replace(/\.md$/, ''),
      status: 'done',
      outputPath: entry.kind === 'dir' ? `${entry.name}/**/*.md` : entry.name,
    }))

  return { rows, warning: `${info}: the artifacts come from the files` }
}

// ── the change ──────────────────────────────────────────────────────────────

/**
 * A cheap fingerprint of the change: its folder (each entry's time, and each subfolder's entry
 * count), the files its hints name, the designs of the session, and the hints files.
 */
export async function signature(
  $: Engine,
  cwd: string,
  change: string,
  hints: BoardHints | null,
  designViews: readonly string[],
): Promise<string> {
  const dir = `${cwd}/openspec/changes/${change}`
  const entries = await $.fs.list(dir).catch(() => [])
  const folder = await Promise.all(
    [...entries]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async entry =>
        entry.kind === 'dir'
          ? `${entry.name}:${(await $.fs.list(`${dir}/${entry.name}`).catch(() => [])).length}`
          : `${entry.name}:${entry.mtimeMs}`,
      ),
  )
  const design = hints?.design
  const designFiles =
    design === undefined
      ? []
      : designViews
          .filter(isSafeId)
          .flatMap(view => [design.decisions, design.open].flatMap(file => (file === undefined ? [] : [`${cwd}/${designDir(design, view)}/${file}`])))
  const user = hints === null ? undefined : await userHintsPath($, hints.schema)
  const parts = await Promise.all([
    ...(hints?.plan?.sources ?? []).map(source => mtime($, `${cwd}/${source.file}`)),
    ...designFiles.map(path => mtime($, path)),
    ...[hints?.file, user].map(path => (path === undefined ? '-' : mtime($, path))),
  ])

  return [entries.length === 0 ? '-' : folder.join(','), ...parts].join('|')
}

async function findArchived($: Engine, cwd: string, change: string): Promise<string | undefined> {
  const entries = await $.fs.list(`${cwd}/openspec/changes/archive`).catch(() => [])

  return entries
    .filter(entry => entry.kind === 'dir' && /^\d{4}-\d{2}-\d{2}-/.test(entry.name) && entry.name.slice(11) === change)
    .map(entry => entry.name)
    .sort()
    .at(-1)
}

const designDir = (hints: DesignHints, view: string): string => hints.dir.replace(/\{id\}/g, view)

async function readDesign($: Engine, cwd: string, hints: DesignHints, view: string): Promise<DesignFiles> {
  const dir = `${cwd}/${designDir(hints, view)}`
  const [hasArtifact, shots, decisions] = await Promise.all([
    hints.open === undefined ? false : $.fs.exists(`${dir}/${hints.open}`).catch(() => false),
    hints.screenshots === undefined ? [] : $.fs.list(`${dir}/${hints.screenshots}`).catch(() => []),
    hints.decisions === undefined ? undefined : readText($, `${dir}/${hints.decisions}`),
  ])
  const parsed = decisions === undefined ? { revisions: 0 } : parseDecisions(decisions)

  return {
    view,
    hasArtifact,
    screenshots: shots.filter(entry => entry.name.endsWith('.png')).length,
    artifactPath: hints.open === undefined ? undefined : `${dir}/${hints.open}`,
    decisionsPath: hints.decisions === undefined || decisions === undefined ? undefined : `${dir}/${hints.decisions}`,
    ...parsed,
  }
}

/** The designs of a proposal plus the ones the design command touched this session. */
export async function collectDesigns(
  $: Engine,
  cwd: string,
  proposal: string | undefined,
  runs: readonly DesignRun[],
  hints: DesignHints | undefined,
): Promise<DesignView[]> {
  if (hints === undefined) {
    return []
  }
  const rows = proposal === undefined ? [] : parseVisualDesign(proposal, hints)
  const views = new Map<string, DesignView>()
  for (const row of rows) {
    const key = row.view ?? row.label
    const found: DesignFiles =
      row.view === undefined ? { view: key, hasArtifact: false, screenshots: 0, revisions: 0 } : await readDesign($, cwd, hints, row.view)
    views.set(key, { ...found, statusText: row.statusText, isNeedsDesign: row.isNeedsDesign, isInSession: false })
  }
  for (const designRun of runs.filter(item => isSafeId(item.view))) {
    const known = views.get(designRun.view)
    if (known) {
      known.isInSession = true
      continue
    }
    views.set(designRun.view, { ...(await readDesign($, cwd, hints, designRun.view)), isNeedsDesign: false, isInSession: true })
  }

  return [...views.values()]
}

/** The live marker of each item in the file that holds it; an item gone from the file but in its history is resolved. */
async function collectPlanning($: Engine, cwd: string, items: readonly PlanningItem[], hints: PlanHints): Promise<PlanningItem[]> {
  const texts = new Map<string, string | undefined>()
  const textOf = async (file: string | undefined) => {
    if (file === undefined) {
      return undefined
    }
    if (!texts.has(file)) {
      texts.set(file, await readText($, `${cwd}/${file}`))
    }

    return texts.get(file)
  }
  const planning: PlanningItem[] = []
  for (const item of items) {
    const source = hints.sources.find(candidate => candidate.file === item.file)
    const live = findMarker((await textOf(item.file)) ?? '', item.id)
    const history = live === undefined ? await textOf(source?.history) : undefined
    const isResolved = history !== undefined && findMarker(history, item.id) !== undefined
    planning.push({ ...item, mark: isResolved ? 'x' : live })
  }

  return planning
}

/** The verdict of each review artifact that the hints name and the change holds. */
async function collectVerdicts($: Engine, dir: string, artifacts: readonly ArtifactRow[], hints: BoardHints): Promise<Verdict[]> {
  const verdicts: Verdict[] = []
  for (const [id, verdictHints] of Object.entries(hints.verdicts)) {
    const artifact = artifacts.find(row => row.id === id)
    const output = artifact?.outputPath
    if (artifact?.status !== 'done' || output === undefined || output.includes('*')) {
      continue
    }
    const text = await readText($, `${dir}/${output}`)
    const verdict = text === undefined ? undefined : readVerdict(text, id, verdictHints)
    if (verdict !== undefined) {
      verdicts.push(verdict)
    }
  }

  return verdicts
}

/** The pull request of a branch; with `withCloses`, also the issues it closes. */
export async function fetchPullRequest($: Engine, cwd: string, branch: string, withCloses = false): Promise<PullRequest | undefined> {
  if (branch === 'main' || branch === 'HEAD') {
    return undefined
  }
  const fields = withCloses ? 'number,state,url,closingIssuesReferences' : 'number,state,url'
  const argv = ['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--json', fields, '--limit', '1']
  const ran = await run($, argv, cwd)
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
async function branchPullRequest($: Engine, cwd: string, branch: string, hash: string): Promise<PullRequest | undefined> {
  if (branch === 'main' || branch === 'HEAD') {
    return undefined
  }
  const argv = ['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url,commits', '--limit', '1']
  const ran = await run($, argv, cwd)
  try {
    const found = ran?.exitCode === 0 ? (JSON.parse(ran.stdout) as (PullRequest & { commits?: { oid?: unknown }[] })[])[0] : undefined

    return found !== undefined && (found.commits ?? []).some(commit => commit.oid === hash)
      ? { number: found.number, state: found.state, url: found.url }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The pull request that merged an archived change: the squash commit that added its archive
 * folder names it as `(#N)`, and `gh` gives that pull request's URL. In a checkout of the
 * change's own branch, the commit that added the folder has no number: the pull request of
 * the branch counts when its commits hold that commit.
 */
async function mergedPullRequest($: Engine, cwd: string, archivedAs: string, branch: string | undefined): Promise<PullRequest | undefined> {
  const path = `openspec/changes/archive/${archivedAs}`
  const log = await run($, ['git', 'log', '-1', '--diff-filter=A', '--format=%H%x09%s', '--', path], cwd)
  const [hash = '', subject = ''] = (log?.exitCode === 0 ? log.stdout.trim() : '').split('\t')
  // The last `(#N)` of the subject; a `[skip ci]` may follow it.
  const number = [...subject.matchAll(/\(#(\d+)\)/g)].at(-1)?.[1]
  if (number === undefined) {
    return branch === undefined || !/^[0-9a-f]{40}$/.test(hash) ? undefined : branchPullRequest($, cwd, branch, hash)
  }
  const ran = await run($, ['gh', 'pr', 'view', number, '--json', 'number,state,url'], cwd)
  try {
    return ran?.exitCode === 0 ? (JSON.parse(ran.stdout) as PullRequest) : undefined
  } catch {
    return undefined
  }
}

export type GitOptions = { isGitDue: boolean; isPrDue: boolean; hints: BoardHints; archivedAs?: string; now: number }

/**
 * The branch, the change's commits, and its pull request; what is not due comes from
 * `previous`. Without `gh` there is no pull request to read.
 */
export async function collectGit(
  $: Engine,
  cwd: string,
  change: string,
  previous: Snapshot | null,
  options: GitOptions,
): Promise<Pick<Snapshot, 'branch' | 'commits' | 'pr' | 'isGhMissing'>> {
  const { isGitDue, isPrDue, hints, archivedAs, now } = options
  let branch = previous?.branch
  let commits = previous?.commits ?? []
  if (isGitDue) {
    branch = await currentBranch($, cwd)
    const log = await run($, ['git', 'log', '-n', '400', '--format=%h%x09%s'], cwd)
    commits = log?.exitCode === 0 ? classifyCommits(log.stdout, change, hints.commits) : commits
  }
  let pr = previous?.pr
  // Asked once per session (see hasGh), so the PR stage hides from the first snapshot on.
  const isGhMissing = !(await hasGh($, cwd, now))
  if (isGhMissing !== true && archivedAs === undefined && isPrDue && branch !== undefined) {
    pr = (await fetchPullRequest($, cwd, branch, hints.plan?.github?.isPrClosing === true)) ?? pr
  }
  if (isGhMissing !== true && archivedAs !== undefined && pr === undefined && isGitDue) {
    pr = await mergedPullRequest($, cwd, archivedAs, branch)
  }

  return { branch, commits, pr, isGhMissing }
}

/**
 * The work items of a change: those of the files first, then its GitHub issues. `proposal`
 * holds the issues the proposal names.
 */
export async function collectWorkItems(
  $: Engine,
  cwd: string,
  fileItems: readonly PlanningItem[],
  proposal: readonly PlanningItem[],
  git: Pick<Snapshot, 'branch' | 'pr'>,
  hints: PlanHints,
  now: number,
): Promise<{ items: PlanningItem[]; warnings: string[] }> {
  const files = await collectPlanning($, cwd, fileItems, hints)
  if (hints.github === undefined) {
    return { items: files, warnings: [] }
  }
  const issues = await collectIssues($, cwd, hints.github, proposal, git.branch, git.pr, now)

  return { items: [...files, ...issues.items], warnings: issues.warnings }
}

/** The warnings of a snapshot without those of the GitHub provider, which a refresh replaces. */
export const withoutGithubWarnings = (warnings: readonly string[]): string[] => warnings.filter(warning => !warning.startsWith(GITHUB_WARNING))

// ── the tracked tasks ───────────────────────────────────────────────────────

const MAX_TRACKED = 50

/** The files under `dir` that a glob of `*`, `**`, and `?` matches, sorted, at most MAX_TRACKED. */
async function globFiles($: Engine, dir: string, glob: string): Promise<string[]> {
  const parts = glob.split('/')
  const segment = (part: string) => {
    const pattern = part
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')

    return new RegExp(`^${pattern}$`)
  }
  const out: string[] = []
  const walk = async (path: string, index: number, depth: number): Promise<void> => {
    const part = parts[index]
    if (part === undefined || out.length >= MAX_TRACKED || depth > 8) {
      return
    }
    const entries = await $.fs.list(`${dir}/${path}`.replace(/\/$/, '')).catch(() => [])
    const isLast = index === parts.length - 1
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path === '' ? entry.name : `${path}/${entry.name}`
      if (part === '**') {
        if (entry.kind === 'dir') {
          await walk(child, index, depth + 1)
        } else if (isLast) {
          out.push(child)
        }
        continue
      }
      if (!segment(part).test(entry.name)) {
        continue
      }
      if (isLast && entry.kind === 'file') {
        out.push(child)
      } else if (!isLast && entry.kind === 'dir') {
        await walk(child, index + 1, depth + 1)
      }
    }
    // `**` also matches no folder at all.
    if (part === '**') {
      await walk(path, index + 1, depth)
    }
  }
  await walk('', 0, 0)

  return [...new Set(out)].sort().slice(0, MAX_TRACKED)
}

/**
 * The task groups of the files the schema's `apply.tracks` names, a path or a glob inside the
 * change folder. A schema the board cannot read tracks `tasks.md`; one without `apply.tracks`
 * tracks no tasks, as the CLI does.
 */
async function collectTasks($: Engine, cwd: string, dir: string, schema: string): Promise<{ groups: TaskGroup[]; warning?: string }> {
  const info = await schemaInfo($, cwd, schema)
  const tracks = typeof info === 'string' ? 'tasks.md' : info.tracks
  if (tracks === undefined) {
    return { groups: [] }
  }
  // A glob stays inside the change folder as a path does: no drive, no `..`.
  if (!isSafePath(tracks.replace(/[*?]/g, 'x'))) {
    return { groups: [], warning: `apply.tracks "${tracks}" is not a path inside the change` }
  }
  const files = tracks.includes('*') || tracks.includes('?') ? await globFiles($, dir, tracks) : [tracks]
  const texts = await Promise.all(files.map(file => readText($, `${dir}/${file}`)))

  return { groups: texts.flatMap(text => (text === undefined ? [] : parseTasks(text))) }
}

export type CollectOptions = {
  runs: readonly DesignRun[]
  previous: Snapshot | null
  isGitDue: boolean
  isPrDue: boolean
  now: number
}

/** The change as its files, the CLI, and git show it, and the hints of its schema. */
export async function collectSnapshot(
  $: Engine,
  cwd: string,
  change: string,
  options: CollectOptions,
): Promise<{ snap: Snapshot; hints: BoardHints }> {
  const activeDir = `${cwd}/openspec/changes/${change}`
  const exists = (await Promise.all(CHANGE_MARKERS.map(file => $.fs.exists(`${activeDir}/${file}`).catch(() => false)))).some(Boolean)
  const archivedAs = exists ? undefined : await findArchived($, cwd, change)
  const dir = archivedAs === undefined ? activeDir : `${cwd}/openspec/changes/archive/${archivedAs}`
  const warnings: string[] = []

  const status = exists ? ((await openspec($, ['status', '--change', change, '--json'], cwd)) as StatusJson | undefined) : undefined
  const meta = await readText($, `${dir}/.openspec.yaml`)
  const schema = status?.schemaName ?? (meta === undefined ? undefined : schemaNameOf(meta)) ?? (await projectSchema($, cwd))
  const hints = await loadHints($, cwd, schema)
  if (exists && status === undefined) {
    warnings.push('openspec status failed: artifact states come from the files')
  }
  let rows: ArtifactRow[] =
    status?.artifacts?.map(artifact => ({
      id: artifact.id,
      status: artifact.status,
      outputPath: artifact.outputPath,
      requires: artifact.requires,
      missing: artifact.missingDeps,
    })) ?? []
  if (status?.artifacts === undefined && (exists || archivedAs !== undefined)) {
    const fromSchema = await artifactsFromSchema($, cwd, dir, schema)
    rows = fromSchema.rows
    if (fromSchema.warning !== undefined) {
      warnings.push(fromSchema.warning)
    }
  }
  const artifacts = inRequiresOrder(rows)
  const isPlanningComplete =
    status?.isPlanningComplete ??
    status?.isComplete ??
    (artifacts.length > 0 && artifacts.every(artifact => artifact.status === 'done' || artifact.status === 'skipped'))
  const specs = await $.fs.list(`${dir}/specs`).then(
    entries => entries.filter(entry => entry.kind === 'dir').map(entry => entry.name).sort(),
    () => [],
  )
  const specsCount = status?.artifactPaths?.['specs']?.existingOutputPaths?.length ?? specs.length

  const [tasks, proposal] = await Promise.all([collectTasks($, cwd, dir, schema), readText($, `${dir}/proposal.md`)])
  if (tasks.warning !== undefined) {
    warnings.push(tasks.warning)
  }
  const previous = options.previous?.change === change ? options.previous : null
  const git = await collectGit($, cwd, change, previous, {
    isGitDue: options.isGitDue || previous === null,
    isPrDue: options.isPrDue,
    hints,
    archivedAs,
    now: options.now,
  })
  const { branch, commits, pr } = git

  const parsedPlanning = proposal === undefined || hints.plan === undefined ? { items: [] } : parsePlanning(proposal, hints.plan)
  const work =
    hints.plan === undefined
      ? { items: [], warnings: [] }
      : await collectWorkItems(
          $,
          cwd,
          parsedPlanning.items.filter(item => item.issue === undefined),
          parsedPlanning.items.filter(item => item.issue !== undefined),
          git,
          hints.plan,
          options.now,
        )
  const planning = work.items
  const designs = await collectDesigns($, cwd, proposal, options.runs, hints.design)
  const verdicts = await collectVerdicts($, dir, artifacts, hints)

  const snap: Snapshot = {
    change,
    root: cwd,
    dir,
    specs,
    schema,
    branch,
    exists,
    createdAt: meta === undefined ? (archivedAs?.slice(0, 10) ?? undefined) : parseCreated(meta),
    archivedAs,
    artifacts,
    isPlanningComplete,
    specsCount,
    groups: tasks.groups,
    verdicts,
    planning,
    planningNone: parsedPlanning.none,
    designs,
    commits,
    pr,
    isGhMissing: git.isGhMissing,
    refreshedAt: options.now,
    warnings: [...warnings, ...hints.warnings, ...work.warnings],
  }

  return { snap, hints }
}
