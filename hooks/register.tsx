// opsx-board: a live pane for the OpenSpec lifecycle of the change this session works on.
// It observes the workflow (CLI JSON, files, git, session events) and changes no workflow file.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderInput, Register } from 'claude-code'

import type {
  AgentRun,
  Binding,
  BindingSource,
  BoardHints,
  DesignView,
  Flags,
  Live,
  MainUsage,
  Others,
  Phase,
  PlanningItem,
  ReaderDoc,
  Report,
  SessionFigures,
  Snapshot,
  Usage,
} from '../types'
import {
  PRE_CHANGE,
  addUsage,
  agentTokens,
  boardHome,
  claimOldLedgers,
  fromModelUsage,
  projectLedgers,
  readOthers,
  tokensOf,
  usageBeyond,
  writeLedger,
  zeroUsage,
} from './ledger'
import { currentStage, phaseOfStage, statusLine } from './model'
import { stagesOf } from './stages'
import { groupViews } from './stages/apply'
import { findingsNote, isApplyRun, isDesigning, isExploring } from './stages/evidence'
import { prWords } from './hosts'
import {
  changeFromArgs,
  changeFromBranch,
  changeOfPath,
  countDone,
  countFindings,
  createdChanges,
  designFromArgs,
  formatDuration,
  formatTokens,
  inferGroup,
  isChangeName,
  isTracked,
  parseVerifyVerdict,
  phaseOfCommand,
} from './parse'
import { openItem, planFiles, refreshPlan } from './providers'
import {
  collectDesigns,
  collectGit,
  collectSnapshot,
  currentBranch,
  hasChange,
  loadHints,
  openExternal,
  projectSchema,
  readFile,
  signature,
} from './sources'
import { PANE, renderPane, renderReader } from './view'

type Engine = EngineInterface

// The session values the pane draws from, each declared in ../types/index.d.ts.
const bindingAtom = atom({ plugin: 'opsx-board', key: 'binding' } as const, { candidates: [] } as Binding)
const snapshotAtom = atom({ plugin: 'opsx-board', key: 'snapshot' } as const, null as Snapshot | null)
const liveAtom = atom({ plugin: 'opsx-board', key: 'live' } as const, { designRuns: [] } as Live)
const agentsAtom = atom({ plugin: 'opsx-board', key: 'agents' } as const, [] as AgentRun[])
const mainAtom = atom({ plugin: 'opsx-board', key: 'main' } as const, {} as MainUsage)
const reportsAtom = atom({ plugin: 'opsx-board', key: 'reports' } as const, [] as Report[])
const othersAtom = atom(
  { plugin: 'opsx-board', key: 'others' } as const,
  { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, sessions: 0, activeChanges: [] } as Others,
)
const figuresAtom = atom({ plugin: 'opsx-board', key: 'figures' } as const, {} as SessionFigures)
const foldedAtom = atom({ plugin: 'opsx-board', key: 'folded' } as const, {} as Flags)
const expandedAtom = atom({ plugin: 'opsx-board', key: 'expanded' } as const, {} as Flags)
const readerAtom = atom({ plugin: 'opsx-board', key: 'reader' } as const, null as ReaderDoc | null)
const hintsAtom = atom({ plugin: 'opsx-board', key: 'hints' } as const, null as BoardHints | null)

const TITLE = 'OpenSpec board'
const COMMAND = 'opsx-board'
const TOOL = 'progress'
const TOOL_NAME = 'mcp__opsx-board__progress'
const TICK_MS = 4000
const GIT_MS = 30_000
const PR_MS = 60_000
const LEDGER_MS = 5000
const RECENT_MS = 30 * 60 * 1000
// The built-in agents that never implement a task. The hints add the project's own.
const NO_REPORT = ['Explore', 'Plan', 'claude-code-guide', 'statusline-setup']
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'] as const

// Module variables start over on a hot reload; register and session.start run again then.
let isReportTool = false
let cwd = ''
let sessionId = ''
// The ledger folder of the session's project, and the session folder it was found for.
let ledger: { cwd: string; home: string; root: string; dir: string } | undefined
// The changes whose old, shared ledgers this session has already looked for.
const claimedChanges = new Set<string>()
let lastSignature = ''
let lastGitAt = 0
let lastPrAt = 0
let lastLedgerAt = 0
let isLedgerDirty = false
let isRefreshing = false
let isQueued = false
let isQueuedGit = false
let isQueuedPr = false
let lastCommandKey = ''

const applyNote = (change: string) => `

## Progress display (opsx-board)

A status pane shows this run. While you implement OpenSpec change \`${change}\`:
- Before you start a task that you run yourself (for example group 0 or the Verification group), call \`${TOOL_NAME}\` with \`{"change": "${change}", "group": "<N>", "task": "<N.M>", "state": "start"}\`, and call it with \`"state": "done"\` after the task.
- The subagents of the task groups get the same instruction from the pane. You do not need to repeat it in their prompts.
The tool only updates the display. It returns "ok" and changes no file.`

const subagentNote = (change: string) => `

[opsx-board] While you work on OpenSpec change "${change}": before each task, call the tool ${TOOL_NAME} with {"change": "${change}", "group": "<N>", "task": "<N.M>", "state": "start"}, and after it, call the tool again with "state": "done". If you are blocked, use "state": "blocked" and a short "note". The tool only updates a status display and returns "ok".`

async function sessionCwd($: Engine): Promise<string> {
  cwd ||= await $.session.cwd()

  return cwd
}

/**
 * Follows the session into or out of a worktree, and says whether it moved. Only the board's
 * timer calls this: a timer reads the session's folder, a subagent's hook its own.
 */
