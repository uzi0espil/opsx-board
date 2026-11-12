import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  ARCH_REVIEW_MD,
  DECISIONS_MD,
  GIT_LOG,
  GITHUB_BOARD_YAML,
  GITHUB_ISSUES,
  GITHUB_PROPOSAL_MD,
  GITHUB_PRS,
  OPENSPEC_YAML,
  PROPOSAL_MD,
  DEMO_BOARD_YAML,
  GATED_SCHEMA_YAML,
  REVIEW_REPORT,
  BACKLOG_MD,
  SPEC_DRIVEN_STATUS_JSON,
  STATUS_JSON,
  TASKS_MD,
  TEAM_SCHEMA_YAML,
} from './fixtures'
import { MOVED_MARK, projectKey, projectLedgers } from '../hooks/ledger'

const CWD = '/repo'
const ARCHIVE_HASH = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const CHANGE = `${CWD}/openspec/changes/demo-change`
// The ledger folder of the project at CWD.
const LEDGERS = projectLedgers('/home/me/.claude/opsx-board', CWD)

/** A ledger file of another session, with `input` tokens in its apply phase. */
const ledgerText = (change: string, sessionId: string, input: number) =>
  JSON.stringify({ change, sessionId, updatedAt: 1, main: { apply: { input, output: 0, cacheRead: 0, cacheWrite: 0 } }, agents: [] })


const PANE = {
  plugin: 'opsx-board',
  component: 'Pane',
  requestId: 'opsx-board',
  props: {
    title: 'OpenSpec board',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type World = {
  files: Map<string, string>
  writes: Map<string, string>
  viewed: string[]
  /** Set, the engine refuses to show the agent, with this reason. */
  viewDeny?: string
  /** The repository root `$.session.repo()` gives; null outside a repository. */
  repoRoot: string | null
  toasts: string[]
  tools: string[]
  statuses: (string | undefined)[]
  opened: string[]
  closed: string[]
  panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[]
  runs: string[]
  branch: string
  log: string
  prs: string
  /** The `openspec status --json` output of each active change the CLI knows. */
  status: Record<string, unknown>
  /** Set, `gh` is not installed: the process cannot start. */
  isGhMissing: boolean
  /** What `gh issue view` gives, by `<repo>#<N>`; a string fails with that stderr. */
  issues: Record<string, object | string>
  /** The commit (`%H<tab>%s`) that added the archive folder of csv-import. */
  archiveLog: string
  /** The commit that added another archive folder, by the folder's name. */
  archiveLogs: Record<string, string>
  /** What `gh pr view <N>` gives, by number; #226 is merged unless this names it. */
  prViews: Record<number, object>
  /** The URL of the `origin` remote; undefined for a repository without one. */
  remote: string | undefined
  /** The hosts `gh auth status --hostname` finds a login for. */
  ghHosts: string[]
  /** Set, `glab` is not installed: the process cannot start. */
  isGlabMissing: boolean
  /** The hosts `glab auth status --hostname` finds a login for. */
  glabHosts: string[]
  /** What `glab api` gives for the merge requests of a branch. */
  mrs: string
  /** What `glab api` gives for one merge request, by `iid`. */
  mrViews: Record<number, object>
  /** What `glab api` gives for the merge requests of a commit, by its hash; none unless this names it. */
  commitMrs: Record<string, object[]>
  /** The last commit that added or changed a file of a change's active folder, by the change's name. */
  activeLogs: Record<string, string>
  /** Set, `clickup` is not installed: the process cannot start. */
  isClickupMissing: boolean
  /** Set, `clickup` is installed but not logged in. */
  isClickupLoggedOut: boolean
  /** What `clickup task view <id> --json` gives, by task id; a task it lacks, it cannot read. */
  clickupTasks: Record<string, object>
}

/** A merge request as the GitLab API gives it. */
const mergeRequest = (iid: number, state: string) => ({
  iid,
  state,
  title: 'CSV export',
  source_branch: 'host-change',
  web_url: `https://gitlab.example.com/o/r/-/merge_requests/${iid}`,
})

// The engine hands a hook the path as the host resolves it (`C:\repo\...` on Windows).
const norm = (path: string): string =>
  path
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:(?=\/)/, '')
    .replace(/\/+/g, '/')

// A file's time is its length, as `fs.stat` gives it: an edit that changes the length shows.
const dirEntry = (name: string, kind: 'file' | 'dir', mtimeMs = 1) => ({ name, kind, size: 1, mtimeMs, isLink: false })

/** A repository in memory, the openspec and git CLIs, and the engine calls the board makes. */
function world(on: On, files: Record<string, string>, branch = 'worktree-demo-change'): World {
  const state: World = {
    files: new Map(Object.entries(files).map(([path, text]) => [norm(path), text])),
    writes: new Map(),
    viewed: [],
    repoRoot: CWD,
    toasts: [],
    tools: [],
    statuses: [],
    opened: [],
    closed: [],
    panes: [],
    runs: [],
    branch,
    log: GIT_LOG,
    prs: '[{"number":227,"state":"OPEN","url":"https://github.com/o/r/pull/227"}]',
    status: { 'demo-change': STATUS_JSON },
    isGhMissing: false,
    issues: GITHUB_ISSUES,
    archiveLog: `${ARCHIVE_HASH}\tfeat(import): CSV import of a library (WI-7) (#226) [skip ci]\n`,
    archiveLogs: {},
    prViews: {},
    remote: 'https://github.com/o/r.git',
    ghHosts: ['github.com'],
    isGlabMissing: false,
    glabHosts: ['gitlab.com'],
    mrs: JSON.stringify([mergeRequest(12, 'opened')]),
    mrViews: {},
    commitMrs: {},
    activeLogs: {},
    isClickupMissing: false,
    isClickupLoggedOut: false,
    clickupTasks: {},
  }
  const listDir = (path: string) => {
    const base = `${norm(path).replace(/\/$/, '')}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const file of state.files.keys()) {
      if (file.startsWith(base)) {
        const rest = file.slice(base.length)
        const name = rest.split('/')[0] ?? ''
        names.set(name, rest.includes('/') ? 'dir' : 'file')
      }
    }

    return [...names].map(([name, kind]) => dirEntry(name, kind, kind === 'file' ? (state.files.get(`${base}${name}`) ?? '').length : 1))
  }
  const isDir = (path: string) => listDir(path).length > 0

  mock.env(on, { HOME: '/home/me' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'sess-1' }))
  on('session.id', () => ({ value: 'sess-1' }))
  // The repository of the session: the main working tree's root, also from a worktree.
  on('session.repo', () => ({ value: state.repoRoot === null ? null : { root: state.repoRoot, remote: null, internal: false, name: null } }))
  on('command.register', () => ({ value: { command: 'opsx-board' } }))
  on('tool.register', (_, e) => {
    state.tools.push(e.name)

    return { value: { tool: `mcp__opsx-board__${e.name}` } }
  })
  on('ui.open', (_, e) => {
    state.opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    state.closed.push(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: state.panes }))
  on('ui.status', (_, e) => {
    state.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.view', (_, e) => {
    if (state.viewDeny !== undefined) {
      return { value: { deny: state.viewDeny } }
    }
    state.viewed.push(e.agentId ?? 'main')

    return { value: {} }
  })
  on('agent.list', () => ({ value: [] }))
  on('fs.read', (_, e) => {
    const text = state.files.get(norm(e.path))

    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    state.writes.set(norm(e.path), e.text)

    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: state.files.has(norm(e.path)) || isDir(e.path) }))
  on('fs.stat', (_, e) =>
    state.files.has(norm(e.path)) || isDir(e.path)
      ? { value: { kind: isDir(e.path) ? ('dir' as const) : ('file' as const), size: 1, mtimeMs: (state.files.get(norm(e.path)) ?? '').length, isLink: false } }
      : { deny: `ENOENT ${e.path}` },
  )
  on('fs.list', (_, e) => (isDir(e.path) ? { value: listDir(e.path) } : { deny: `ENOENT ${e.path}` }))
  on('process.run', (_, e) => {
    const command = e.argv.join(' ')
    state.runs.push(command)
    const ran = (stdout: string, exitCode = 0, stderr = '') => ({
      value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'gh' && state.isGhMissing) {
      return { deny: 'spawn gh ENOENT' }
    }
    if (command === 'gh --version') {
      return ran('gh version 2.101.0 (2026-09-15)\n')
    }
    const login = /^gh auth status --hostname ([\w.-]+)$/.exec(command)
    if (login) {
      return state.ghHosts.includes(login[1] ?? '') ? ran('') : ran('', 1, `You are not logged into any accounts on ${login[1]}`)
    }
    if (e.argv[0] === 'glab' && state.isGlabMissing) {
      return { deny: 'spawn glab ENOENT' }
    }
    if (command === 'glab --version') {
      return ran('glab 1.80.0 (2026-09-01)\n')
    }
    const glabLogin = /^glab auth status --hostname ([\w.-]+)$/.exec(command)
    if (glabLogin) {
      return state.glabHosts.includes(glabLogin[1] ?? '') ? ran('') : ran('', 1, `x ${glabLogin[1]} has not been authenticated with glab.`)
    }
    if (/^glab api projects\/:id\/merge_requests\?source_branch=[^&\s]+&order_by=created_at&sort=desc&per_page=1$/.test(command)) {
      return ran(state.mrs)
    }
    const mrView = /^glab api projects\/:id\/merge_requests\/(\d+)$/.exec(command)
    if (mrView) {
      const found = state.mrViews[Number(mrView[1])]

      return found === undefined ? ran('', 1, 'glab: 404 Not Found') : ran(JSON.stringify(found))
    }
    const commitMrs = /^glab api projects\/:id\/repository\/commits\/([0-9a-f]{40})\/merge_requests$/.exec(command)
    if (commitMrs) {
      return ran(JSON.stringify(state.commitMrs[commitMrs[1] ?? ''] ?? []))
    }
    if (e.argv[0] === 'clickup' && state.isClickupMissing) {
      return { deny: 'spawn clickup ENOENT' }
    }
    if (command === 'clickup version') {
      return ran('clickup version 0.39.0\n')
    }
    // As the CLI does: an array for several ids, without the ones it cannot read; one id it cannot read fails.
    const viewed = /^clickup task view ([\w -]+) --json$/.exec(command)
    if (viewed) {
      if (state.isClickupLoggedOut) {
        return ran('', 4, "authentication required. Run 'clickup auth login' to authenticate")
      }
      const ids = (viewed[1] ?? '').split(' ')
      const found = ids.flatMap(id => (state.clickupTasks[id] === undefined ? [] : [state.clickupTasks[id]]))
      if (ids.length === 1) {
        return found[0] === undefined ? ran('', 1, `failed to fetch task ${ids[0]}: ClickUp API error (HTTP 401)`) : ran(JSON.stringify(found[0]))
      }

      return ran(JSON.stringify(found))
    }
    const changed = /^git log -1 --diff-filter=AM --format=%H%x09%s -- openspec\/changes\/([\w-]+)$/.exec(command)
    if (changed) {
      return ran(state.activeLogs[changed[1] ?? ''] ?? '')
    }
    if (command === 'git remote get-url origin') {
      return state.remote === undefined ? ran('', 2, "error: No such remote 'origin'") : ran(`${state.remote}\n`)
    }
    // gh resolves a bare number to the repository of the working directory, here o/r.
    const issue = /^gh issue view (\d+) --json ([\w,]+)(?: -R ([\w./-]+))?$/.exec(command)
    if (issue) {
      const found = state.issues[`${issue[3] ?? 'o/r'}#${issue[1]}`]
      if (found === undefined || typeof found === 'string') {
        return ran('', 1, found ?? `GraphQL: Could not resolve to an issue or pull request with the number of ${issue[1]}.`)
      }
      const fields = (issue[2] ?? '').split(',')

      return ran(JSON.stringify(Object.fromEntries(Object.entries(found).filter(([key]) => fields.includes(key)))))
    }
    const status = /^openspec status --change ([\w-]+) --json$/.exec(command)
    if (status) {
      const json = state.status[status[1] ?? '']

      return json === undefined ? ran('', 1) : ran(JSON.stringify(json))
    }
    // A project schema resolves to its folder, a package schema to the package's folder.
    const which = /^openspec schema which ([\w.-]+) --json$/.exec(command)
    if (which) {
      const root = norm(e.init?.cwd ?? CWD)
      const dir = [`${root}/openspec/schemas/${which[1]}`, `/pkg/schemas/${which[1]}`].find(path => state.files.has(`${path}/schema.yaml`))

      return dir === undefined
        ? ran('', 1)
        : ran(`Note: Schema commands are experimental and may change.\n${JSON.stringify({ name: which[1], path: dir })}`)
    }
    if (command === 'git rev-parse --abbrev-ref HEAD') {
      return ran(`${state.branch}\n`)
    }
    if (command.startsWith('git log -n')) {
      return ran(state.log)
    }
    if (command.startsWith('xdg-open ')) {
      return ran('')
    }
    const added = /^git log -1 --diff-filter=A --format=%H%x09%s -- openspec\/changes\/archive\/([\w-]+)$/.exec(command)
    if (added) {
      return added[1] === '2026-10-22-csv-import' ? ran(state.archiveLog) : ran(state.archiveLogs[added[1] ?? ''] ?? '')
    }
    const view = /^gh pr view (\d+) --json number,state,url$/.exec(command)
    if (view) {
      const number = Number(view[1])
      const found = state.prViews[number] ?? (number === 226 ? { number: 226, state: 'MERGED', url: 'https://github.com/o/r/pull/226' } : undefined)

      return found === undefined ? ran('', 1) : ran(JSON.stringify(found))
    }
    if (command.startsWith('gh pr list')) {
      return ran(state.prs)
    }

    return ran('', 1)
  })

  return state
}

