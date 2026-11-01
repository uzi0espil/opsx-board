import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

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

const CWD = '/repo'
const ARCHIVE_HASH = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const CHANGE = `${CWD}/openspec/changes/demo-change`

// The board alone, as it runs once the opsx-board mod is gone. The shadow tests use the default.
const PRIMARY = { options: { mode: 'primary' } }

const PANE = {
  plugin: 'openspec-board',
  component: 'Pane',
  requestId: 'openspec-board',
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
}

// The engine hands a hook the path as the host resolves it (`C:\repo\...` on Windows).
const norm = (path: string): string =>
  path
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:(?=\/)/, '')
    .replace(/\/+/g, '/')

const dirEntry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })

/** A repository in memory, the openspec and git CLIs, and the engine calls the mod makes. */
function world(on: On, files: Record<string, string>, branch = 'worktree-demo-change'): World {
  const state: World = {
    files: new Map(Object.entries(files).map(([path, text]) => [norm(path), text])),
    writes: new Map(),
    viewed: [],
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

    return [...names].map(([name, kind]) => dirEntry(name, kind))
  }
  const isDir = (path: string) => listDir(path).length > 0

  mock.env(on, { HOME: '/home/me' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'sess-1' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: { command: 'openspec-board' } }))
  on('tool.register', (_, e) => {
    state.tools.push(e.name)

    return { value: { tool: `mcp__openspec-board__${e.name}` } }
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
      const dir = [`${CWD}/openspec/schemas/${which[1]}`, `/pkg/schemas/${which[1]}`].find(path => state.files.has(`${path}/schema.yaml`))

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
    if (command === 'git log -1 --diff-filter=A --format=%H%x09%s -- openspec/changes/archive/2026-10-22-csv-import') {
      return ran(state.archiveLog)
    }
    if (command === 'gh pr view 226 --json number,state,url') {
      return ran('{"number":226,"state":"MERGED","url":"https://github.com/o/r/pull/226"}')
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

describe('openspec-board', () => {
  test('the pane shows the stages, the design update, and the task groups', PRIMARY, async ($, on) => {
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
      expect((await ui.find({ key: 'next' }))?.text).toContain('/opsx:apply demo-change')
      // The fold state is the session's, so fold Propose again for the next surface.
      await ui.press({ key: 'fold:propose' })
      await ui.unmount()
    }
  })

  test('a running group shows its agent, its tokens, and the reported task; the row folds, the agent cell opens the agent', PRIMARY, async ($, on) => {
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
    expect(applied.context?.at(-1)).toContain('call `mcp__openspec-board__progress`')
    expect(applied.context?.at(-1)).toContain('OpenSpec change `demo-change`')
    await clock.advance(300)

    await $.agent.spawn(
      spawn('general-purpose', 'Implement group 2', 'Implement task group 2 of demo-change: the CSV writer in `export-service`.'),
    )
    expect(spawnedPrompt).toContain('mcp__openspec-board__progress')
    await $.tool.call({ tool: 'mcp__openspec-board__progress', group: '2', task: '2.2', state: 'start', agentId: 'agent-2' })
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

  test('a main-loop turn counts under the phase, and the ledger file is per session', PRIMARY, async ($, on) => {
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
    const ledger = state.writes.get('/home/me/.claude/openspec-board/ledgers/demo-change/sess-1.json')
    expect(ledger).toBeDefined()
    expect(JSON.parse(ledger ?? '{}').main).toEqual({ apply: { input: 1000, output: 2000, cacheRead: 40_000, cacheWrite: 500 } })
  })

  test('the spec-reviewer report becomes finding counts', PRIMARY, async ($, on) => {
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

  test('design mode before any change, then the proposal takes over the tokens', PRIMARY, async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const files = Object.fromEntries(Object.entries(DEMO_FILES).filter(([path]) => !path.startsWith(CHANGE)))
    const state = world(on, files)
    on('command.run', () => ({ text: '' }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('designer', 'update export-dialog'))
    await clock.advance(4500)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Design mode/ }))?.text).toBe('Design mode: no change yet.')
    // The view is approved, but the session still designs it: Design stays active until the next step.
    expect((await ui.find({ key: 'design:export-dialog' }))?.text).toContain('approved 2026-10-11 · in review')
    expect((await ui.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toContain('›  ▶  Design  › ○  Propose')
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:propose')
    await ui.unmount()

    await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't-d', usage: { ...USAGE, model: 'm' }, reason: 'answer' })
    for (const [path, text] of Object.entries(DEMO_FILES)) {
      state.files.set(norm(path), text)
    }
    await $.command.run(typed('opsx:propose', 'demo-change'))
    await clock.advance(6000)
    const ledger = JSON.parse(state.writes.get('/home/me/.claude/openspec-board/ledgers/demo-change/sess-1.json') ?? '{}')
    expect(ledger.main?.design).toEqual({ input: 1000, output: 2000, cacheRead: 40_000, cacheWrite: 500 })
  })

  test('Propose and Design stay in review until the next step starts', PRIMARY, async ($, on) => {
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
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await $.command.run(typed('openspec-board', ''))
    await clock.advance(300)
    const rail = async () => (await ui.find({ type: 'Text', text: /Plan .* Archive/ }))?.text
    const why = async () => (await ui.find({ type: 'Text', text: /^fills the prompt/ }))?.text

    // Every artifact is written, and no apply has started: the person still reviews them.
    await $.command.run(typed('designer', 'update export-dialog'))
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

    // An interrupt stops the apply run: Next offers to apply again.
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't-a', reason: 'aborted' })
    await clock.advance(300)
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:apply demo-change')
    expect(await why()).toContain('the apply run stopped')

    // The strict validation at the start of the next run refuses the change: the review goes on.
    await clock.advance(6000)
    await $.command.run(typed('opsx:apply', 'demo-change'))
    await $.tool.call({ tool: 'Bash', command: 'openspec validate demo-change --strict' })
    await clock.advance(300)
    expect(await rail()).toContain('✔  Design ›  ▶  Propose  › ○  Apply')
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:apply demo-change')
    expect(await why()).toContain('openspec validate --strict refused the change')
    await ui.unmount()
  })

  test('a task left [~] does not hold back the archive after the pull request', PRIMARY, async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    world(on, { ...DEMO_FILES, [`${CHANGE}/tasks.md`]: TASKS_MD.replace(/- \[ \]/g, '- [x]') })
    on('command.run', () => ({ text: '' }))
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('opsx:apply', 'demo-change'))
    await $.command.run(typed('openspec-board', ''))
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // Task 1.2 stays [~] for the owner, and the pull request exists: the run is over.
    expect((await ui.find({ key: 'next' }))?.text).toBe('Next: /opsx:archive demo-change')
    expect((await ui.find({ type: 'Text', text: /^fills the prompt/ }))?.text).toContain('1 task stays [~]')
    await ui.unmount()
  })

  test('rows open their target: artifacts and planning items in the reader, the design and the PR in the browser', PRIMARY, async ($, on) => {
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
    expect(state.opened.filter(id => id !== 'openspec-board')).toEqual([])
    expect((await board.find({ key: 'doc' }))?.text).toContain('## Planning Items')
    expect((await board.find({ type: 'Text', text: /proposal\.md$/ }))?.text).toContain('/repo/openspec/changes/demo-change/proposal.md')
    expect(await board.find({ key: 'artifact:tasks' })).toBeUndefined()
    expect((await board.find({ key: 'back' }))?.props).toMatchObject({ hotkey: 'b' })

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

  test('the reader view leaves the board after a close or the board command', PRIMARY, async ($, on) => {
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
      await $.command.run(typed('openspec-board', 'close'))
      expect(state.closed.at(-1)).toBe('openspec-board')
      expect(await board.find({ key: 'doc' })).toBeUndefined()
      expect(await board.find({ key: 'artifact:proposal' })).toBeDefined()

      // The board command shows the board, also from the reader view.
      await board.press({ key: 'artifact:proposal' })
      expect((await board.find({ key: 'doc' }))?.text).toContain('## Planning Items')
      await $.command.run(typed('openspec-board', ''))
      expect(await board.find({ key: 'doc' })).toBeUndefined()
      await board.press({ key: 'fold:propose' })
      await board.unmount()
    }
  })

  test('a pinned archived change finds the pull request that merged it', PRIMARY, async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES, 'main')
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('openspec-board', 'csv-import'))
    await clock.advance(300)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toContain('✔  PR › ✔  Archive')
    expect((await board.find({ key: 'pr' }))?.text).toContain('#226 merged')
    await board.press({ key: 'pr' })
    expect(state.runs.at(-1)).toBe('xdg-open https://github.com/o/r/pull/226')
    await board.unmount()
  })

  test("an archived change seen from its own branch: the branch's pull request, when its commits hold the archive commit", PRIMARY, async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES, 'csv-import')
    // On the branch, the commit that archived the change has no pull request number yet.
    state.archiveLog = `${ARCHIVE_HASH}\tdocs(csv-import): archive change\n`
    state.prs = JSON.stringify([{ number: 230, state: 'MERGED', url: 'https://github.com/o/r/pull/230', commits: [{ oid: 'a1' }, { oid: ARCHIVE_HASH }] }])
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('openspec-board', 'csv-import'))
    await clock.advance(300)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ key: 'pr' }))?.text).toContain('#230 merged')
    expect(state.runs).toContain('gh pr list --head csv-import --state all --json number,state,url,commits --limit 1')
    await board.unmount()
  })

  test('an archived change keeps no pull request of its branch that does not hold its archive commit', PRIMARY, async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    // A branch of another change: an older change archived by a commit without a number.
    const state = world(on, DEMO_FILES, 'worktree-demo-change')
    state.archiveLog = `${ARCHIVE_HASH}\tdocs(csv-import): archive change\n`
    state.prs = JSON.stringify([{ number: 231, state: 'OPEN', url: 'https://github.com/o/r/pull/231', commits: [{ oid: 'b2' }] }])
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('openspec-board', 'csv-import'))
    await clock.advance(300)
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toContain('✔  PR › ✔  Archive')
    expect((await board.find({ key: 'pr' }))?.text).not.toContain('#231')
    await board.unmount()
  })

  test('a change name that is not kebab-case never reaches a command line or a ledger path', PRIMARY, async ($, on) => {
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
    expect(await $.command.run(typed('openspec-board', '../..'))).toMatchObject({ text: expect.stringContaining('is not a change name') })
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't-x', usage: { ...USAGE, model: 'm' }, reason: 'answer' })
    await clock.advance(6000)
    expect(state.runs.some(run => run.includes('&') || run.includes('..'))).toBe(false)
    expect([...state.writes.keys()].every(path => path.startsWith('/home/me/.claude/openspec-board/ledgers/demo-change/'))).toBe(true)
  })

  test('a subagent gets the progress note only during an apply run', PRIMARY, async ($, on) => {
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
    expect(prompts.at(-1)).toContain('mcp__openspec-board__progress')
    // Review and planning agents never get it.
    await $.agent.spawn(spawn('spec-reviewer', 'Review', 'Review the change.'))
    expect(prompts.at(-1)).toBe('Review the change.')
  })

  test('explore before any change, then the proposal takes over its tokens', PRIMARY, async ($, on) => {
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
    const ledger = JSON.parse(state.writes.get('/home/me/.claude/openspec-board/ledgers/demo-change/sess-1.json') ?? '{}')
    expect(ledger.main?.explore).toEqual({ input: 1000, output: 2000, cacheRead: 40_000, cacheWrite: 500 })
    const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await board.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toContain('✔  Plan › ✔  Explore › ')
    expect((await board.find({ key: 'fold:explore' }))?.text).toContain('Explore')
    await board.unmount()
  })

  test('explore binds only an argument that names an existing change', PRIMARY, async ($, on) => {
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
    await $.command.run(typed('openspec-board', 'other-change'))
    await clock.advance(300)
    expect((await ui.find({ type: 'Text', text: /^other-change$/ }))?.text).toBe('other-change')
    expect((await ui.find({ type: 'Text', text: /Plan .* Archive/ }))?.text).toContain('–  Explore')
    expect(await ui.find({ type: 'Text', text: /export-ideas/ })).toBeUndefined()
    await ui.unmount()
  })

  test('two active changes: the branch decides, else the pane asks', PRIMARY, async ($, on) => {
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

describe('openspec-board with other schemas', () => {
  const PLAIN = `${CWD}/openspec/changes/plain-change`
  const PLAIN_FILES: Record<string, string> = {
    [`${PLAIN}/.openspec.yaml`]: 'schema: spec-driven\ncreated: 2026-10-30\n',
    [`${PLAIN}/proposal.md`]: PROPOSAL_MD,
  }

  test('a spec-driven change without hints: no Plan or Design, and the artifacts and their order from the CLI', PRIMARY, async ($, on) => {
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
    await $.command.run(typed('openspec-board', ''))
    await clock.advance(300)
    await ui.press({ key: 'artifact:proposal' })
    expect((await ui.find({ key: 'doc' }))?.text).toContain('del /q *')
    await ui.press({ key: 'external' })
    expect(state.toasts.at(-1)).toBe(`Could not open proposal.cmd · plain-change: ${PLAIN}/proposal.cmd`)
    expect(state.runs.some(run => run.includes('proposal.cmd'))).toBe(false)
    await ui.unmount()
  })

  test('an archived change of a forked schema: its artifacts come from its schema.yaml, in requires order', PRIMARY, async ($, on) => {
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
    await $.command.run(typed('openspec-board', 'team-change'))
    await clock.advance(300)
    expect(state.runs).toContain('openspec schema which team-flow --json')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Explore .* Archive/ }))?.text).toContain('✔  Apply › ✔  Verify › ✔  PR › ✔  Archive')
    expect((await ui.find({ type: 'Text', text: /artifacts$/ }))?.text).toBe('3/5 artifacts')
    await ui.press({ key: 'fold:propose' })
    const rows = []
    for (const id of ['proposal', 'research', 'specs', 'design', 'tasks']) {
      rows.push((await ui.find({ key: `artifact:${id}` }))?.text.trim().slice(0, 1))
    }
    expect(rows).toEqual(['✔', '✔', '○', '○', '✔'])
    await ui.unmount()
  })

  test("a board.yaml in the person's folder wins over the one beside the schema", PRIMARY, async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    world(on, {
      ...DEMO_FILES,
      '/home/me/.claude/openspec-board/schemas/gated-spec-driven/board.yaml': 'version: 1\nverify: { label: Check }\n',
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

describe('openspec-board with GitHub issues', () => {
  const GH = `${CWD}/openspec/changes/gh-change`
  const GH_FILES: Record<string, string> = {
    [`${GH}/.openspec.yaml`]: 'schema: spec-driven\ncreated: 2026-10-31\n',
    [`${GH}/proposal.md`]: GITHUB_PROPOSAL_MD,
    [`${GH}/tasks.md`]: '## 1. Build\n\n- [x] 1.1 Build the writer\n',
    '/home/me/.claude/openspec-board/schemas/spec-driven/board.yaml': GITHUB_BOARD_YAML,
  }
  const GH_STATUS = {
    ...SPEC_DRIVEN_STATUS_JSON,
    changeName: 'gh-change',
    isComplete: true,
    artifacts: SPEC_DRIVEN_STATUS_JSON.artifacts.map(artifact => ({ id: artifact.id, outputPath: artifact.outputPath, requires: artifact.requires, status: 'done' })),
  }
  const issueRuns = (state: World) => state.runs.filter(run => run.startsWith('gh issue view'))

  test('the issues of the proposal, the branch, and the pull request, with their state from gh', PRIMARY, async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 31, 20) })
    const state = world(on, GH_FILES, '34-csv-export')
    state.status = { 'gh-change': GH_STATUS }
    state.prs = GITHUB_PRS
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    // The board command reads the pull request, and with it the issues it closes.
    await $.command.run(typed('openspec-board', ''))
    await clock.advance(300)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Explore .* Archive/ }))?.text).toBe(
      '–  Explore › ✔  Issues › ✔  Propose › ✔  Apply › ✔  Verify › ✔  PR ›  ○  Archive ',
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
    await $.command.run(typed('openspec-board', ''))
    await clock.advance(300)
    expect(issueRuns(state).length).toBe(before)
    state.issues = { ...GITHUB_ISSUES, 'o/r#12': { ...(GITHUB_ISSUES['o/r#12'] as object), state: 'CLOSED', stateReason: 'COMPLETED' } }
    await clock.advance(121_000)
    await $.command.run(typed('openspec-board', ''))
    await clock.advance(300)
    expect(issueRuns(state).length).toBe(before + 4)
    expect((await ui.find({ key: 'plan:#12' }))?.text).toBe('[x] #12  CSV export of the library')
    await ui.unmount()
  })

  test('an issue opens in the reader as gh reads it, and its page in the browser', PRIMARY, async ($, on) => {
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

  test('without gh: no PR stage, issues without state, and verify before the archive', PRIMARY, async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 31, 20) })
    const state = world(on, GH_FILES, '34-csv-export')
    state.status = { 'gh-change': GH_STATUS }
    state.isGhMissing = true
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
    await ui.unmount()
  })

  test("the tasks come from the files the schema's apply.tracks names", PRIMARY, async ($, on) => {
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
    await $.command.run(typed('openspec-board', ''))
    await clock.advance(300)
    expect(await ui.find({ key: 'group:1' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('openspec-board in shadow mode, beside the opsx-board mod', () => {
  test('it adds no tool, no prompt note, no toast, and no status line, and opens only on its own command', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    const state = world(on, DEMO_FILES)
    on('command.run', () => ({ text: '' }))
    on('turn.complete', () => ({ text: '' }))
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
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't-2', agentId: 'agent-2', reason: 'answer' })
    await clock.advance(6000)
    expect(state.tools).toEqual([])
    expect(state.opened).toEqual([])
    expect(state.toasts).toEqual([])
    expect(state.statuses).toEqual([])

    await $.command.run(typed('openspec-board', ''))
    expect(state.opened).toEqual(['openspec-board'])
  })

  test('it reads the progress reports that agents send to the opsx-board tool', async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 22, 20) })
    world(on, DEMO_FILES)
    on('command.run', () => ({ text: '' }))
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-2' }))
    on('turn.step', async function* (_, e) {
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: [{ name: 'mcp__opsx-board__progress', input: { change: 'demo-change', group: '2', task: '2.2', state: 'start' } }],
        stopReason: 'tool_use' as const,
        usage: { ...USAGE, model: 'claude-opus-5-5' },
      }
    })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await clock.advance(300)
    await $.command.run(typed('opsx:apply', 'demo-change'))
    // The prompt names no group, so only the report can place the agent.
    await $.agent.spawn(spawn('general-purpose', 'Implement the next part', 'Implement the next part.'))
    for await (const chunk of $.turn.step({ turnId: 't-2', index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId: 'agent-2' })) {
      void chunk
    }
    await clock.advance(1000)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'task:2.2' }))?.text).toContain('← general-purpose')
    expect((await ui.find({ key: 'group-agent:2' }))?.text).toContain('general-purpose')
    await ui.unmount()
  })
})