async function followCwd($: Engine): Promise<boolean> {
  const now = await $.session.cwd().catch(() => '')
  if (cwd === '' || now === '' || now === cwd) {
    return false
  }
  cwd = now
  lastSignature = ''
  lastGitAt = 0
  lastPrAt = 0

  return true
}

/**
 * The folder that holds the bound change: the session's, unless the session moved and only the
 * folder it left still holds the change, such as a worktree it kept.
 */
async function changeRoot($: Engine, dir: string, change: string, previous: Snapshot | null): Promise<string> {
  const before = previous?.change === change ? previous.root : undefined
  if (before === undefined || before === dir || (await hasChange($, dir, change))) {
    return dir
  }

  return (await hasChange($, before, change)) ? before : dir
}

async function tick($: Engine): Promise<void> {
  const isMoved = await followCwd($)
  void flushLedger($, false)
  await refresh($, isMoved ? { isForced: true, isGit: true, isPr: true } : {})
}

/**
 * The hints the session works with: those of the bound change's schema once a snapshot has
 * read them, else those of the project's schema, read now.
 */
async function currentHints($: Engine): Promise<BoardHints> {
  const known = await read($, hintsAtom)
  if (known !== null) {
    return known
  }
  const dir = await sessionCwd($)
  const hints = await loadHints($, dir, await projectSchema($, dir))
  await update($, hintsAtom, current => current ?? hints)

  return hints
}

async function currentPhase($: Engine): Promise<Phase> {
  const [live, snap, agents, hints] = await Promise.all([read($, liveAtom), read($, snapshotAtom), read($, agentsAtom), currentHints($)])
  const now = await $.clock.now()
  const recent = live.command !== undefined && now - live.command.at < RECENT_MS ? phaseOfCommand(live.command.name, hints) : undefined
  if (recent !== undefined) {
    return recent
  }
  if (isExploring(live)) {
    return 'explore'
  }
  if (isDesigning(live, hints)) {
    return 'design'
  }

  // Talk before any change exists is planning.
  return snap === null ? 'plan' : phaseOfStage(currentStage(stagesOf(snap, live, agents, now, [], hints)))
}

async function showStatus($: Engine): Promise<void> {
  const [snap, live, agents, reports, binding] = await Promise.all([
    read($, snapshotAtom),
    read($, liveAtom),
    read($, agentsAtom),
    read($, reportsAtom),
    read($, bindingAtom),
  ])
  const now = await $.clock.now()
  const hints = await read($, hintsAtom)
  const own = agents.filter(agent => agent.change === binding.change)
  const shown = snap !== null && snap.change === binding.change ? snap : null
  const stages = stagesOf(shown, live, own, now, [], hints)
  $.ui.status(statusLine(shown, stages, groupViews(shown, own, reports, live, hints), live))
}

/** A toast about the workflow. */
function notify($: Engine, text: string): void {
  $.ui.toast(text)
}

/** Opens the pane by itself, on a workflow command, unless the person closed it for this change. */
async function openPane($: Engine): Promise<void> {
  const binding = await read($, bindingAtom)
  if (binding.dismissedFor !== undefined && binding.dismissedFor === (binding.change ?? PRE_CHANGE)) {
    return
  }
  await $.ui.open({ id: PANE, title: TITLE })
}

/**
 * Binds the session to a change, and moves the tokens spent before any change into it.
 * A name that is not kebab-case is refused: it would reach `cmd /c` and a ledger path.
 */
async function bind($: Engine, change: string, source: BindingSource): Promise<boolean> {
  if (!isChangeName(change)) {
    return false
  }
  await update($, bindingAtom, b => ({ ...b, change, source, candidates: [], query: undefined }))
  await update($, mainAtom, main => {
    const pre = main[PRE_CHANGE]
    if (pre === undefined) {
      return main
    }
    const target = { ...(main[change] ?? {}) }
    for (const [phase, usage] of Object.entries(pre)) {
      target[phase] = addUsage(target[phase] ?? zeroUsage(), usage)
    }
    const rest = { ...main }
    delete rest[PRE_CHANGE]

    return { ...rest, [change]: target }
  })
  await update($, agentsAtom, list => list.map(agent => (agent.change === undefined ? { ...agent, change } : agent)))
  await update($, liveAtom, live =>
    live.exploreRuns === undefined
      ? live
      : { ...live, exploreRuns: live.exploreRuns.map(run => (run.change === undefined ? { ...run, change } : run)) },
  )
  isLedgerDirty = true

  return true
}

/**
 * The active change folders with a kebab-case name. The planning-integrity rule counts a
 * folder with proposal.md or tasks.md. This list also counts a folder with only
 * `.openspec.yaml`, so the pane follows `/opsx:new` before the proposal exists.
 */
async function activeChanges($: Engine, dir: string): Promise<string[]> {
  const entries = await $.fs.list(`${dir}/openspec/changes`).catch(() => [])
  const names = entries
    .filter(entry => entry.kind === 'dir' && entry.name !== 'archive' && isChangeName(entry.name))
    .map(entry => entry.name)
  const found: string[] = []
  for (const name of names) {
    const base = `${dir}/openspec/changes/${name}`
    if ((await $.fs.exists(`${base}/proposal.md`)) || (await $.fs.exists(`${base}/tasks.md`)) || (await $.fs.exists(`${base}/.openspec.yaml`))) {
      found.push(name)
    }
  }

  return found
}

/**
 * The changes newest first, by the time of their folder, proposal, or tasks: a change just
 * created or worked on heads the picker.
 */
async function newestFirst($: Engine, dir: string, changes: readonly string[]): Promise<string[]> {
  const timeOf = async (path: string) => (await $.fs.stat(path).catch(() => undefined))?.mtimeMs ?? 0
  const times = new Map<string, number>()
  for (const name of changes) {
    const base = `${dir}/openspec/changes/${name}`
    times.set(name, Math.max(await timeOf(base), await timeOf(`${base}/proposal.md`), await timeOf(`${base}/tasks.md`)))
  }

  return [...changes].sort((a, b) => (times.get(b) ?? 0) - (times.get(a) ?? 0) || a.localeCompare(b))
}