const DEMO_FILES: Record<string, string> = {
  [`${CWD}/openspec/config.yaml`]: 'schema: gated-spec-driven\n',
  [`${CWD}/openspec/schemas/gated-spec-driven/schema.yaml`]: GATED_SCHEMA_YAML,
  [`${CWD}/openspec/schemas/gated-spec-driven/board.yaml`]: DEMO_BOARD_YAML,
  [`${CHANGE}/.openspec.yaml`]: OPENSPEC_YAML,
  [`${CHANGE}/proposal.md`]: PROPOSAL_MD,
  [`${CHANGE}/arch-review.md`]: ARCH_REVIEW_MD,
  [`${CHANGE}/design.md`]: '# Design\n',
  [`${CHANGE}/tasks.md`]: TASKS_MD,
  [`${CHANGE}/specs/csv-export/spec.md`]: '## ADDED Requirements\n',
  [`${CWD}/openspec/changes/archive/2026-10-22-csv-import/proposal.md`]: '## Why\n',
  [`${CWD}/docs/backlog.md`]: BACKLOG_MD,
  [`${CWD}/docs/bugs.md`]: '# Bugs\n',
  [`${CWD}/designs/export-dialog/artifact.html`]: '<html></html>',
  [`${CWD}/designs/export-dialog/decisions.md`]: DECISIONS_MD,
  [`${CWD}/designs/export-dialog/screenshots/desktop-1280.png`]: 'png',
}

/** The files of a repository under another root, such as a worktree's folder. */
const rooted = (files: Record<string, string>, root: string): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([path, text]) => [path.startsWith(`${CWD}/`) ? `${root}${path.slice(CWD.length)}` : path, text]))

/** `openspec archive`: the folder of demo-change moves into the archive, and the CLI no longer knows it. */
function archive(state: World, root: string, name: string): void {
  const active = `${root}/openspec/changes/demo-change`
  for (const [path, text] of [...state.files]) {
    if (path.startsWith(`${active}/`)) {
      state.files.delete(path)
      state.files.set(path.replace(active, `${root}/openspec/changes/archive/${name}`), text)
    }
  }
  delete state.status['demo-change']
}

const USAGE = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 500 }

/** A slash command as the person types it at the prompt. */
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 200 },
})

/** An Agent call of the main loop, as the engine raises its spawn. */
const spawn = (subagentType: string, description: string, prompt: string) => ({
  tool_use_id: `toolu-${subagentType}`,
  prompt,
  description,
  subagentType,
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
})

describe('opsx-board', () => {
  test('the pane shows the stages, the design update, and the task groups', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    world(on, DEMO_FILES)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /^gated-spec-driven/ }))?.text).toBe('gated-spec-driven · worktree-demo-change')
      expect((await ui.find({ type: 'Text', text: /Apply 4\/9/ }))?.text).toBe(' ▶  Apply 4/9 ')
      expect((await ui.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toBe(
        '✔  Plan › –  Explore › ✖  Design › ✔  Propose ›  ▶  Apply  › ○  Review › ○  PR › ○  Archive',
      )
      // Propose is done, so it is folded; its header still carries the verdict.
      expect((await ui.find({ type: 'Text', text: /^5\/5 artifacts/ }))?.text).toBe('5/5 artifacts · REQUIRES-ADR')
      expect(await ui.find({ key: 'artifact:arch-review' })).toBeUndefined()
      await ui.press({ key: 'fold:propose' })
      expect((await ui.find({ key: 'artifact:arch-review' }))?.text).toContain('REQUIRES-ADR (ADR not created yet)')
      expect((await ui.find({ key: 'design:export-dialog' }))?.text).toContain('needs an update (approved 2026-10-11, updated 2026-10-13)')
      expect((await ui.find({ key: 'group:0' }))?.text).toContain('3/3')
      expect((await ui.find({ key: 'group:1' }))?.text).toContain('a1b2c3d')
      expect((await ui.find({ key: 'group:2' }))?.text).toContain('0/3')
      // Four of nine tasks are done and nothing runs: Next goes on to the next stage.
      expect((await ui.find({ key: 'next' }))?.text).toContain('/opsx:verify demo-change')
      expect((await ui.find({ type: 'Text', text: /^fills the prompt/ }))?.text).toContain('4 of 9 tasks done')
      // The fold state is the session's, so fold Propose again for the next surface.
      await ui.press({ key: 'fold:propose' })
      await ui.unmount()
    }
  })

  test('a running group shows its agent, its tokens, and the reported task; the row folds, the agent cell opens the agent', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES)
    on('command.run', () => ({ text: '' }))
    on('skill.prompt', (_, e) => ({ text: e.text }))
    on('turn.complete', () => ({ text: '' }))
    on('turn.step', async function* (_, e) {
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: [],
        stopReason: 'end_turn' as const,
        usage: { ...USAGE, model: 'claude-opus-5-5' },
      }
    })
    let spawnedPrompt = ''
    on('agent.spawn', (_, e) => {
      spawnedPrompt = e.prompt

      return { model: 'claude-opus-5-5', agentId: 'agent-2' }
    })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    // The main agent's progress note rides on the command as hidden context.
    const applied = await $.command.run(typed('opsx:apply', 'demo-change'))
    expect(applied.context?.at(-1)).toContain('call `mcp__opsx-board__progress`')
    expect(applied.context?.at(-1)).toContain('OpenSpec change `demo-change`')
    await clock.advance(300)

    await $.agent.spawn(
      spawn('general-purpose', 'Implement group 2', 'Implement task group 2 of demo-change: the CSV writer in `export-service`.'),
    )
    expect(spawnedPrompt).toContain('mcp__opsx-board__progress')
    await $.tool.call({ tool: 'mcp__opsx-board__progress', group: '2', task: '2.2', state: 'start', agentId: 'agent-2' })
    await clock.advance(1000)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // The agent sits in a cell of its own, a press target apart from the row.
    expect((await ui.find({ key: 'group:2' }))?.text).toContain('The CSV writer')
    expect((await ui.find({ key: 'group:2' }))?.text).not.toContain('general-purpose')
    expect((await ui.find({ key: 'group-agent:2' }))?.text).toContain('general-purpose')
    // The reported task carries its agent; its text is clipped to the row.
    const folded = (await ui.find({ key: 'task:2.2' }))?.text ?? ''
    expect(folded).toContain('2.2 Add the streaming writer')
    expect(folded).toContain('← general-purpose')
    expect(folded).toContain('…')
    // C: the row joins a hover group; the card of that group floats above the row, hidden until then.
    // (The kit reports no `hover` props: hovering stays in the surface. A tree the engine refused would not draw.)
    const cardBox = await ui.find({ type: 'Box', text: /^ Add the streaming writer/ })
    expect(cardBox?.props).toMatchObject({ position: 'absolute', display: 'none', left: 10 })
    // Above its row: a floating Box paints over what comes before it, so nothing later covers it.
    expect(Number((cardBox?.props as { top?: number } | undefined)?.top)).toBeLessThan(0)
    // Its lines are padded to the card's width.
    const card = (await ui.find({ type: 'Text', text: /^ Add the streaming writer/ }))?.text ?? ''
    expect(card.replace(/\s+/g, ' ')).toContain('independent of the page size of the client.')
    expect(card.split('\n').length).toBeGreaterThan(1)
    expect(card.split('\n').every(line => line.length === card.split('\n')[0]?.length)).toBe(true)
    // A: a click unfolds it in place; the card goes, the rest of the text wraps under the row.
    await ui.press({ key: 'task:2.2' })
    expect((await ui.find({ key: 'task:2.2' }))?.text).not.toContain('…')
    expect(await ui.find({ type: 'Text', text: /^ Add the streaming writer/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /page size of the client\.$/ }))?.text).toBeDefined()
    await ui.press({ key: 'task:2.2' })
    expect((await ui.find({ key: 'task:2.2' }))?.text).toContain('…')
    // The row folds and unfolds its tasks, and opens no agent.
    await ui.press({ key: 'group:2' })
    expect(await ui.find({ key: 'task:2.2' })).toBeUndefined()
    await ui.press({ key: 'group:2' })
    expect(await ui.find({ key: 'task:2.2' })).toBeDefined()
    expect(state.viewed).toEqual([])
    // The agent cell opens the agent, and leaves the tasks as they are.
    await ui.press({ key: 'group-agent:2' })
    expect(state.viewed).toEqual(['agent-2'])
    expect(await ui.find({ key: 'task:2.2' })).toBeDefined()
    // A refused view says why, and folds nothing.
    state.viewDeny = 'that agent has ended'
    await ui.press({ key: 'group-agent:2' })
    expect(state.toasts).toContain('Cannot open the general-purpose session: that agent has ended')
    expect(await ui.find({ key: 'task:2.2' })).toBeDefined()
    state.viewDeny = undefined

    // While the agent's session is in view, the header names the agent and offers the way back.
    expect(await ui.find({ key: 'main-session' })).toBeUndefined()
    await ui.redraw({ ...PANE.props, view: { agentId: 'agent-2' } })
    expect(await ui.find({ type: 'Text', text: /viewing general-purpose/ })).toBeDefined()
    expect((await ui.find({ key: 'main-session' }))?.props).toMatchObject({ hotkey: 'm' })
    await ui.press({ key: 'main-session' })
    expect(state.viewed).toEqual(['agent-2', 'main'])
    // A refused switch says why.
    state.viewDeny = 'the view moved meanwhile'
    await ui.press({ key: 'main-session' })
    expect(state.toasts).toContain('Cannot show the main session: the view moved meanwhile')
    state.viewDeny = undefined
    // The engine draws the pane again for the main session: the button goes, however the view
    // came back.
    await ui.redraw({ ...PANE.props, view: {} })
    expect(await ui.find({ key: 'main-session' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /viewing general-purpose/ })).toBeUndefined()

    // A finished model request of the agent counts at once; its turn's end adds only what the steps missed.
    for await (const chunk of $.turn.step({ turnId: 't-2', index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId: 'agent-2' })) {
      void chunk
    }
    await clock.advance(10)
    expect((await ui.find({ key: 'group-agent:2' }))?.text).toContain('general-purpose 44k')

    await $.turn.complete({
      answer: 'Done.',
      durationMs: 250_000,
      isAborted: false,
      turnId: 't-2',
      agentId: 'agent-2',
      usage: { ...USAGE, model: 'claude-opus-5-5' },
      reason: 'answer',
    })
    await clock.advance(10)
    expect(state.toasts.some(text => text.startsWith('Group 2 agent finished · 44k tokens'))).toBe(true)
    expect((await ui.find({ key: 'agent:agent-2' }))?.text).toContain('44k')
    await ui.unmount()
  })

  test('a pane seated inline in a narrow terminal seats itself again, docked, once the terminal widens', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES)
    on('command.run', () => ({ text: '' }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const inline = { ...PANE, props: { ...PANE.props, placement: 'inline' as const } }
    const seat = async (viewport: { columns: number; rows: number; isFullscreen?: boolean }) => {
      const pane = await $.ui.mount({ ...inline, surface: 'terminal', viewport })
      await clock.advance(100)
      await pane.unmount()
    }

    // Narrow, or on the main screen where every pane is inline, the pane stays where it is.
    await seat({ columns: 90, rows: 40, isFullscreen: true })
    await seat({ columns: 180, rows: 40, isFullscreen: false })
    expect(state.closed).toEqual([])

    // Wide in fullscreen: the board closes its pane and opens it again, and the engine docks it.
    const opened = state.opened.length
    await seat({ columns: 160, rows: 40, isFullscreen: true })
    expect(state.closed).toEqual(['opsx-board'])
    expect(state.opened.slice(opened)).toEqual(['opsx-board'])
    // A close of its own is no dismissal: the pane still opens by itself on a workflow command.
    const before = state.opened.length
    await $.command.run(typed('opsx:apply', 'demo-change'))
    await clock.advance(300)
    expect(state.opened.slice(before)).toContain('opsx-board')

    // Kept inline at that width, it does not try again; at another width it does.
    await seat({ columns: 160, rows: 40, isFullscreen: true })
    expect(state.closed).toHaveLength(1)
    await seat({ columns: 200, rows: 40, isFullscreen: true })
    expect(state.closed).toHaveLength(2)
  })

  test('a main-loop turn counts under the phase, and the ledger file is per session', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES)
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.turn.complete({
      answer: 'ok',
      durationMs: 1000,
      isAborted: false,
      turnId: 't-1',
      usage: { ...USAGE, model: 'claude-opus-5-5' },
      reason: 'answer',
    })
    await clock.advance(6000)
    const ledger = state.writes.get(`${LEDGERS}/demo-change/sess-1.json`)
    expect(ledger).toBeDefined()
    expect(JSON.parse(ledger ?? '{}').main).toEqual({ apply: { input: 1000, output: 2000, cacheRead: 40_000, cacheWrite: 500 } })
    expect(JSON.parse(ledger ?? '{}').root).toBe(CWD)
  })

  test("the ledgers are per project: another project's change of the same name and its active changes stay out", async ($, on) => {
    // A file's time is its length, so near zero every seeded ledger is recent.
    const clock = mock.clock(on, { now: 60_000 })
    const elsewhere = projectLedgers('/home/me/.claude/opsx-board', '/elsewhere')
    world(on, {
      ...DEMO_FILES,
      // Other sessions of this project: on the same change, and on another one.
      [`${LEDGERS}/demo-change/sess-2.json`]: ledgerText('demo-change', 'sess-2', 7000),
      [`${LEDGERS}/other-change/sess-3.json`]: ledgerText('other-change', 'sess-3', 1),
      // Another project: a change of the same name, and one of its own.
      [`${elsewhere}/demo-change/sess-4.json`]: ledgerText('demo-change', 'sess-4', 900_000),
      [`${elsewhere}/phase11-exit-drift/sess-5.json`]: ledgerText('phase11-exit-drift', 'sess-5', 1),
    })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(31_000)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ type: 'Text', text: /tok on this change/ }))?.text).toContain('7.0k tok on this change (+1 other sessions)')
    expect((await board.find({ type: 'Text', text: /^also active:/ }))?.text).toBe('also active: other-change')
    await board.unmount()
  })

  test('a worktree keeps the ledgers of its repository; outside git, the folder is the project', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const worktree = `${CWD}/.claude/worktrees/demo`
    const state = world(on, rooted(DEMO_FILES, worktree), 'demo-change')
    on('session.cwd', () => ({ value: worktree }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: worktree, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const turn = { answer: 'ok', durationMs: 1, isAborted: false, usage: { ...USAGE, model: 'm' }, reason: 'answer' as const }
    await $.turn.complete({ ...turn, turnId: 't-1' })
    await clock.advance(6000)
    expect(state.writes.get(`${LEDGERS}/demo-change/sess-1.json`)).toBeDefined()

    // Without a repository, the session's folder names the project.
    state.repoRoot = null
    await $.session.start({ cwd: worktree, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.turn.complete({ ...turn, turnId: 't-2' })
    await clock.advance(6000)
    expect(state.writes.get(`${projectLedgers('/home/me/.claude/opsx-board', worktree)}/demo-change/sess-1.json`)).toBeDefined()
    expect(projectKey(worktree)).toMatch(/^demo-[0-9a-f]{8}$/)
    expect(projectKey('E:\\Dev\\Demo')).toBe(projectKey('e:/dev/demo/'))
  })

  test('the old shared ledgers of a change move into the first project that shows it, and only once', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const old = '/home/me/.claude/opsx-board/ledgers'
    const text = ledgerText('demo-change', 'sess-0', 5000)
    const state = world(on, {
      ...DEMO_FILES,
      [`${old}/demo-change/sess-0.json`]: text,
      [`${old}/other-change/sess-9.json`]: ledgerText('other-change', 'sess-9', 1),
    })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(31_000)
    expect(state.writes.get(`${LEDGERS}/demo-change/sess-0.json`)).toBe(text)
    expect(state.writes.get(`${old}/demo-change/${MOVED_MARK}`)).toContain(CWD)
    // The project does not hold the other change, so its old ledgers stay where they are.
    expect([...state.writes.keys()].some(path => path.includes('other-change'))).toBe(false)

    // A folder another project took is left alone.
    state.writes.clear()
    state.files.set(`${old}/demo-change/${MOVED_MARK}`, 'moved')
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(31_000)
    expect(state.writes.has(`${LEDGERS}/demo-change/sess-0.json`)).toBe(false)
  })

  test('the spec-reviewer report becomes finding counts', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES)
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'review-1' }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.agent.spawn(spawn('spec-reviewer', 'Review demo-change', 'Review the implementation of OpenSpec change `demo-change`.'))
    await $.turn.complete({ answer: REVIEW_REPORT, durationMs: 1000, isAborted: false, turnId: 't-r', agentId: 'review-1', reason: 'answer' })
    expect(state.toasts).toContain('spec-reviewer: 1 MISSING, 1 DIVERGED, 1 PRACTICE')

    // The review row opens the report in the reader view of the board pane.
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await board.press({ key: 'review' })
    expect((await board.find({ key: 'doc' }))?.text).toContain('MISSING: The writer refuses an empty column name')
    await board.unmount()
  })

  test('design mode before any change, then the proposal takes over the tokens', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const files = Object.fromEntries(Object.entries(DEMO_FILES).filter(([path]) => !path.startsWith(CHANGE)))
    const state = world(on, files)
    on('command.run', () => ({ text: '' }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('designer', 'update export-dialog'))
    await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't-d', usage: { ...USAGE, model: 'm' }, reason: 'answer' })
    await clock.advance(4500)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Design mode/ }))?.text).toBe('Design mode: no change yet.')
    // The view is approved, but the session still designs it: Design stays active until the next step.
    expect((await ui.find({ key: 'design:export-dialog' }))?.text).toContain('approved 2026-10-11 · in review')
    expect((await ui.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toContain('›  ▶  Design  › ○  Propose')
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:propose')
    await ui.unmount()

    for (const [path, text] of Object.entries(DEMO_FILES)) {
      state.files.set(norm(path), text)
    }
    await $.command.run(typed('opsx:propose', 'demo-change'))
    // The ledger writes at most once per 5 s, and the `_pre` write has just happened.
    await clock.advance(12_000)
    const ledger = JSON.parse(state.writes.get(`${LEDGERS}/demo-change/sess-1.json`) ?? '{}')
    expect(ledger.main?.design).toEqual({ input: 1000, output: 2000, cacheRead: 40_000, cacheWrite: 500 })
  })

  test('Propose and Design stay in review until the next step starts', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, {
      ...DEMO_FILES,
      [`${CHANGE}/proposal.md`]: PROPOSAL_MD.replace(/## Visual Design[\s\S]*?(?=## Impact)/, ''),
      [`${CHANGE}/tasks.md`]: TASKS_MD.replace(/- \[[x~]\]/g, '- [ ]'),
    })
    // The branch already has a pull request. That is no sign that the change applies.
    state.log = ''
    on('command.run', () => ({ text: '' }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'Error: 2 requirements fail', isError: true }))
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await $.command.run(typed('opsx-board', ''))
    await clock.advance(300)
    const rail = async () => (await ui.find({ type: 'Text', text: /Plan .* Archive/ }))?.text
    const why = async () => (await ui.find({ type: 'Text', text: /^fills the prompt/ }))?.text
    const endTurn = (turnId: string, reason: 'answer' | 'aborted' = 'answer', agentId?: string) =>
      $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId, agentId, reason })

    // Every artifact is written, and no apply has started: the person still reviews them.
    // While the turn of the design command runs, Design is in progress, and Next waits.
    await $.command.run(typed('designer', 'update export-dialog'))
    await clock.advance(300)
    expect(await ui.find({ key: 'next' })).toBeUndefined()
    await endTurn('t-d')
    await clock.advance(300)
    expect(await rail()).toContain('▶  Design ›  ▶  Propose  › ○  Apply')
    expect((await ui.find({ key: 'design:export-dialog' }))?.text).toContain('approved 2026-10-11 · in review')
    expect((await ui.find({ type: 'Text', text: /Propose in review/ }))?.text).toBe(' ▶  Propose in review ')
    expect((await ui.find({ type: 'Text', text: /^5\/5 artifacts/ }))?.text).toBe('5/5 artifacts · in review · REQUIRES-ADR')
    expect(await ui.find({ key: 'artifact:arch-review' })).toBeDefined()
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:apply demo-change')
    expect(await why()).toContain('Apply when their review is over')
    expect(state.statuses.at(-1)).toBe('opsx demo-change · Propose in review')

    // A revision of the artifacts is the next step after the design, but Propose is still open.
    await $.command.run(typed('opsx:update', 'demo-change'))
    await clock.advance(300)
    expect(await rail()).toContain('✔  Design ›  ▶  Propose  › ○  Apply')
    expect((await ui.find({ key: 'design:export-dialog' }))?.text).not.toContain('in review')

    // Apply starts: Propose is done, and the run needs no hint to start again.
    await $.command.run(typed('opsx:apply', 'demo-change'))
    await clock.advance(300)
    expect(await rail()).toContain('✔  Propose ›  ▶  Apply  ›')
    expect(await ui.find({ key: 'next' })).toBeUndefined()
    expect(state.statuses.at(-1)).toBe('opsx demo-change · Apply 0/9')
    await $.agent.spawn(spawn('general-purpose', 'Implement group 2', 'Implement task group 2.'))

    // An interrupt stops the apply run, but its agent still works: Next waits for the agent.
    await endTurn('t-a', 'aborted')
    await clock.advance(300)
    expect(await ui.find({ key: 'next' })).toBeUndefined()
    // Once the agent ends too, Next offers to apply again.
    await endTurn('t-g', 'answer', 'agent-1')
    await clock.advance(300)
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:apply demo-change')
    expect(await why()).toContain('the apply run stopped')

    // The next main turn, such as the person's next prompt, goes on with the run: no hint,
    // also after that turn ends.
    await $.turn.start({ text: 'Go on with group 2.', turnId: 't-b' })
    await clock.advance(300)
    expect(await ui.find({ key: 'next' })).toBeUndefined()
    await endTurn('t-b')
    await clock.advance(300)
    expect(await ui.find({ key: 'next' })).toBeUndefined()

    // The strict validation at the start of the next run refuses the change: the review goes on,
    // and Next shows once the turn of the command ends.
    await clock.advance(6000)
    await $.command.run(typed('opsx:apply', 'demo-change'))
    await $.tool.call({ tool: 'Bash', command: 'openspec validate demo-change --strict' })
    await clock.advance(300)
    expect(await ui.find({ key: 'next' })).toBeUndefined()
    await endTurn('t-v')
    await clock.advance(300)
    expect(await rail()).toContain('✔  Design ›  ▶  Propose  › ○  Apply')
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:apply demo-change')
    expect(await why()).toContain('openspec validate --strict refused the change')
    await ui.unmount()
  })

  test('a task left [~] does not hold back the archive after the pull request', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    world(on, { ...DEMO_FILES, [`${CHANGE}/tasks.md`]: TASKS_MD.replace(/- \[ \]/g, '- [x]') })
    on('command.run', () => ({ text: '' }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('opsx:apply', 'demo-change'))
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't-a', reason: 'answer' })
    await $.command.run(typed('opsx-board', ''))
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // Task 1.2 stays [~] for the owner, and the pull request exists: the run is over.
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:archive demo-change')
    expect((await ui.find({ type: 'Text', text: /^fills the prompt/ }))?.text).toBe('fills the prompt · the pull request is open; 8 of 9 tasks done')
    await ui.unmount()
  })

  test('rows open their target: artifacts and planning items in the reader, the design and the PR in the browser', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const files = { ...DEMO_FILES, [`${CHANGE}/specs/csv-export/spec.md`]: '## ADDED Requirements\n\n### Requirement: CSV export\n' }
    const state = world(on, files)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(4500)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })

    // Propose is folded once done; open it, then the proposal.
    await board.press({ key: 'fold:propose' })
    await board.press({ key: 'artifact:proposal' })
    // The reader is a view of the board pane, not a pane of its own: no tab can hide it, and
    // no width floor of an unasked pane can hold it back.
    expect(state.opened.filter(id => id !== 'opsx-board')).toEqual([])
    expect((await board.find({ key: 'doc' }))?.text).toContain('## Planning Items')
    expect((await board.find({ type: 'Text', text: /proposal\.md$/ }))?.text).toContain('/repo/openspec/changes/demo-change/proposal.md')
    expect(await board.find({ key: 'artifact:tasks' })).toBeUndefined()
    expect((await board.find({ key: 'back' }))?.props).toMatchObject({ hotkey: 'b' })
    // The reader offers the way back to the main session too, while an agent is in view.
    expect(await board.find({ key: 'main-session' })).toBeUndefined()
    await board.redraw({ ...PANE.props, view: { agentId: 'agent-1' } })
    expect(await board.find({ key: 'main-session' })).toBeDefined()
    expect(await board.find({ key: 'doc' })).toBeDefined()
    await board.redraw({ ...PANE.props, view: {} })
    expect(await board.find({ key: 'main-session' })).toBeUndefined()

    // Back shows the board again.
    await board.press({ key: 'back' })
    expect(await board.find({ key: 'doc' })).toBeUndefined()
    expect(await board.find({ key: 'artifact:tasks' })).toBeDefined()

    // A second document opens in place, as the first did.
    await board.press({ key: 'artifact:tasks' })
    expect((await board.find({ key: 'doc' }))?.text).toContain('## 2. The CSV writer')
    await board.press({ key: 'back' })

    // The specs row lists the spec files; one opens in the reader.
    expect(await board.find({ key: 'spec:csv-export' })).toBeUndefined()
    await board.press({ key: 'artifact:specs' })
    await board.press({ key: 'spec:csv-export' })
    expect((await board.find({ key: 'doc' }))?.text).toContain('### Requirement: CSV export')
    await board.press({ key: 'back' })

    // A planning item shows its block of the roadmap.
    await board.press({ key: 'fold:plan' })
    await board.press({ key: 'plan:WI-12' })
    expect((await board.find({ key: 'doc' }))?.text).toContain('**WI-12 · CSV export')
    await board.press({ key: 'back' })

    // The design opens its artifact.html, and the pull request its URL, with the system opener.
    await board.press({ key: 'design:export-dialog' })
    expect(state.runs.at(-1)).toBe('xdg-open /repo/designs/export-dialog/artifact.html')
    await board.press({ key: 'pr' })
    expect(state.runs.at(-1)).toBe('xdg-open https://github.com/o/r/pull/227')
    expect(state.toasts).toContain('Opened pull request #227')
    await board.unmount()
  })

  test('the reader view leaves the board after a close or the board command', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(4500)

    for (const surface of ['terminal', 'desktop'] as const) {
      const board = await $.ui.mount({ ...PANE, surface })
      await board.press({ key: 'fold:propose' })
      await board.press({ key: 'artifact:proposal' })
      expect((await board.find({ key: 'doc' }))?.text).toContain('## Planning Items')
      // The pane closes while it shows a document: it opens on the board again.
      // (A test cannot raise the person's own close; that path clears the reader as this one does.)
      await $.command.run(typed('opsx-board', 'close'))
      expect(state.closed.at(-1)).toBe('opsx-board')
      expect(await board.find({ key: 'doc' })).toBeUndefined()
      expect(await board.find({ key: 'artifact:proposal' })).toBeDefined()

      // The board command shows the board, also from the reader view.
      await board.press({ key: 'artifact:proposal' })
      expect((await board.find({ key: 'doc' }))?.text).toContain('## Planning Items')
      await $.command.run(typed('opsx-board', ''))
      expect(await board.find({ key: 'doc' })).toBeUndefined()
      await board.press({ key: 'fold:propose' })
      await board.unmount()
    }
  })

  test('a pinned archived change finds the pull request that merged it', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES, 'main')
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('opsx-board', 'csv-import'))
    await clock.advance(300)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toContain('✔  PR › ✔  Archive')
    expect((await board.find({ key: 'pr' }))?.text).toContain('#226 merged')
    await board.press({ key: 'pr' })
    expect(state.runs.at(-1)).toBe('xdg-open https://github.com/o/r/pull/226')
    await board.unmount()
  })

  test("an archived change seen from its own branch: the branch's pull request, when its commits hold the archive commit", async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES, 'csv-import')
    // On the branch, the commit that archived the change has no pull request number yet.
    state.archiveLog = `${ARCHIVE_HASH}\tdocs(csv-import): archive change\n`
    state.prs = JSON.stringify([{ number: 230, state: 'MERGED', url: 'https://github.com/o/r/pull/230', commits: [{ oid: 'a1' }, { oid: ARCHIVE_HASH }] }])
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('opsx-board', 'csv-import'))
    await clock.advance(300)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ key: 'pr' }))?.text).toContain('#230 merged')
    expect(state.runs).toContain('gh pr list --head csv-import --state all --json number,state,url,commits --limit 1')
    await board.unmount()
  })

  test('an archived change keeps no pull request of its branch that does not hold its archive commit', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    // A branch of another change: an older change archived by a commit without a number.
    const state = world(on, DEMO_FILES, 'worktree-demo-change')
    state.archiveLog = `${ARCHIVE_HASH}\tdocs(csv-import): archive change\n`
    state.prs = JSON.stringify([{ number: 231, state: 'OPEN', url: 'https://github.com/o/r/pull/231', commits: [{ oid: 'b2' }] }])
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('opsx-board', 'csv-import'))
    await clock.advance(300)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toContain('–  PR › ✔  Archive')
    expect((await board.find({ key: 'pr' }))?.text).not.toContain('#231')
    await board.unmount()
  })

  test('a change archived on its branch reads its open pull request again until the merge', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES, 'demo-change')
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    // The work on the branch makes the pull request due once a minute.
    await clock.advance(65_000)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ key: 'pr' }))?.text).toContain('#227 open')

    archive(state, CWD, '2026-10-22-demo-change')
    await clock.advance(4500)
    expect((await board.find({ type: 'Text', text: /archived/ }))?.text).toBe(' ✔  archived ')
    expect((await board.find({ key: 'pr' }))?.text).toContain('#227 open')

    // The merge: the next read of the pull request sees it.
    state.prViews[227] = { number: 227, state: 'MERGED', url: 'https://github.com/o/r/pull/227' }
    await clock.advance(65_000)
    expect((await board.find({ key: 'pr' }))?.text).toContain('#227 merged')
    expect(state.toasts).toContain('demo-change archived')

    // A merged pull request is not read again.
    const isView = (run: string) => run === 'gh pr view 227 --json number,state,url'
    const reads = state.runs.filter(isView).length
    await clock.advance(5 * 60_000)
    expect(state.runs.filter(isView)).toHaveLength(reads)
    await board.unmount()
  })

  test('an edit in the archive folder of a change shows', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES, 'main')
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    archive(state, CWD, '2026-10-22-demo-change')
    await clock.advance(4500)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await board.press({ key: 'fold:apply' })
    expect((await board.find({ key: 'group:2' }))?.text).toContain('0/3')

    // Two tasks are checked after the archive, each with a note.
    const tasks = `${CWD}/openspec/changes/archive/2026-10-22-demo-change/tasks.md`
    state.files.set(tasks, (state.files.get(tasks) ?? '').replace('- [ ] 2.1', '- [x] 2.1 (owner)').replace('- [ ] 2.2', '- [x] 2.2 (owner)'))
    await clock.advance(4500)
    expect((await board.find({ key: 'group:2' }))?.text).toContain('2/3')
    await board.unmount()
  })

  test('the session leaves a worktree it removed: the board follows it to the archive in the main checkout', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const worktree = `${CWD}/.claude/worktrees/demo`
    const state = world(on, rooted(DEMO_FILES, worktree), 'demo-change')
    let here = worktree
    on('session.cwd', () => ({ value: here }))
    await $.session.start({ cwd: worktree, surface: 'terminal', isInteractive: true })
    await clock.advance(65_000)
    archive(state, worktree, '2026-10-22-demo-change')
    await clock.advance(4500)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ type: 'Text', text: /^gated-spec-driven/ }))?.text).toBe('gated-spec-driven · demo-change')
    expect((await board.find({ type: 'Text', text: /archived/ }))?.text).toBe(' ✔  archived ')

    // The worktree goes, and the session is back in the main checkout, before its pull.
    for (const path of [...state.files.keys()]) {
      if (path.startsWith(`${worktree}/`)) {
        state.files.delete(path)
      }
    }
    for (const [path, text] of Object.entries(DEMO_FILES)) {
      if (!path.startsWith(`${CHANGE}/`)) {
        state.files.set(path, text)
      }
    }
    state.branch = 'main'
    here = CWD
    await clock.advance(4500)
    expect((await board.find({ type: 'Text', text: /^fills the prompt/ }))?.text).toContain('no change folder yet')

    // The pull brings the archive, with the squash commit that names the pull request.
    for (const [path, text] of Object.entries(DEMO_FILES)) {
      if (path.startsWith(`${CHANGE}/`)) {
        state.files.set(path.replace(CHANGE, `${CWD}/openspec/changes/archive/2026-10-22-demo-change`), text)
      }
    }
    state.archiveLogs['2026-10-22-demo-change'] = `${ARCHIVE_HASH}\tfeat(export): CSV export (#227)\n`
    state.prViews[227] = { number: 227, state: 'MERGED', url: 'https://github.com/o/r/pull/227' }
    await clock.advance(4500)
    expect((await board.find({ type: 'Text', text: /^gated-spec-driven/ }))?.text).toBe('gated-spec-driven · main')
    expect((await board.find({ type: 'Text', text: /archived/ }))?.text).toBe(' ✔  archived ')
    expect((await board.find({ key: 'pr' }))?.text).toContain('#227 merged')
    await board.press({ key: 'fold:apply' })
    expect((await board.find({ key: 'group:0' }))?.text).toContain('3/3')
    await board.unmount()
  })

  test('the session leaves a worktree it kept: the board reads the change there while the main checkout lacks it', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const worktree = `${CWD}/.claude/worktrees/demo`
    // The main checkout has neither the change nor the backlog the change names.
    const main = Object.fromEntries(Object.entries(DEMO_FILES).filter(([path]) => !path.startsWith(`${CHANGE}/`) && !path.endsWith('/docs/backlog.md')))
    const state = world(on, { ...rooted(DEMO_FILES, worktree), ...main }, 'demo-change')
    let here = worktree
    on('session.cwd', () => ({ value: here }))
    on('command.run', () => ({ text: '' }))
    await $.session.start({ cwd: worktree, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('opsx:apply', 'demo-change'))
    await clock.advance(4500)
    here = CWD
    await clock.advance(9000)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ type: 'Text', text: /^gated-spec-driven/ }))?.text).toBe('gated-spec-driven · demo-change')
    expect((await board.find({ key: 'group:0' }))?.text).toContain('3/3')
    expect(await board.find({ type: 'Text', text: /no change folder yet/ })).toBeUndefined()
    await board.press({ key: 'fold:propose' })
    await board.press({ key: 'artifact:proposal' })
    expect((await board.find({ type: 'Text', text: /proposal\.md$/ }))?.text).toContain(`${worktree}/openspec/changes/demo-change/proposal.md`)
    await board.press({ key: 'back' })
    // A planning item reads the backlog of the folder that holds the change.
    await board.press({ key: 'fold:plan' })
    await board.press({ key: 'plan:WI-12' })
    expect((await board.find({ key: 'doc' }))?.text).toContain('**WI-12 · CSV export')
    await board.press({ key: 'back' })

    // Once the main checkout holds the change too, the board reads it there, with the same files.
    for (const [path, text] of Object.entries(DEMO_FILES)) {
      state.files.set(path, text)
    }
    await clock.advance(4500)
    await board.press({ key: 'artifact:proposal' })
    expect((await board.find({ type: 'Text', text: /proposal\.md$/ }))?.text).toContain(`${CHANGE}/proposal.md`)
    expect((await board.find({ type: 'Text', text: /proposal\.md$/ }))?.text).not.toContain(worktree)
    await board.unmount()
  })

  test('a change name that is not kebab-case never reaches a command line or a ledger path', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const files = { ...DEMO_FILES, [`${CWD}/openspec/changes/x&calc/proposal.md`]: '## Why\n' }
    const state = world(on, files)
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    // The odd folder is no candidate, so the one real change binds by itself.
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ type: 'Text', text: /^demo-change$/ }))?.text).toBe('demo-change')
    await board.unmount()
    expect(await $.command.run(typed('opsx-board', '../..'))).toMatchObject({ text: expect.stringContaining('is not a change name') })
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't-x', usage: { ...USAGE, model: 'm' }, reason: 'answer' })
    await clock.advance(6000)
    expect(state.runs.some(run => run.includes('&') || run.includes('..'))).toBe(false)
    expect([...state.writes.keys()].every(path => path.startsWith(`${LEDGERS}/demo-change/`))).toBe(true)
  })

  test('a subagent gets the progress note only during an apply run', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    world(on, DEMO_FILES)
    const prompts: string[] = []
    on('agent.spawn', (_, e) => {
      prompts.push(e.prompt)

      return { model: 'claude-opus-5-5', agentId: `agent-${prompts.length}` }
    })
    on('command.run', () => ({ text: '' }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    // The change is in Apply, but no apply run is under way: no note.
    await $.agent.spawn(spawn('general-purpose', 'Look something up', 'Find the export settings.'))
    expect(prompts.at(-1)).toBe('Find the export settings.')
    await $.command.run(typed('opsx:apply', 'demo-change'))
    await $.agent.spawn(spawn('general-purpose', 'Implement group 2', 'Implement task group 2.'))
    expect(prompts.at(-1)).toContain('mcp__opsx-board__progress')
    // Review and planning agents never get it.
    await $.agent.spawn(spawn('spec-reviewer', 'Review', 'Review the change.'))
    expect(prompts.at(-1)).toBe('Review the change.')
  })

  test('explore before any change, then the proposal takes over its tokens', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const files = Object.fromEntries(Object.entries(DEMO_FILES).filter(([path]) => !path.startsWith(CHANGE)))
    const state = world(on, files)
    on('command.run', () => ({ text: '' }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('opsx:explore', 'how the csv export should work'))
    await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't-e', usage: { ...USAGE, model: 'm' }, reason: 'answer' })
    await clock.advance(4500)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Explore mode/ }))?.text).toBe('Explore mode: no change yet.')
    // Explore is the current stage; the command does not mark Propose active.
    expect((await ui.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toBe(
      '–  Plan ›  ▶  Explore  › –  Design › ○  Propose › ○  Apply › ○  Review › ○  PR › ○  Archive',
    )
    expect((await ui.find({ type: 'Text', text: /how the csv export should work/ }))?.text).toContain('▶  how the csv export should work')
    expect((await ui.find({ type: 'Text', text: /tok$/ }))?.text).toBe('44k tok')
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:propose')
    expect(state.statuses.at(-1)).toBe('opsx explore how the csv export should work')
    await ui.unmount()

    // The exploration becomes a change: its explore tokens move into the ledger of the change.
    for (const [path, text] of Object.entries(DEMO_FILES)) {
      state.files.set(norm(path), text)
    }
    await $.command.run(typed('opsx:propose', 'demo-change'))
    // The ledger writes at most once per 5 s, and the `_pre` write has just happened.
    await clock.advance(12_000)
    const ledger = JSON.parse(state.writes.get(`${LEDGERS}/demo-change/sess-1.json`) ?? '{}')
    expect(ledger.main?.explore).toEqual({ input: 1000, output: 2000, cacheRead: 40_000, cacheWrite: 500 })
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toContain('✔  Plan › ✔  Explore › ')
    expect((await board.find({ key: 'fold:explore' }))?.text).toContain('Explore')
    await board.unmount()
  })

  test('explore binds only an argument that names an existing change', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const files = { ...DEMO_FILES, [`${CWD}/openspec/changes/other-change/proposal.md`]: '## Why\n' }
    world(on, files, 'main')
    on('command.run', () => ({ text: '' }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    // A topic that only looks like a change name binds nothing: the pane still asks. So do the
    // reserved `archive` folder and an archived change, which explore does not resolve.
    for (const topic of ['export-ideas', 'archive', 'csv-import']) {
      await $.command.run(typed('opsx:explore', topic))
      await clock.advance(300)
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'pick:demo-change' })).toBeDefined()
    await $.command.run(typed('opsx:explore', 'demo-change'))
    await clock.advance(300)
    expect((await ui.find({ type: 'Text', text: /^demo-change$/ }))?.text).toBe('demo-change')
    expect((await ui.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toContain('▶  Explore')
    // The earlier, unbound topics moved into the bound change with it.
    expect((await ui.find({ type: 'Text', text: /export-ideas/ }))?.text).toContain('export-ideas')

    // The explore runs belong to their change: a pinned other change shows none of them.
    await $.command.run(typed('opsx-board', 'other-change'))
    await clock.advance(300)
    expect((await ui.find({ type: 'Text', text: /^other-change$/ }))?.text).toBe('other-change')
    expect((await ui.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toContain('–  Explore')
    expect(await ui.find({ type: 'Text', text: /export-ideas/ })).toBeUndefined()
    await ui.unmount()
  })

  test('two active changes: the branch decides, else the pane asks', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const files = { ...DEMO_FILES, [`${CWD}/openspec/changes/other-change/proposal.md`]: '## Why\n' }
    const state = world(on, files, 'main')
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'pick:demo-change' })).toBeDefined()
    expect(await ui.find({ key: 'pick:other-change' })).toBeDefined()
    await ui.press({ key: 'pick:demo-change' })
    await clock.advance(100)
    expect((await ui.find({ type: 'Text', text: /^demo-change/ }))?.text).toContain('demo-change')
    await ui.unmount()
    expect(state.branch).toBe('main')
  })
})