// The bindings that only a command, a pin, a pick, or the session's own work changes.
const STICKY: readonly BindingSource[] = ['command', 'pinned', 'pick', 'created', 'written']

async function resolveBinding($: Engine, dir: string): Promise<void> {
  const binding = await read($, bindingAtom)
  if (binding.source !== undefined && STICKY.includes(binding.source)) {
    return
  }
  const changes = await activeChanges($, dir)
  const only = changes.length === 1 ? changes[0] : undefined
  if (only !== undefined) {
    if (binding.change !== only) {
      await bind($, only, 'list')
    }
    return
  }
  if (changes.length > 1) {
    const branch = await currentBranch($, dir)
    const match = branch === undefined ? undefined : changeFromBranch(branch, changes)
    if (match !== undefined) {
      if (binding.change !== match) {
        await bind($, match, 'branch')
      }
      return
    }
    if (binding.change === undefined || !changes.includes(binding.change)) {
      const candidates = await newestFirst($, dir, changes)
      // Unless the session bound a change meanwhile, by a tool call that ended during this read.
      await update($, bindingAtom, b => (b.change !== binding.change ? b : { ...b, change: undefined, source: undefined, candidates }))
    }
  }
  // No active change: a bound change stays, so an archived change still shows its end state.
}

async function announce($: Engine, before: Snapshot | null, after: Snapshot): Promise<void> {
  if (before === null || before.change !== after.change) {
    return
  }
  if (!before.isPlanningComplete && after.isPlanningComplete) {
    notify($, `${after.change}: all artifacts are written. Review them, then run /opsx:apply`)
  }
  for (const verdict of after.verdicts ?? []) {
    if (!(before.verdicts ?? []).some(old => old.artifact === verdict.artifact)) {
      notify($, `${verdict.artifact}: ${verdict.value}`)
    }
  }
  const agents = await read($, agentsAtom)
  for (const group of after.groups) {
    const old = before.groups.find(item => item.num === group.num)
    const isNowDone = group.tasks.length > 0 && countDone(group) === group.tasks.length
    const wasDone = old !== undefined && old.tasks.length > 0 && countDone(old) === old.tasks.length
    if (isNowDone && !wasDone) {
      const own = agents.filter(agent => agent.change === after.change && agent.group === group.num)
      const tokens = own.reduce((sum, agent) => sum + agentTokens(agent), 0)
      notify($, `Group ${group.num} done: ${group.title}${tokens > 0 ? ` · ${formatTokens(tokens)} tokens` : ''}`)
    }
  }
  if (before.pr === undefined && after.pr !== undefined) {
    const words = prWords(after.prHost)
    notify($, `${words.title} ${words.ref(after.pr.number)} ${after.pr.state.toLowerCase()}`)
  }
  if (before.archivedAs === undefined && after.archivedAs !== undefined) {
    notify($, `${after.change} archived`)
  }
}

async function flushLedger($: Engine, isForced: boolean): Promise<void> {
  const now = await $.clock.now()
  if (!isLedgerDirty || (!isForced && now - lastLedgerAt < LEDGER_MS)) {
    return
  }
  const project = await projectLedger($)
  sessionId ||= await $.session.id()
  if (project === undefined) {
    return
  }
  const [binding, main, agents] = await Promise.all([read($, bindingAtom), read($, mainAtom), read($, agentsAtom)])
  const change = binding.change ?? PRE_CHANGE
  isLedgerDirty = false
  lastLedgerAt = now
  await writeLedger($, project.dir, {
    change,
    sessionId,
    root: project.root,
    updatedAt: now,
    main: main[change] ?? {},
    agents: agents
      .filter(agent => (agent.change ?? PRE_CHANGE) === change)
      .map(agent => ({ id: agent.id, type: agent.type, group: agent.group, usage: agent.usage, totalTokens: agent.totalTokens })),
  }).catch(() => {
    isLedgerDirty = true
  })
}

/**
 * The ledger folder of the session's project. A project is its git repository, which every
 * worktree of it shares (`$.session.repo()` gives the main working tree's root), else the
 * session's folder. Found again when the session changes folder.
 */
async function projectLedger($: Engine): Promise<{ home: string; root: string; dir: string } | undefined> {
  const here = await sessionCwd($)
  if (ledger?.cwd === here) {
    return ledger
  }
  const home = await boardHome($)
  if (home === undefined) {
    return undefined
  }
  const repo = await $.session.repo().catch(() => null)
  const root = repo?.root || here
  ledger = { cwd: here, home, root, dir: projectLedgers(home, root) }

  return ledger
}

async function refreshOthers($: Engine): Promise<void> {
  const project = await projectLedger($)
  sessionId ||= await $.session.id()
  if (project === undefined) {
    return
  }
  const [binding, snap] = await Promise.all([read($, bindingAtom), read($, snapshotAtom)])
  // Once per change and session: a change this project holds takes its old, shared ledgers.
  const change = binding.change
  if (change !== undefined && snap?.change === change && !claimedChanges.has(change)) {
    claimedChanges.add(change)
    await claimOldLedgers($, project.home, project.dir, change, project.root).catch(() => false)
  }
  const others = await readOthers($, project.dir, change, sessionId).catch(() => undefined)
  if (others !== undefined) {
    await update($, othersAtom, () => others)
  }
}

type RefreshRequest = { isForced?: boolean; isGit?: boolean; isPr?: boolean }