describe('opsx-board with other schemas', () => {
  const PLAIN = `${CWD}/openspec/changes/plain-change`
  const PLAIN_FILES: Record<string, string> = {
    [`${PLAIN}/.openspec.yaml`]: 'schema: spec-driven\ncreated: 2026-10-30\n',
    [`${PLAIN}/proposal.md`]: PROPOSAL_MD,
  }

  test('a spec-driven change without hints: no Plan or Design, and the artifacts and their order from the CLI', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 30, 20) })
    const state = world(on, PLAIN_FILES, 'feat/plain-change')
    state.status = { 'plain-change': SPEC_DRIVEN_STATUS_JSON }
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Explore .* Archive/ }))?.text).toBe(
      '–  Explore ›  ▶  Propose  › ○  Apply › ○  Verify › ○  PR › ○  Archive',
    )
    expect((await ui.find({ type: 'Text', text: /^spec-driven/ }))?.text).toBe('spec-driven · feat/plain-change')
    // The proposal names a roadmap item and a design, but no hints say what they are.
    expect(await ui.find({ key: 'fold:plan' })).toBeUndefined()
    expect(await ui.find({ key: 'fold:design' })).toBeUndefined()
    expect((await ui.find({ key: 'artifact:specs' }))?.text).toContain('ready')
    expect((await ui.find({ key: 'artifact:tasks' }))?.text).toContain('blocked · needs specs, design')
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:continue plain-change')
    expect((await ui.find({ type: 'Text', text: /^fills the prompt/ }))?.text).toContain('next: specs, design')
    expect((await ui.find({ key: 'review' }))?.text).toContain('/opsx:verify checks the change')

    // The schema names the files, and the system opener would run a script as it opens it.
    // The reader shows such a file, and its app is never opened.
    state.status = {
      'plain-change': {
        ...SPEC_DRIVEN_STATUS_JSON,
        artifacts: [{ id: 'proposal', outputPath: 'proposal.cmd', status: 'done', requires: [] }],
      },
    }
    state.files.set(`${PLAIN}/proposal.cmd`, 'del /q *')
    await $.command.run(typed('opsx-board', ''))
    await clock.advance(300)
    await ui.press({ key: 'artifact:proposal' })
    expect((await ui.find({ key: 'doc' }))?.text).toContain('del /q *')
    await ui.press({ key: 'external' })
    expect(state.toasts.at(-1)).toBe(`Could not open proposal.cmd · plain-change: ${PLAIN}/proposal.cmd`)
    expect(state.runs.some(run => run.includes('proposal.cmd'))).toBe(false)
    await ui.unmount()
  })

  test('an archived change of a forked schema: its artifacts come from its schema.yaml, in requires order', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 30, 20) })
    const archived = `${CWD}/openspec/changes/archive/2026-10-01-team-change`
    const state = world(
      on,
      {
        '/pkg/schemas/team-flow/schema.yaml': TEAM_SCHEMA_YAML,
        [`${archived}/.openspec.yaml`]: 'schema: team-flow\ncreated: 2026-09-30\n',
        [`${archived}/proposal.md`]: '## Why\n',
        [`${archived}/research.md`]: '# Research\n',
        [`${archived}/tasks.md`]: '## 1. Build\n\n- [x] 1.1 Build it\n',
      },
      'main',
    )
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('opsx-board', 'team-change'))
    await clock.advance(300)
    expect(state.runs).toContain('openspec schema which team-flow --json')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Explore .* Archive/ }))?.text).toContain('✔  Apply › ✔  Verify › –  PR › ✔  Archive')
    expect((await ui.find({ type: 'Text', text: /artifacts$/ }))?.text).toBe('3/5 artifacts')
    await ui.press({ key: 'fold:propose' })
    const rows = []
    for (const id of ['proposal', 'research', 'specs', 'design', 'tasks']) {
      rows.push((await ui.find({ key: `artifact:${id}` }))?.text.trim().slice(0, 1))
    }
    expect(rows).toEqual(['✔', '✔', '○', '○', '✔'])
    await ui.unmount()
  })

  test("a board.yaml in the person's folder wins over the one beside the schema", async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    world(on, {
      ...DEMO_FILES,
      '/home/me/.claude/opsx-board/schemas/gated-spec-driven/board.yaml': 'version: 1\nverify: { label: Check }\n',
    })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Explore .* Archive/ }))?.text).toBe(
      '–  Explore › ✔  Propose ›  ▶  Apply  › ○  Check › ○  PR › ○  Archive',
    )
    await ui.unmount()
  })
})