const designOnly = (designs: DesignView[], root: string, now: number): Snapshot => ({
  change: '',
  root,
  dir: '',
  specs: [],
  exists: false,
  artifacts: [],
  isPlanningComplete: false,
  specsCount: 0,
  groups: [],
  verdicts: [],
  planning: [],
  designs,
  commits: [],
  refreshedAt: now,
  warnings: [],
})

async function refresh($: Engine, request: RefreshRequest): Promise<void> {
  if (isRefreshing) {
    isQueued = true
    isQueuedGit ||= request.isGit === true
    isQueuedPr ||= request.isPr === true
    return
  }
  isRefreshing = true
  try {
    const dir = await sessionCwd($)
    const now = await $.clock.now()
    await resolveBinding($, dir)
    const [binding, live, previous, known] = await Promise.all([read($, bindingAtom), read($, liveAtom), read($, snapshotAtom), read($, hintsAtom)])
    const designViews = live.designRuns.map(run => run.view)
    if (binding.change === undefined) {
      // Design mode: the views the design command touched, before any change exists. The
      // project's schema gives the hints.
      const hints = await loadHints($, dir, await projectSchema($, dir))
      const designs = live.designRuns.length === 0 ? [] : await collectDesigns($, dir, undefined, live.designRuns, hints.design)
      const key = `none|${JSON.stringify(designs)}|${binding.candidates.join(',')}|${JSON.stringify(hints)}`
      if (key !== lastSignature || request.isForced === true) {
        lastSignature = key
        await update($, hintsAtom, () => hints)
        await update($, snapshotAtom, () => (designs.length === 0 ? null : designOnly(designs, dir, now)))
      }
      return
    }
    const root = await changeRoot($, dir, binding.change, previous)
    const fingerprint = await signature($, root, binding.change, known, designViews)
    const isGitDue = request.isGit === true || now - lastGitAt > GIT_MS
    // A change with work on its branch, or one whose open pull request no branch read finds:
    // archived on its branch, or seen from the main branch.
    const isOffBranch = previous?.archivedAs !== undefined || previous?.branch === 'main' || previous?.branch === 'HEAD'
    const isMidFlight =
      previous !== null &&
      ((previous.archivedAs === undefined && previous.commits.some(commit => commit.kind === 'artifacts' || commit.kind === 'task')) ||
        (isOffBranch && previous.pr?.state === 'OPEN'))
    const isPrDue = request.isPr === true || (isMidFlight && now - lastPrAt > PR_MS)
    const isSame = fingerprint === lastSignature && previous?.change === binding.change && previous.root === root
    if (isSame && request.isForced !== true && !isGitDue && !isPrDue) {
      return
    }
    // Only git or the pull request is due: refresh those, and run no openspec CLI.
    const collected =
      isSame && request.isForced !== true && previous !== null && known !== null
        ? { snap: await refreshGit($, root, previous, known, isGitDue, isPrDue, now), hints: known }
        : await collectSnapshot($, root, binding.change, { runs: live.designRuns, previous, isGitDue, isPrDue, now })
    const snap = collected.snap
    // The fingerprint names the files of the hints; new hints may name other files.
    const isNewHints = JSON.stringify(collected.hints) !== JSON.stringify(known)
    lastSignature = isNewHints ? '' : fingerprint
    if (isGitDue) {
      lastGitAt = now
    }
    if (isPrDue) {
      lastPrAt = now
    }
    if (isNewHints) {
      await update($, hintsAtom, () => collected.hints)
    }
    await update($, snapshotAtom, () => snap)
    await announce($, previous, snap)
  } finally {
    isRefreshing = false
    await showStatus($).catch(() => undefined)
    if (isQueued) {
      const again: RefreshRequest = { isForced: true, isGit: isQueuedGit, isPr: isQueuedPr }
      isQueued = false
      isQueuedGit = false
      isQueuedPr = false
      $.clock.after(50, () => void refresh($, again))
    }
  }
}

async function noteCommand($: Engine, name: string, args: string): Promise<void> {
  const hints = await currentHints($)
  if (!isTracked(name, hints)) {
    return
  }
  const now = await $.clock.now()
  const key = `${name} ${args}`
  if (key === lastCommandKey) {
    return
  }
  lastCommandKey = key
  $.clock.after(5000, () => {
    if (lastCommandKey === key) {
      lastCommandKey = ''
    }
  })
  await update($, liveAtom, live => ({ ...live, command: { name, args, at: now } }))
  if (phaseOfCommand(name, hints) === 'design') {
    const run = designFromArgs(args, hints.design?.skipArgs)
    if (run !== undefined) {
      await update($, liveAtom, live => ({
        ...live,
        designRuns: [...live.designRuns.filter(item => item.view !== run.view), { ...run, at: now }],
      }))
    }
  } else if (name === 'opsx:explore') {
    // Explore takes a topic. Its argument binds only when it names an active change, which
    // explore then reads for context, as explore.md resolves it with `openspec status`.
    const named = changeFromArgs(args)
    if (named !== undefined && (await activeChanges($, await sessionCwd($))).includes(named)) {
      await bind($, named, 'command')
    }
    const { change } = await read($, bindingAtom)
    const run = { topic: args.trim(), at: now, change }
    await update($, liveAtom, live => ({ ...live, exploreRuns: [...(live.exploreRuns ?? []), run].slice(-20) }))
  } else {
    const change = changeFromArgs(args)
    if (change !== undefined) {
      await bind($, change, 'command')
    }
  }
  // The command is for the change the session is bound to now, also when it named none.
  const { change: bound } = await read($, bindingAtom)
  await update($, liveAtom, live => (live.command?.at === now ? { ...live, command: { ...live.command, change: bound } } : live))
  await openPane($)
  $.clock.after(100, () => void refresh($, { isForced: true, isGit: true }))
}

async function startSession($: Engine, dir: string): Promise<void> {
  await $.command.register({
    name: COMMAND,
    description: 'Show the OpenSpec stage of this session’s change in a pane',
    argumentHint: '[change | auto | close]',
  })
  if (isReportTool) {
    await $.tool.register({
      name: TOOL,
      description:
        'Report OpenSpec task progress to the opsx-board status pane. Call it with state "start" before a task of an OpenSpec change and "done" after it. It only updates a display and returns "ok".',
      inputSchema: {
        type: 'object',
        properties: {
          change: { type: 'string', description: 'The OpenSpec change name' },
          group: { type: 'string', description: 'The task group number, such as "2"' },
          task: { type: 'string', description: 'The task id, such as "2.3"' },
          state: { type: 'string', enum: ['start', 'done', 'blocked'] },
          note: { type: 'string', description: 'A short note, for a blocked task' },
        },
        required: ['group', 'state'],
      },
      isDeferred: false,
    })
  }
  cwd = dir
  // A new session finds its project, and looks for old ledgers, afresh.
  ledger = undefined
  claimedChanges.clear()
  $.clock.every(TICK_MS, () => void tick($))
  $.clock.every(GIT_MS, () => void refreshOthers($))
  $.clock.after(200, () => {
    void refresh($, { isForced: true, isGit: true })
    void refreshOthers($)
  })
}

async function runBoardCommand($: Engine, arg: string): Promise<string> {
  // The command shows the board itself, also when the pane last showed a document.
  await update($, readerAtom, () => null)
  if (arg === 'close') {
    await $.ui.close({ id: PANE })

    return 'OpenSpec pane closed.'
  }
  if (arg === 'auto') {
    await update($, bindingAtom, b => ({ ...b, source: undefined, change: undefined }))
  } else if (arg !== '' && !(await bind($, arg, 'pinned'))) {
    return `"${arg}" is not a change name. A change name is kebab-case, such as add-csv-export.`
  }
  await update($, bindingAtom, b => ({ ...b, dismissedFor: undefined }))
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  $.clock.after(50, () => void refresh($, { isForced: true, isGit: true, isPr: true }))
  const binding = await read($, bindingAtom)

  return opened.isPlaced
    ? `OpenSpec pane open${binding.change === undefined ? '' : ` for ${binding.change}`}.`
    : `OpenSpec pane waits: ${opened.reason}`
}

async function noteSpawn($: Engine, agentId: string, input: { subagentType: string; description: string; prompt: string; background: boolean }, phase: Phase): Promise<void> {
  const [binding, snap] = await Promise.all([read($, bindingAtom), read($, snapshotAtom)])
  const now = await $.clock.now()
  const change = binding.change
  const groups = snap !== null && snap.change === change ? snap.groups : []
  const group = inferGroup(`${input.description}\n${input.prompt}`, groups)
  await update($, agentsAtom, list => {
    if (list.some(agent => agent.id === agentId)) {
      return list.map(agent => (agent.id === agentId ? { ...agent, status: 'running' as const, endedAt: undefined } : agent))
    }
    const run: AgentRun = {
      id: agentId,
      type: input.subagentType,
      description: input.description,
      phase,
      change,
      group,
      status: 'running',
      startedAt: now,
      usage: zeroUsage(),
      isBackground: input.background,
    }

    return [...list, run].slice(-300)
  })
  isLedgerDirty = true
  await showStatus($)
}

type TurnEnd = {
  turnId: string
  agentId?: string
  usage?: Parameters<typeof fromModelUsage>[0]
  durationMs: number
  reason: string
  answer: string
}

// Usage seen per turn through turn.step, so turn.complete adds only what the steps missed.
const stepUsage = new Map<string, Usage>()

/** The agent run for an id, created from `$.agent.list()` when its spawn was not heard. */
async function knownAgent($: Engine, agentId: string, durationMs: number): Promise<AgentRun> {
  const agents = await read($, agentsAtom)
  const known = agents.find(agent => agent.id === agentId)
  if (known !== undefined) {
    return known
  }
  const now = await $.clock.now()
  const listed = (await $.agent.list().catch(() => [])).find(agent => agent.id === agentId)
  const binding = await read($, bindingAtom)
  const added: AgentRun = {
    id: agentId,
    type: listed?.type ?? 'agent',
    description: listed?.description ?? '',
    phase: await currentPhase($),
    change: binding.change,
    status: 'running',
    startedAt: now - durationMs,
    usage: zeroUsage(),
    isBackground: true,
  }
  await update($, agentsAtom, list => (list.some(agent => agent.id === agentId) ? list : [...list, added].slice(-300)))

  return added
}

async function addMainUsage($: Engine, usage: Usage): Promise<void> {
  if (tokensOf(usage) === 0) {
    return
  }
  const [binding, phase] = await Promise.all([read($, bindingAtom), currentPhase($)])
  const key = binding.change ?? PRE_CHANGE
  await update($, mainAtom, main => {
    const byPhase = { ...(main[key] ?? {}) }
    byPhase[phase] = addUsage(byPhase[phase] ?? zeroUsage(), usage)

    return { ...main, [key]: byPhase }
  })
  isLedgerDirty = true
}

/** One model request ended: its tokens count at once, so a running agent's total grows live. */
async function noteStep($: Engine, turnId: string, agentId: string | undefined, usage: Usage): Promise<void> {
  stepUsage.set(turnId, addUsage(stepUsage.get(turnId) ?? zeroUsage(), usage))
  if (agentId === undefined) {
    await addMainUsage($, usage)
    return
  }
  await knownAgent($, agentId, 0)
  await update($, agentsAtom, list =>
    list.map(agent => (agent.id === agentId ? { ...agent, usage: addUsage(agent.usage, usage) } : agent)),
  )
  isLedgerDirty = true
}