describe('opsx-board with GitHub issues', () => {
  const GH = `${CWD}/openspec/changes/gh-change`
  const GH_FILES: Record<string, string> = {
    [`${GH}/.openspec.yaml`]: 'schema: spec-driven\ncreated: 2026-10-31\n',
    [`${GH}/proposal.md`]: GITHUB_PROPOSAL_MD,
    [`${GH}/tasks.md`]: '## 1. Build\n\n- [x] 1.1 Build the writer\n',
    '/home/me/.claude/opsx-board/schemas/spec-driven/board.yaml': GITHUB_BOARD_YAML,
  }
  const GH_STATUS = {
    ...SPEC_DRIVEN_STATUS_JSON,
    changeName: 'gh-change',
    isComplete: true,
    artifacts: SPEC_DRIVEN_STATUS_JSON.artifacts.map(artifact => ({ id: artifact.id, outputPath: artifact.outputPath, requires: artifact.requires, status: 'done' })),
  }
  const issueRuns = (state: World) => state.runs.filter(run => run.startsWith('gh issue view'))

  test('the issues of the proposal, the branch, and the pull request, with their state from gh', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 31, 20) })
    const state = world(on, GH_FILES, '34-csv-export')
    state.status = { 'gh-change': GH_STATUS }
    state.prs = GITHUB_PRS
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    // The board command reads the pull request, and with it the issues it closes.
    await $.command.run(typed('opsx-board', ''))
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Explore .* Archive/ }))?.text).toBe(
      '–  Explore › ✔  Issues › ✔  Propose › ✔  Apply › ✔  Verify › ▶  PR ›  ○  Archive ',
    )
    await ui.press({ key: 'fold:plan' })
    const rows = []
    for (const id of ['#12', 'other/lib#7', '#34', '#40']) {
      rows.push((await ui.find({ key: `plan:${id}` }))?.text)
    }
    expect(rows).toEqual([
      '[ ] #12  CSV export of the library',
      '[?] other/lib#7  not found on GitHub',
      '[x] #34  Streaming writer · branch',
      '[-] #40  Excel export · closed by the PR',
    ])
    // A heading anchor, a pull request number, and a prose line name no issue.
    for (const id of ['#13', '#226', '#85', '#90']) {
      expect(await ui.find({ key: `plan:${id}` })).toBeUndefined()
    }
    // The pull request gives the home repository, so a bare #N names it; another one keeps its
    // name. Before the pull request is known, gh resolves a bare #N from the working directory.
    expect(issueRuns(state)).toContain('gh issue view 12 --json number,title,state,stateReason,url')
    for (const run of ['12 --json number,title,state,stateReason,url -R o/r', '34 --json number,title,state,stateReason,url -R o/r', '40 --json number,title,state,stateReason,url -R o/r', '7 --json number,title,state,stateReason,url -R other/lib']) {
      expect(issueRuns(state)).toContain(`gh issue view ${run}`)
    }
    expect(state.runs).toContain('gh pr list --head 34-csv-export --state all --json number,state,url,closingIssuesReferences --limit 1')
    expect(await ui.find({ type: 'Text', text: /^⚠/ })).toBeUndefined()

    // A refresh within two minutes asks gh nothing new; after that it reads each issue again.
    const before = issueRuns(state).length
    await $.command.run(typed('opsx-board', ''))
    await clock.advance(300)
    expect(issueRuns(state).length).toBe(before)
    state.issues = { ...GITHUB_ISSUES, 'o/r#12': { ...(GITHUB_ISSUES['o/r#12'] as object), state: 'CLOSED', stateReason: 'COMPLETED' } }
    await clock.advance(121_000)
    await $.command.run(typed('opsx-board', ''))
    await clock.advance(300)
    expect(issueRuns(state).length).toBe(before + 4)
    expect((await ui.find({ key: 'plan:#12' }))?.text).toBe('[x] #12  CSV export of the library')
    await ui.unmount()
  })

  test('an issue opens in the reader as gh reads it, and its page in the browser', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 31, 20) })
    const state = world(on, GH_FILES, '34-csv-export')
    state.status = { 'gh-change': GH_STATUS }
    state.prs = GITHUB_PRS
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'fold:plan' })
    await ui.press({ key: 'plan:#12' })
    expect(state.runs.at(-1)).toBe('gh issue view 12 --json number,title,state,stateReason,url,body,author,createdAt,labels,assignees -R o/r')
    expect((await ui.find({ type: 'Text', text: /^#12 · / }))?.text).toBe('#12 · CSV export of the library')
    const doc = (await ui.find({ key: 'doc' }))?.text ?? ''
    expect(doc).toContain('**Open** · opened by @sam on 2026-10-01 · the proposal names it')
    expect(doc).toContain('Labels: `feature` · Assigned: @dana')
    expect(doc).toContain('Export a CSV.')
    expect(await ui.find({ key: 'external' })).toBeUndefined()
    await ui.press({ key: 'browser' })
    expect(state.runs.at(-1)).toBe('xdg-open https://github.com/o/r/issues/12')
    await ui.press({ key: 'back' })

    // An issue gh cannot read says why, and still offers its page.
    await ui.press({ key: 'plan:other/lib#7' })
    expect((await ui.find({ key: 'doc' }))?.text).toContain('Cannot read other/lib#7 with gh: not found.')
    await ui.press({ key: 'browser' })
    expect(state.runs.at(-1)).toBe('xdg-open https://github.com/other/lib/issues/7')
    await ui.unmount()
  })

  test('without gh: no PR stage, issues without state, and verify before the archive', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 31, 20) })
    const state = world(on, GH_FILES, '34-csv-export')
    state.status = { 'gh-change': GH_STATUS }
    state.isGhMissing = true
    on('command.run', () => ({ text: '' }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Explore .* Archive/ }))?.text).toBe(
      '–  Explore › ✔  Issues › ✔  Propose › ✔  Apply ›  ○  Verify  › ○  Archive',
    )
    expect((await ui.find({ type: 'Text', text: /^⚠/ }))?.text).toBe('⚠  GitHub: gh is not installed, so the issues show no state')
    await ui.press({ key: 'fold:plan' })
    expect((await ui.find({ key: 'plan:#12' }))?.text).toBe('[?] #12  CSV export')
    expect((await ui.find({ key: 'plan:#34' }))?.text).toBe('[?] #34   · branch')
    expect(await ui.find({ key: 'pr' })).toBeUndefined()
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:verify gh-change')
    expect(state.runs.filter(run => run.startsWith('gh ') && run !== 'gh --version')).toEqual([])

    // While verify runs, Next does not offer it; it offers it again once the turn ends without a verdict.
    await $.command.run(typed('opsx:verify', 'gh-change'))
    await clock.advance(300)
    expect((await ui.find({ type: 'Text', text: /Explore .* Archive/ }))?.text).toContain('▶  Verify')
    expect(await ui.find({ key: 'next' })).toBeUndefined()
    await $.turn.complete({ answer: 'I could not finish.', durationMs: 1, isAborted: false, turnId: 't-v', reason: 'answer' })
    await clock.advance(300)
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:verify gh-change')
    await ui.unmount()
  })

  test("the tasks come from the files the schema's apply.tracks names", async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 31, 20) })
    const tracked = TEAM_SCHEMA_YAML.replace('tracks: tasks.md', "tracks: 'work/**/*.md'")
    const state = world(
      on,
      {
        '/pkg/schemas/team-flow/schema.yaml': tracked,
        [`${GH}/.openspec.yaml`]: 'schema: team-flow\ncreated: 2026-10-31\n',
        [`${GH}/proposal.md`]: '## Why\n',
        [`${GH}/tasks.md`]: '## 9. Not tracked\n\n- [ ] 9.1 Never shown\n',
        [`${GH}/work/backend.md`]: '## 1. Backend\n\n- [x] 1.1 Writer\n- [ ] 1.2 Status file\n',
        [`${GH}/work/ui/dialog.md`]: '## 2. Dialog\n\n- [ ] 2.1 Picker\n',
      },
      'main',
    )
    state.status = { 'gh-change': { ...GH_STATUS, schemaName: 'team-flow' } }
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Apply 1\/3/ }))?.text).toBe(' ▶  Apply 1/3 ')
    expect(await ui.find({ key: 'group:1' })).toBeDefined()
    expect(await ui.find({ key: 'group:2' })).toBeDefined()
    expect(await ui.find({ key: 'group:9' })).toBeUndefined()

    // A schema without apply.tracks tracks no tasks, as the CLI does.
    state.files.set('/pkg/schemas/team-flow/schema.yaml', TEAM_SCHEMA_YAML.replace("  tracks: tasks.md\n", ''))
    await $.command.run(typed('opsx-board', ''))
    await clock.advance(300)
    expect(await ui.find({ key: 'group:1' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('opsx-board and the host of the pull request', () => {
  const HOSTED = `${CWD}/openspec/changes/host-change`
  const HOSTED_FILES: Record<string, string> = {
    [`${HOSTED}/.openspec.yaml`]: 'schema: spec-driven\ncreated: 2026-10-31\n',
    [`${HOSTED}/proposal.md`]: '## Why\n',
    [`${HOSTED}/tasks.md`]: '## 1. Build\n\n- [x] 1.1 Build the writer\n',
  }
  const HOSTED_STATUS = {
    ...SPEC_DRIVEN_STATUS_JSON,
    changeName: 'host-change',
    isComplete: true,
    artifacts: SPEC_DRIVEN_STATUS_JSON.artifacts.map(artifact => ({ id: artifact.id, outputPath: artifact.outputPath, requires: artifact.requires, status: 'done' })),
  }
  const RAIL = { type: 'Text', text: /Explore .* Archive/ } as const
  const ghRuns = (state: World) => state.runs.filter(run => run.startsWith('gh pr ') || run.startsWith('gh auth '))

  /** A session of host-change on its branch, whose apply run has settled every task. */
  async function applied($: Parameters<TestBody>[0], on: On, remote: string | undefined, setup: (state: World) => void = () => undefined) {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 31, 20) })
    const state = world(on, HOSTED_FILES, 'host-change')
    state.status = { 'host-change': HOSTED_STATUS }
    state.remote = remote
    setup(state)
    on('command.run', () => ({ text: '' }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('opsx:apply', 'host-change'))
    await $.turn.complete({ answer: 'All tasks are done.', durationMs: 1, isAborted: false, turnId: 't-a', reason: 'answer' })
    await clock.advance(300)

    return { clock, state, ui: await $.ui.mount({ ...PANE, surface: 'terminal' }) }
  }

  const why = async (ui: Awaited<ReturnType<typeof applied>>['ui']) => (await ui.find({ type: 'Text', text: /^fills the prompt/ }))?.text

  test('a repository on GitLab: the MR stage from glab, with the words of GitLab', async ($, on) => {
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'https://gitlab.example.com/o/r/-/merge_requests/12' }))
    const { clock, state, ui } = await applied($, on, 'git@gitlab.example.com:o/r.git', world => {
      world.mrs = '[]'
    })
    // No merge request yet, and the tasks are done: the merge request holds nothing back.
    expect((await ui.find(RAIL))?.text).toBe('–  Explore › ✔  Propose › ✔  Apply ›  ○  Verify  › ○  MR › ○  Archive')
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:verify host-change')
    expect(await why(ui)).toBe('fills the prompt · the tasks are done. Verify the change before the archive')
    await ui.press({ key: 'pr' })
    expect(state.toasts.at(-1)).toBe('No merge request for this branch yet')

    // `glab mr create` opens it, and the board reads it at once.
    state.mrs = JSON.stringify([mergeRequest(12, 'opened')])
    await $.tool.call({ tool: 'Bash', command: 'glab mr create --fill --yes' })
    await clock.advance(300)
    expect(state.runs).toContain('glab api projects/:id/merge_requests?source_branch=host-change&order_by=created_at&sort=desc&per_page=1')
    expect(state.toasts).toContain('Merge request !12 open')
    expect((await ui.find(RAIL))?.text).toContain('▶  MR')
    expect((await ui.find({ key: 'pr' }))?.text).toContain('MR      !12 open · open in the browser ↗')
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:archive host-change')
    expect(await why(ui)).toBe('fills the prompt · the merge request is open')
    expect((await ui.find({ type: 'Text', text: /^click a row/ }))?.text).toContain('design, MR → browser')
    await ui.press({ key: 'pr' })
    expect(state.runs.at(-1)).toBe('xdg-open https://gitlab.example.com/o/r/-/merge_requests/12')
    expect(state.toasts.at(-1)).toBe('Opened merge request !12')
    // gh is installed, but the board asks it nothing about a GitLab repository.
    expect(ghRuns(state)).toEqual([])
    await ui.unmount()
  })

  test('a GitHub repository keeps the words of GitHub', async ($, on) => {
    const { clock, ui } = await applied($, on, 'https://github.com/o/r.git')
    await $.command.run(typed('opsx-board', ''))
    await clock.advance(300)
    expect((await ui.find(RAIL))?.text).toContain('▶  PR')
    expect((await ui.find({ key: 'pr' }))?.text).toContain('PR      #227 open · open in the browser ↗')
    expect(await why(ui)).toBe('fills the prompt · the pull request is open')
    expect((await ui.find({ type: 'Text', text: /^click a row/ }))?.text).toContain('design, PR → browser')
    await ui.unmount()
  })

  test('an archived change on GitLab finds the merge request that merged it, by its archive commit', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES, 'main')
    state.remote = 'https://gitlab.com/o/r.git'
    // GitLab relates the commit to the merge request that merged it, and to an older one closed unmerged.
    state.commitMrs[ARCHIVE_HASH] = [mergeRequest(30, 'closed'), mergeRequest(31, 'merged')]
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('opsx-board', 'csv-import'))
    await clock.advance(300)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toContain('✔  MR › ✔  Archive')
    expect((await board.find({ key: 'pr' }))?.text).toContain('!31 merged')
    expect(state.runs).toContain(`glab api projects/:id/repository/commits/${ARCHIVE_HASH}/merge_requests`)
    // The `(#226)` of the commit subject is a GitHub number: on GitLab, gh reads nothing.
    expect(state.runs.filter(run => run.startsWith('gh '))).toEqual([])
    await board.unmount()
  })

  test('a change archived on the main branch by a CI job: the merge request of its last change to the active folder', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES, 'main')
    const squash = '5c0a5c0a5c0a5c0a5c0a5c0a5c0a5c0a5c0a5c0a'
    state.remote = 'https://gitlab.com/o/r.git'
    // The archive commit was pushed to main, so no merge request holds it. The squash commit of
    // the merge request last changed the active folder.
    state.archiveLog = `${ARCHIVE_HASH}\tchore(openspec): archive completed changes [skip ci]\n`
    state.activeLogs['csv-import'] = `${squash}\n`
    state.commitMrs[squash] = [mergeRequest(42, 'merged')]
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('opsx-board', 'csv-import'))
    await clock.advance(300)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ key: 'pr' }))?.text).toContain('!42 merged')
    expect(state.runs).toContain(`glab api projects/:id/repository/commits/${ARCHIVE_HASH}/merge_requests`)
    expect(state.runs).toContain(`glab api projects/:id/repository/commits/${squash}/merge_requests`)
    await board.unmount()
  })

  test('a change archived on its branch reads its open merge request again until the merge', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES, 'demo-change')
    state.remote = 'git@gitlab.com:o/r.git'
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    // The work on the branch makes the merge request due once a minute.
    await clock.advance(65_000)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ key: 'pr' }))?.text).toContain('!12 open')

    archive(state, CWD, '2026-10-22-demo-change')
    await clock.advance(4500)
    expect((await board.find({ key: 'pr' }))?.text).toContain('!12 open')
    state.mrViews[12] = mergeRequest(12, 'merged')
    await clock.advance(65_000)
    expect((await board.find({ key: 'pr' }))?.text).toContain('!12 merged')
    expect(state.runs).toContain('glab api projects/:id/merge_requests/12')
    await board.unmount()
  })

  test('a change merged into the main branch and not archived finds its merge request by its last commit, and Next offers the archive', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 10, 12, 9) })
    const state = world(on, HOSTED_FILES, 'main')
    state.status = { 'host-change': HOSTED_STATUS }
    state.remote = 'https://gitlab.com/o/r.git'
    const squash = '5c0a'.repeat(10)
    state.activeLogs['host-change'] = `${squash}\tfeat: build the writer\n`
    state.commitMrs[squash] = [mergeRequest(42, 'merged')]
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'pr' }))?.text).toContain('!42 merged')
    expect((await ui.find(RAIL))?.text).toContain('✔  MR')
    // Merged is not finished: the change still waits for its archive.
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:archive host-change')
    expect(await why(ui)).toBe('fills the prompt · the merge request is merged')
    // The commit is asked about once, not at each read of git.
    await clock.advance(65_000)
    expect(state.runs.filter(run => run === `glab api projects/:id/repository/commits/${squash}/merge_requests`)).toHaveLength(1)
    await ui.unmount()
  })

  test('a GitLab server with a name of its own: the MR stage, once glab is logged in to it', async ($, on) => {
    const { clock, state, ui } = await applied($, on, 'https://code.corp.example/group/sub/r.git', world => {
      world.glabHosts = ['gitlab.com', 'code.corp.example']
    })
    await $.command.run(typed('opsx-board', ''))
    await clock.advance(300)
    expect((await ui.find({ key: 'pr' }))?.text).toContain('!12 open')
    // gh is asked first, then glab, each once for the session.
    await clock.advance(65_000)
    expect(state.runs.filter(run => run.endsWith('auth status --hostname code.corp.example'))).toEqual([
      'gh auth status --hostname code.corp.example',
      'glab auth status --hostname code.corp.example',
    ])
    await ui.unmount()
  })

  test('a repository on GitLab without glab: no MR stage, and Next goes on once the apply run is over', async ($, on) => {
    const { clock, state, ui } = await applied($, on, 'git@gitlab.example.com:o/r.git', world => {
      world.isGlabMissing = true
      world.prs = '[]'
    })
    expect((await ui.find(RAIL))?.text).toBe('–  Explore › ✔  Propose › ✔  Apply ›  ○  Verify  › ○  Archive')
    expect(await ui.find({ key: 'pr' })).toBeUndefined()
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:verify host-change')
    // gh is installed, but the board asks it nothing about a GitLab repository.
    expect(ghRuns(state)).toEqual([])

    // The same change on GitHub shows its PR stage, which holds Next back no more than the tasks do.
    state.remote = 'https://github.com/o/r.git'
    await clock.advance(35_000)
    expect((await ui.find(RAIL))?.text).toContain('○  PR')
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:verify host-change')
    await ui.unmount()
  })

  test('a GitHub Enterprise server with a name of its own: the PR stage, once gh is logged in to it', async ($, on) => {
    const { clock, state, ui } = await applied($, on, 'ssh://git@git.corp.example:2222/o/r.git', world => {
      world.ghHosts = ['github.com', 'git.corp.example']
    })
    await $.command.run(typed('opsx-board', ''))
    await clock.advance(300)
    expect((await ui.find({ key: 'pr' }))?.text).toContain('#227 open')
    // Asked once for the session, not at each read of git.
    await clock.advance(65_000)
    expect(state.runs.filter(run => run === 'gh auth status --hostname git.corp.example')).toHaveLength(1)
    await ui.unmount()
  })

  test('a repository without a remote, or on a host neither gh nor glab is logged in to: no PR stage', async ($, on) => {
    const { clock, state, ui } = await applied($, on, undefined)
    expect((await ui.find(RAIL))?.text).toBe('–  Explore › ✔  Propose › ✔  Apply ›  ○  Verify  › ○  Archive')
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:verify host-change')

    // A remote added later is read with git.
    state.remote = 'https://git.other.example/o/r.git'
    await clock.advance(35_000)
    expect(state.runs).toContain('gh auth status --hostname git.other.example')
    expect(state.runs).toContain('glab auth status --hostname git.other.example')
    expect(await ui.find({ key: 'pr' })).toBeUndefined()
    expect(state.runs.filter(run => run.startsWith('gh pr ') || run.startsWith('glab api '))).toEqual([])
    await ui.unmount()
  })
})