/** What a turn's own usage holds beyond the steps heard for it. */
function unseenUsage(turn: TurnEnd): Usage {
  const total = fromModelUsage(turn.usage)
  const seen = stepUsage.get(turn.turnId)
  stepUsage.delete(turn.turnId)

  return seen === undefined ? total : usageBeyond(total, seen)
}

async function noteAgentEnd($: Engine, agentId: string, turn: TurnEnd): Promise<void> {
  const extra = unseenUsage(turn)
  const now = await $.clock.now()
  const known = await knownAgent($, agentId, turn.durationMs)
  await update($, agentsAtom, list =>
    list.map(agent =>
      agent.id === agentId
        ? {
            ...agent,
            usage: addUsage(agent.usage, extra),
            durationMs: (agent.durationMs ?? 0) + turn.durationMs,
            status: turn.reason === 'error' ? ('failed' as const) : ('done' as const),
            endedAt: now,
          }
        : agent,
    ),
  )
  const settled = (await read($, agentsAtom)).find(agent => agent.id === agentId) ?? known
  const hints = await currentHints($)
  if (hints.reviewAgent !== undefined && known.type === hints.reviewAgent) {
    const counts = countFindings(turn.answer, hints.findings)
    await update($, liveAtom, live => ({ ...live, reviewCounts: counts, reviewAt: now, reviewReport: turn.answer }))
    notify($, `${known.type}: ${hints.findings === undefined ? 'report received' : findingsNote(counts)}`)
  } else if (known.group !== undefined && known.phase === 'apply') {
    notify(
      $,
      `Group ${known.group} agent finished · ${formatTokens(agentTokens(settled))} tokens · ${formatDuration(settled.durationMs ?? turn.durationMs)}`,
    )
  }
  isLedgerDirty = true
  await showStatus($)
}

async function noteMainTurn($: Engine, turn: TurnEnd): Promise<void> {
  await addMainUsage($, unseenUsage(turn))
  const now = await $.clock.now()
  // The turn that ran the last workflow command is over, and with it that command's run.
  await update($, liveAtom, current => ({
    ...current,
    turnEndedAt: now,
    command: current.command === undefined || current.command.endedAt !== undefined ? current.command : { ...current.command, endedAt: now },
  }))
  if (turn.reason !== 'answer') {
    // An interrupt, an error, or a refusal stops an apply run, until the next main turn.
    await update($, liveAtom, current => ({ ...current, stoppedAt: now }))
  }
  const live = await read($, liveAtom)
  if (live.command?.name === 'opsx:verify' && now - live.command.at < RECENT_MS) {
    const verdict = parseVerifyVerdict(turn.answer)
    if (verdict !== undefined) {
      await update($, liveAtom, current => ({ ...current, verifyVerdict: verdict, verifyReport: turn.answer }))
    }
  }
  await showStatus($)
}

type AgentResult = {
  status?: string
  agentId?: string
  totalTokens?: number
  totalToolUseCount?: number
  totalDurationMs?: number
}

async function noteAgentResult($: Engine, result: AgentResult, isError: boolean): Promise<void> {
  const agentId = result.agentId
  if (result.status !== 'completed' || agentId === undefined) {
    return
  }
  await update($, agentsAtom, list =>
    list.map(agent =>
      agent.id === agentId
        ? {
            ...agent,
            totalTokens: result.totalTokens,
            toolUses: result.totalToolUseCount,
            durationMs: result.totalDurationMs ?? agent.durationMs,
            status: isError ? ('failed' as const) : ('done' as const),
          }
        : agent,
    ),
  )
  isLedgerDirty = true
}

/**
 * Binds the change that the session's own tool call created or wrote, when it is an active
 * change of the session's folder. A created change replaces any binding but a pin. A written
 * file binds only a session that has no change yet: a fix in another change moves no binding.
 */
async function bindOwnChange($: Engine, names: readonly string[], source: 'created' | 'written'): Promise<boolean> {
  const binding = await read($, bindingAtom)
  if (names.length === 0 || binding.source === 'pinned' || (source === 'written' && binding.change !== undefined)) {
    return false
  }
  const active = await activeChanges($, await sessionCwd($))
  const name = [...names].reverse().find(item => active.includes(item))
  if (name === undefined || name === binding.change) {
    return false
  }

  return bind($, name, source)
}

async function noteToolUse($: Engine, input: { tool: string; command?: string; file_path?: string; notebook_path?: string }, isError: boolean): Promise<void> {
  if (input.tool === 'Bash' || input.tool === 'PowerShell') {
    const command = input.command ?? ''
    if (/\bopenspec\s+validate\b.*--strict/.test(command)) {
      const at = await $.clock.now()
      await update($, liveAtom, live => ({ ...live, isValidateOk: !isError, validateAt: at }))
    }
    // Bound before the refresh, which reads the binding first.
    const isBound = await bindOwnChange($, createdChanges(command), 'created')
    if (isBound || /\b(openspec|git|gh|glab|mv|rm)\b/.test(command)) {
      void refresh($, { isForced: isBound, isGit: isBound || /\bgit\b/.test(command), isPr: /\bgit\s+push\b|\bgh\s+pr\b|\bglab\s+mr\b/.test(command) })
    }
    return
  }
  const path = (input.file_path ?? input.notebook_path ?? '').replace(/\\/g, '/')
  const written = isError ? undefined : changeOfPath(path)
  if (written !== undefined && path.toLowerCase().startsWith(`${(await sessionCwd($)).replace(/\\/g, '/').toLowerCase()}/`)) {
    if (await bindOwnChange($, [written], 'written')) {
      void refresh($, { isForced: true, isGit: true })
      return
    }
  }
  const hints = await read($, hintsAtom)
  // The files of the hints: the work-item files, and the design folders up to their id.
  const watched = [
    'openspec/',
    ...planFiles(hints?.plan),
    ...(hints?.design === undefined ? [] : [hints.design.dir.replace(/\{id\}.*$/, '')]),
  ]
  if (watched.some(part => part !== '' && path.includes(part))) {
    $.clock.after(300, () => void refresh($, {}))
  }
}