describe('opsx-board flow', () => {
  const FLOW = `${CWD}/openspec/changes/flow-change`
  // One task done, one left, and one after the merge.
  const FLOW_TASKS = '## 1. Build\n\n- [x] 1.1 Build the writer\n- [ ] 1.2 Write the status file\n\n## 2. After the merge\n\n- [ ] 2.1 Run the suite on main\n'
  const FLOW_FILES: Record<string, string> = {
    [`${FLOW}/.openspec.yaml`]: 'schema: spec-driven\ncreated: 2026-11-01\n',
    [`${FLOW}/proposal.md`]: '## Why\n',
    [`${FLOW}/tasks.md`]: FLOW_TASKS,
  }
  const FLOW_STATUS = {
    ...SPEC_DRIVEN_STATUS_JSON,
    changeName: 'flow-change',
    isComplete: true,
    artifacts: SPEC_DRIVEN_STATUS_JSON.artifacts.map(artifact => ({ id: artifact.id, outputPath: artifact.outputPath, requires: artifact.requires, status: 'done' })),
  }
  const RAIL = { type: 'Text', text: /Explore .* (Archive|Close|Apply)/ } as const
  const why = async (ui: { find: (query: object) => Promise<{ text?: string } | undefined> }) =>
    (await ui.find({ type: 'Text', text: /^fills the prompt/ }))?.text

  test('once a task is done, Next goes on to the next stage while nothing runs; after an interrupt, it offers to apply again', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 10, 12, 9) })
    const state = world(on, FLOW_FILES, 'flow-change')
    state.status = { 'flow-change': FLOW_STATUS }
    state.remote = undefined
    on('command.run', () => ({ text: '' }))
    on('turn.complete', () => ({ text: '' }))
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    const endTurn = (turnId: string, reason: 'answer' | 'aborted' = 'answer') =>
      $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId, reason })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await $.command.run(typed('opsx:apply', 'flow-change'))
    await clock.advance(300)
    // The turn of the command runs: Next waits.
    expect(await ui.find({ key: 'next' })).toBeUndefined()
    await endTurn('t-a')
    await clock.advance(300)

    // A task is done and nothing runs: Next goes on to Verify, though tasks stay open.
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:verify flow-change')
    expect(await why(ui)).toBe('fills the prompt · 1 of 3 tasks done. Verify the change before the archive')
    expect((await ui.find(RAIL))?.text).toContain('▶  Apply')

    // A main turn of the run works on: Next waits for it, and comes back once it ends.
    await $.turn.start({ text: 'Go on with group 1.', turnId: 't-b' })
    await clock.advance(300)
    expect(await ui.find({ key: 'next' })).toBeUndefined()
    await endTurn('t-b')
    await clock.advance(300)
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:verify flow-change')

    // An interrupt: Next offers to apply again, until the next main turn starts.
    await $.turn.start({ text: 'Go on.', turnId: 't-c' })
    await endTurn('t-c', 'aborted')
    await clock.advance(300)
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:apply flow-change')
    expect(await why(ui)).toBe('fills the prompt · the apply run stopped. Apply again to go on')
    await $.turn.start({ text: 'Go on.', turnId: 't-d' })
    await clock.advance(300)
    expect(await ui.find({ key: 'next' })).toBeUndefined()
    await endTurn('t-d')
    await clock.advance(300)
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:verify flow-change')

    // Verified: the archive comes next, with the tasks it leaves open.
    await $.command.run(typed('opsx:verify', 'flow-change'))
    await $.turn.complete({ answer: 'All checks passed. Ready for archive.', durationMs: 1, isAborted: false, turnId: 't-v', reason: 'answer' })
    await clock.advance(300)
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:archive flow-change')
    expect(await why(ui)).toBe('fills the prompt · the change is verified; 1 of 3 tasks done')
    await ui.unmount()
  })

  test('an archived change with open tasks is finished: Apply is partly done, and Next offers nothing', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES, 'main')
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    archive(state, CWD, '2026-10-22-demo-change')
    await clock.advance(4500)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /archived/ }))?.text).toBe(' ✔  archived ')
    expect((await ui.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toContain('◐  Apply')
    expect(await ui.find({ key: 'next' })).toBeUndefined()
    // The ended Apply folds; it still counts its tasks.
    expect(await ui.find({ key: 'group:2' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^4\/9/ }))?.text).toContain('4/9')
    await ui.unmount()
  })

  test('board.yaml renames, hides, moves, and makes stages optional; a hidden Archive still leaves the change archived', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 10, 12, 9) })
    const board = `version: 1
stages:
  - { id: verify, optional: true }
  - { id: archive, label: Close }
  - { id: explore, after: propose }
`
    const done = FLOW_TASKS.replace(/- \[ \]/g, '- [x]')
    const state = world(on, { ...FLOW_FILES, [`${FLOW}/tasks.md`]: done, '/home/me/.claude/opsx-board/schemas/spec-driven/board.yaml': board }, 'flow-change')
    state.status = { 'flow-change': FLOW_STATUS }
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // Explore moved after Propose, Verify is optional (not applicable until it runs), and Archive is Close.
    expect((await ui.find({ type: 'Text', text: /Propose .* Close/ }))?.text).toBe('✔  Propose › –  Explore › ✔  Apply › –  Verify › ○  PR ›  ○  Close ')
    // Next skips the optional Verify.
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:archive flow-change')
    await ui.unmount()

    // Archive hidden: the rail and the pane leave it out, and the archived change still says so.
    state.files.set('/home/me/.claude/opsx-board/schemas/spec-driven/board.yaml', 'version: 1\nstages:\n  - { id: archive, hidden: true }\n  - { id: pr, hidden: true }\n')
    for (const [path, text] of [...state.files]) {
      if (path.startsWith(`${FLOW}/`)) {
        state.files.delete(path)
        state.files.set(path.replace(FLOW, `${CWD}/openspec/changes/archive/2026-11-12-flow-change`), text)
      }
    }
    delete state.status['flow-change']
    await $.command.run(typed('opsx-board', 'flow-change'))
    await clock.advance(300)
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await after.find({ type: 'Text', text: /archived/ }))?.text).toBe(' ✔  archived ')
    expect((await after.find({ type: 'Text', text: /Explore .* Verify/ }))?.text).toBe('–  Explore › ✔  Propose › ✔  Apply › ✔  Verify')
    expect(await after.find({ key: 'pr' })).toBeUndefined()
    await after.unmount()
  })
})

describe('opsx-board with ClickUp tasks', () => {
  const CU = `${CWD}/openspec/changes/cu-change`
  const CU_FILES: Record<string, string> = {
    [`${CU}/.openspec.yaml`]: 'schema: spec-driven\ncreated: 2026-11-01\n',
    [`${CU}/proposal.md`]: [
      '## References',
      '',
      '- **ClickUp Task:** [9aa1bb2cc](https://app.clickup.com/t/9aa1bb2cc)',
      '- **Figma Design:** [Wizard mockup](https://www.figma.com/design/abc/Wizard)',
      '',
      '## Why',
      '',
      '- The scope is https://app.clickup.com/t/9zz0zz0zz, which this change does not close.',
      '',
    ].join('\n'),
    [`${CU}/tasks.md`]: '## 1. Build\n\n- [ ] 1.1 Build the writer\n',
    '/home/me/.claude/opsx-board/schemas/spec-driven/board.yaml': `version: 1
stages:
  - { id: plan, label: ClickUp, collects: work-item, section: References }
refs:
  - { kind: work-item, provider: clickup, branch: '^([0-9a-z]{9,13})_' }
`,
  }
  const CU_STATUS = {
    ...SPEC_DRIVEN_STATUS_JSON,
    changeName: 'cu-change',
    isComplete: true,
    artifacts: SPEC_DRIVEN_STATUS_JSON.artifacts.map(artifact => ({ id: artifact.id, outputPath: artifact.outputPath, requires: artifact.requires, status: 'done' })),
  }
  const task = (id: string, name: string, status: string, type: string) => ({
    id,
    name,
    status: { status, type, color: '#000000' },
    url: `https://app.clickup.com/t/${id}`,
    markdown_description: `## What & why\n\n${name}, as the scope asks.`,
    list: { name: 'Backlog' },
    priority: { priority: 'high' },
    creator: { username: 'sam' },
    assignees: [{ username: 'dana' }],
    date_created: String(Date.UTC(2026, 9, 1)),
  })
  const TASKS = {
    '9aa1bb2cc': task('9aa1bb2cc', 'Persist the label', 'in review', 'custom'),
    '9dd3ee4ff': task('9dd3ee4ff', 'Add a draft state', 'done', 'done'),
  }

  async function board($: Parameters<TestBody>[0], on: On, setup: (state: World) => void) {
    const clock = mock.clock(on, { now: Date.UTC(2026, 10, 12, 9) })
    const state = world(on, CU_FILES, '9dd3ee4ff_draft-state')
    state.status = { 'cu-change': CU_STATUS }
    state.remote = undefined
    state.clickupTasks = TASKS
    setup(state)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'fold:plan' })

    return { clock, state, ui }
  }

  test('with the clickup CLI: the tasks of the proposal and the branch, their names and states, and a task in the reader', async ($, on) => {
    const { clock, state, ui } = await board($, on, () => undefined)
    expect((await ui.find({ type: 'Text', text: /Explore .* Archive/ }))?.text).toContain('✔  ClickUp')
    expect((await ui.find({ key: 'plan:9aa1bb2cc' }))?.text).toBe('[~] 9aa1bb2cc  Persist the label · in review')
    expect((await ui.find({ key: 'plan:9dd3ee4ff' }))?.text).toBe('[x] 9dd3ee4ff  Add a draft state · done · branch')
    // A link outside the section, and the Figma link, name no task.
    expect(await ui.find({ key: 'plan:9zz0zz0zz' })).toBeUndefined()
    const reads = () => state.runs.filter(run => run.startsWith('clickup task view'))
    expect(reads()).toEqual(['clickup task view 9aa1bb2cc 9dd3ee4ff --json'])
    expect(await ui.find({ type: 'Text', text: /^⚠/ })).toBeUndefined()

    // A click shows the task as clickup reads it now, with a button that opens its page.
    await ui.press({ key: 'plan:9aa1bb2cc' })
    expect(state.runs.at(-1)).toBe('clickup task view 9aa1bb2cc --json')
    expect((await ui.find({ type: 'Text', text: /^9aa1bb2cc · / }))?.text).toBe('9aa1bb2cc · Persist the label')
    const doc = (await ui.find({ key: 'doc' }))?.text ?? ''
    expect(doc).toContain('**in review** · Backlog · priority high · opened by sam on 2026-10-01 · the proposal links it')
    expect(doc).toContain('Assigned: dana')
    expect(doc).toContain('Persist the label, as the scope asks.')
    await ui.press({ key: 'browser' })
    expect(state.runs.at(-1)).toBe('xdg-open https://app.clickup.com/t/9aa1bb2cc')
    await ui.press({ key: 'back' })

    // A refresh within two minutes asks clickup nothing new.
    await $.command.run(typed('opsx-board', ''))
    await clock.advance(300)
    expect(reads()).toHaveLength(2)
    await ui.unmount()
  })

  test('without the clickup CLI: each task is a link to its page', async ($, on) => {
    const { state, ui } = await board($, on, world => {
      world.isClickupMissing = true
    })
    expect((await ui.find({ key: 'plan:9aa1bb2cc' }))?.text).toBe(' ↗  9aa1bb2cc  ClickUp Task')
    expect((await ui.find({ key: 'plan:9dd3ee4ff' }))?.text).toBe(' ↗  9dd3ee4ff   · branch')
    expect(await ui.find({ type: 'Text', text: /^⚠/ })).toBeUndefined()
    await ui.press({ key: 'plan:9aa1bb2cc' })
    expect(state.runs.at(-1)).toBe('xdg-open https://app.clickup.com/t/9aa1bb2cc')
    expect(state.toasts.at(-1)).toBe('Opened ClickUp task 9aa1bb2cc')
    await ui.unmount()
  })

  test('with the clickup CLI logged out: links, and a warning that says how to log in', async ($, on) => {
    const { ui } = await board($, on, world => {
      world.isClickupLoggedOut = true
    })
    expect((await ui.find({ type: 'Text', text: /^⚠/ }))?.text).toBe('⚠  ClickUp: clickup is not logged in: run clickup auth login')
    expect((await ui.find({ key: 'plan:9aa1bb2cc' }))?.text).toBe(' ↗  9aa1bb2cc  ClickUp Task')
    await ui.unmount()
  })
})

describe('opsx-board options', () => {
  test('reportTool false: no progress tool and no progress note, and the rest of the board', { options: { reportTool: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES)
    on('command.run', () => ({ text: '' }))
    let spawnedPrompt = ''
    on('agent.spawn', (_, e) => {
      spawnedPrompt = e.prompt

      return { model: 'claude-opus-5-5', agentId: 'agent-2' }
    })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const applied = await $.command.run(typed('opsx:apply', 'demo-change'))
    expect(applied.context ?? []).toEqual([])
    await $.agent.spawn(spawn('general-purpose', 'Implement group 2', 'Implement task group 2 of demo-change.'))
    expect(spawnedPrompt).toBe('Implement task group 2 of demo-change.')
    await clock.advance(300)
    expect(state.tools).toEqual([])
    // The pane still opens on the workflow command.
    expect(state.opened).toContain('opsx-board')
  })
})