type ProgressInput = { agentId?: string; group?: unknown; task?: unknown; state?: unknown; note?: unknown }

async function noteProgress($: Engine, input: ProgressInput): Promise<void> {
  const now = await $.clock.now()
  const group = String(input.group ?? '').replace(/^G/i, '')
  const task = input.task === undefined ? undefined : String(input.task)
  const state = String(input.state ?? 'start')
  const note = input.note === undefined ? undefined : String(input.note)
  await update($, reportsAtom, list => [...list, { agentId: input.agentId, group, task, state, note, at: now }].slice(-500))
  const agentId = input.agentId
  if (agentId !== undefined) {
    await update($, agentsAtom, list => list.map(agent => (agent.id === agentId ? { ...agent, group, task } : agent)))
  }
  await showStatus($)
}

async function noteClose($: Engine): Promise<void> {
  await update($, bindingAtom, b => ({ ...b, dismissedFor: b.change ?? PRE_CHANGE }))
  // The pane opens on the board again.
  await update($, readerAtom, () => null)
}

async function noteFigures($: Engine, contextPercent: number | undefined, costUsd: number | undefined): Promise<void> {
  await update($, figuresAtom, () => ({ contextPercent, costUsd }))
}

// From this width, a fullscreen terminal docks a pane beside the transcript.
const DOCK_COLUMNS = 110
// The terminal width of the last re-seat, so a pane the engine keeps inline at a width is not
// closed and opened again at every draw.
let reseatedAt = 0

/**
 * The engine seats a pane when it opens it: inline above the prompt in a narrow terminal,
 * docked beside the transcript in a fullscreen one from 110 columns. A pane seated inline stays
 * inline when the terminal widens. A width change draws the pane again, so the board seats it
 * again then: it closes and opens its pane, which docks. Only the person opens a pane in a
 * narrow terminal, so the engine places the reopened pane from 110 columns.
 */
function reseat($: Engine, e: RenderInput<'Pane'>): void {
  const columns = e.viewport?.columns ?? 0
  if (e.props.placement !== 'inline' || e.viewport?.isFullscreen !== true || columns < DOCK_COLUMNS) {
    reseatedAt = 0

    return
  }
  if (columns === reseatedAt) {
    return
  }
  reseatedAt = columns
  $.clock.after(50, async () => {
    await $.ui.close({ id: PANE })
    await $.ui.open({ id: PANE, title: TITLE })
  })
}

async function drawPane($: Engine, e: RenderInput<'Pane'>) {
  reseat($, e)
  const doc = await read($, readerAtom)
  if (doc !== null) {
    return drawReader($, e, doc)
  }
  const [binding, snap, live, agents, main, reports, others, figures, folded, expanded, hints] = await Promise.all([
    read($, bindingAtom),
    read($, snapshotAtom),
    read($, liveAtom),
    read($, agentsAtom),
    read($, mainAtom),
    read($, reportsAtom),
    read($, othersAtom),
    read($, figuresAtom),
    read($, foldedAtom),
    read($, expandedAtom),
    read($, hintsAtom),
  ])
  const now = await $.clock.now()

  return renderPane(
    $,
    e,
    { binding, snap, live, agents, main, reports, others, figures, folded, expanded, hints, now },
    {
      setFolded: async (key, isFolded) => {
        await update($, foldedAtom, map => ({ ...map, [key]: isFolded }))
      },
      setExpanded: async (num, isExpanded) => {
        await update($, expandedAtom, map => ({ ...map, [num]: isExpanded }))
      },
      pick: async change => {
        await bind($, change, 'pick')
        $.clock.after(20, () => void refresh($, { isForced: true, isGit: true }))
      },
      search: async query => {
        await update($, bindingAtom, b => ({ ...b, query }))
      },
      read: doc => showDoc($, doc),
      readPlanning: item => showPlanning($, item),
      openExternal: (target, what) => openOutside($, target, what),
    },
  )
}

/**
 * Shows a document in the reader view of the board pane, from its top. The reader is no
 * second pane. The engine shows a newly opened pane only while no pane holds the keys, and it
 * grants `focus` only to an empty prompt, so a reader tab behind the board could not be raised.
 * A pane opened after a press handler returned also counts as unasked, and it waits undrawn
 * below 144 columns.
 */
async function showDoc($: Engine, doc: ReaderDoc): Promise<void> {
  await update($, readerAtom, () => doc)
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
}

const ROW_TRIES = 4
const ROW_RETRY_MS = 100

/**
 * Scrolls the board to a row. A scroll to a key that the redraw has not drawn yet is refused,
 * so it tries again a few times, then gives up and leaves the board at its top.
 */
function scrollToRow($: Engine, key: string, tries: number): void {
  void $.ui.scroll({ in: PANE, to: { key }, block: 'center' }).then(
    moved => {
      if (moved.deny !== undefined && tries > 1) {
        $.clock.after(ROW_RETRY_MS, () => scrollToRow($, key, tries - 1))
      }
    },
    () => undefined,
  )
}

/** Back from the reader to the board, at the row that opened the document. */
async function showBoard($: Engine, from: string | undefined): Promise<void> {
  await update($, readerAtom, () => null)
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
  if (from !== undefined) {
    scrollToRow($, from, ROW_TRIES)
  }
}

/**
 * The branch, the commits, and the pull request of a snapshot whose files did not change, and
 * the work items of the providers that read git: the branch and the pull request may name
 * others. A provider keeps its own cache, so a GitHub issue asks `gh` again only when stale.
 */
async function refreshGit(
  $: Engine,
  dir: string,
  previous: Snapshot,
  hints: BoardHints,
  isGitDue: boolean,
  isPrDue: boolean,
  now: number,
): Promise<Snapshot> {
  const git = await collectGit($, dir, previous.change, previous, { isGitDue, isPrDue, hints, archivedAs: previous.archivedAs, now })
  const plan = await refreshPlan($, previous, hints.plan, { cwd: dir, branch: git.branch, pr: git.pr, now })

  return { ...previous, ...git, ...plan, refreshedAt: now }
}

/** A work item as its provider shows it: a text in the reader, or its page in the browser. */
async function showPlanning($: Engine, item: PlanningItem): Promise<void> {
  const snap = await read($, snapshotAtom)
  // The files of the folder that holds the change.
  const dir = snap?.root || (await sessionCwd($))
  const hints = await currentHints($)
  const opened = await openItem($, item, hints.plan, { cwd: dir, branch: snap?.branch, pr: snap?.pr, now: await $.clock.now() })
  if ('url' in opened) {
    await openOutside($, opened.url, opened.what)
    return
  }
  await showDoc($, { ...opened.doc, from: `plan:${item.id}` })
}

async function openOutside($: Engine, target: string, what: string): Promise<void> {
  const isOpened = await openExternal($, target)
  $.ui.toast(isOpened ? `Opened ${what}` : `Could not open ${what}: ${target}`)
}

/** The reader view reads its file at each draw, and redraws on each board refresh, so it stays current. */
async function drawReader($: Engine, e: RenderInput<'Pane'>, doc: ReaderDoc) {
  await read($, snapshotAtom)
  const text = doc.path === undefined ? doc.text : await readFile($, doc.path)

  return renderReader($, e, doc, text, {
    back: () => showBoard($, doc.from),
    openExternal: (target, what) => openOutside($, target, what),
  })
}

/** The note for a subagent: only during an apply run (see `isApplyRun`) of a change with open tasks. */
async function reportNoteFor($: Engine, subagentType: string, isPlain: boolean): Promise<string | undefined> {
  if (!isReportTool || !isPlain) {
    return undefined
  }
  const hints = await currentHints($)
  const skipped = [...NO_REPORT, ...hints.skipReportAgents, hints.reviewAgent, hints.plan?.agent]
  if (skipped.includes(subagentType)) {
    return undefined
  }
  const [binding, live, snap] = await Promise.all([read($, bindingAtom), read($, liveAtom), read($, snapshotAtom)])
  const change = binding.change
  if (change === undefined || snap === null || snap.change !== change || !isApplyRun(live, snap)) {
    return undefined
  }
  const isApplyDone = snap.groups.length > 0 && snap.groups.every(group => countDone(group) === group.tasks.length)

  return isApplyDone ? undefined : subagentNote(change)
}

async function applyNoteFor($: Engine): Promise<string | undefined> {
  const binding = await read($, bindingAtom)

  return isReportTool && binding.change !== undefined ? applyNote(binding.change) : undefined
}

export const register: Register = (on, options) => {
  isReportTool = options['reportTool'] !== false

  on('session.start', async ($, e, next) => {
    await startSession($, e.cwd)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flushLedger($, true).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await runBoardCommand($, e.args.trim()) }))

  // The progress note for the main agent rides on `/opsx:apply` as hidden context, typed or
  // run through the Skill tool. A managed plugin can skip `skill.prompt` hooks, so none is used.
  on('command.run', async ($, e, next) => {
    await noteCommand($, e.command, e.args)
    const ran = await next(e)
    const note = e.command === 'opsx:apply' ? await applyNoteFor($) : undefined

    return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined) {
      await noteCommand($, e.command.name, e.command.args)
    }

    return next(e)
  })

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const input = e as unknown as { skill?: string; args?: string }
    if (typeof input.skill === 'string') {
      await noteCommand($, input.skill, input.args ?? '')
    }
    const ran = await next(e)
    const note = input.skill === 'opsx:apply' && ran.deny === undefined ? await applyNoteFor($) : undefined

    return note === undefined || ran.deny !== undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  })

  on('agent.spawn', async ($, e, next) => {
    const phase = await currentPhase($)
    const isPlain = e.resume === undefined && e.workflow === undefined && !e.fork
    const note = await reportNoteFor($, e.subagentType, isPlain)
    const started = await next(note === undefined ? e : { ...e, prompt: e.prompt + note })
    if (started.agentId !== undefined) {
      await noteSpawn($, started.agentId, e, phase)
    }

    return started
  })

  // Each model request, the main loop's or a subagent's: its tokens count when it ends.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage !== null) {
      await noteStep($, e.turnId, e.agentId, fromModelUsage(result.usage))
    }

    return result
  })

  // A main turn runs until it completes: during an apply run, Next waits for it. A main turn
  // after an interrupt goes on with the apply run: the person's next prompt, or a background
  // agent's notification, resumes it.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, liveAtom, live => ({ ...live, stoppedAt: undefined, turnAt: now }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await noteMainTurn($, e)
    } else {
      await noteAgentEnd($, e.agentId, e)
    }

    return next(e)
  })

  // Its own registration: a hook that waits on an Agent call may not hear that agent's tools.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    await noteAgentResult($, (ran.result ?? {}) as AgentResult, ran.isError === true)

    return ran
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    await noteToolUse($, e as unknown as { tool: string; command?: string; file_path?: string; notebook_path?: string }, ran.isError === true)

    return ran
  })

  on('tool.call', { tool: TOOL_NAME }, async ($, e) => {
    await noteProgress($, e as unknown as ProgressInput)

    return { result: 'ok' }
  })

  on('session.measure', async ($, e, next) => {
    await noteFigures($, e.context.percent, e.cost?.usd)

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await noteClose($)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))
}
