import { describe, expect, test } from 'claude-code/testing'

import {
  changeFromArgs,
  changeFromBranch,
  changeOfPath,
  classifyCommits,
  countFindings,
  createdChanges,
  designFromArgs,
  hostKind,
  inferGroup,
  isChangeName,
  matchChanges,
  parseCreated,
  parseDecisions,
  parseTasks,
  parseVerifyVerdict,
  parseVisualDesign,
  phaseOfCommand,
  readVerdict,
  reflowTables,
  remoteHost,
  tableCells,
} from '../hooks/parse'
import { planItems } from '../hooks/providers'
import { findMarker, itemBlock } from '../hooks/providers/file'
import { readHints } from '../hooks/schema'
import { wrapWords } from '../hooks/ui'
import {
  ARCH_REVIEW_MD,
  DECISIONS_MD,
  GIT_LOG,
  OPENSPEC_YAML,
  PROPOSAL_MD,
  DEMO_BOARD_YAML,
  REVIEW_REPORT,
  BACKLOG_MD,
  TABLE_PROPOSAL_MD,
  TASKS_MD,
  WIDE_TABLES_MD,
} from './fixtures'

const HINTS = readHints('gated-spec-driven', DEMO_BOARD_YAML, '/repo/openspec/schemas/gated-spec-driven/board.yaml')
const PLAN = HINTS.plan ?? { label: 'Plan', section: 'Planning Items', isBeforeExplore: true, refs: [] }
const DESIGN = HINTS.design ?? { label: 'Design', section: 'Visual Design', skipArgs: [], path: 'x', dir: 'x' }
const VERDICT = HINTS.verdicts['arch-review'] ?? { values: [], block: [], warn: [], notes: [] }

describe('parse', () => {
  test('tasks.md groups and checkbox marks follow the CLI', async () => {
    const groups = parseTasks(TASKS_MD)
    expect(groups.map(group => group.num)).toEqual(['0', '1', '2', '11'])
    expect(groups[0]?.tasks).toHaveLength(3)
    expect(groups[1]?.tasks.map(task => task.mark)).toEqual(['x', '~'])
    expect(groups[2]?.title).toBe('The CSV writer in `export-service`')
    expect(groups[3]?.tasks[0]?.id).toBe('11.11')
    // The table row of group 0 is not a task.
    expect(groups.flatMap(group => group.tasks)).toHaveLength(9)
  })

  test('a review verdict, its level, and its note, with the hints of the schema', async () => {
    expect(readVerdict(ARCH_REVIEW_MD, 'arch-review', VERDICT)).toEqual({
      artifact: 'arch-review',
      value: 'REQUIRES-ADR',
      level: 'warn',
      note: 'ADR not created yet',
      next: undefined,
    })
    expect(readVerdict('## Verdict\n\n<!-- PASS | BLOCK -->\n**PASS-WITH-NOTES**\n', 'arch-review', VERDICT)?.value).toBe('PASS-WITH-NOTES')
    expect(readVerdict('## Verdict\n\n**REQUIRES-ADR**\n\nADR created: docs/adr/0027-csv-format.md\n', 'arch-review', VERDICT)?.note).toBe('ADR-0027')
    // The fallback form, and a blocking verdict with the command that revises the change.
    expect(readVerdict('Summary. VERDICT: block, see below.\n', 'arch-review', VERDICT)).toMatchObject({
      value: 'BLOCK',
      level: 'block',
      next: '/opsx:update {change}',
    })
    // A note shows only for a verdict that warns.
    expect(readVerdict('## Verdict\n\n**PASS**\n\nADR created: none\n', 'arch-review', VERDICT)?.note).toBeUndefined()
    expect(readVerdict('## Verdict\n\n**MAYBE**\n', 'arch-review', VERDICT)).toBeUndefined()
  })

  test('planning items and their live markers', async () => {
    const { items, none } = planItems(PROPOSAL_MD, PLAN)
    expect(none).toBeUndefined()
    expect(items).toEqual([
      {
        id: 'WI-12',
        title: 'CSV export of the library',
        provider: 'file',
        via: 'proposal',
        file: 'docs/backlog.md',
        mark: '~',
      },
    ])
    expect(findMarker(BACKLOG_MD, 'WI-12')).toBe('~')
    expect(findMarker(BACKLOG_MD, 'WI-13')).toBeUndefined()
    expect(planItems('## Planning Items\n\nNone — Tech Debt (P2)\n', PLAN).none).toBe('Tech Debt (P2)')
    // A BUG item belongs to the bugs file; an item outside the section does not count.
    const debt = planItems('## Backlog Items\n\n- [ ] **BUG-68 · Spec drift**\n\n## Impact\n\n- [ ] **WI-9 · Later**\n', PLAN)
    expect(debt.items).toEqual([{ id: 'BUG-68', title: 'Spec drift', provider: 'file', via: 'proposal', file: 'docs/bugs.md', mark: ' ' }])
    const nested = '- [~] **WI-1 · Parent** — x\n  - [ ] **WI-2 · Child** — y\n    - note\n\n- [ ] **WI-3 · Next** — z\n'
    expect(itemBlock(nested, 'WI-1')).toBe('- [~] **WI-1 · Parent** — x\n  - [ ] **WI-2 · Child** — y\n    - note')
    expect(itemBlock(nested, 'WI-2')).toBe('  - [ ] **WI-2 · Child** — y\n    - note')
    expect(itemBlock(nested, 'WI-9')).toBeUndefined()
  })

  test('visual design: a table, and a section written as prose', async () => {
    expect(parseVisualDesign(TABLE_PROPOSAL_MD, DESIGN)).toEqual([
      {
        label: 'Settings · Export dialog',
        view: 'export-dialog',
        statusText: 'approved (2026-10-11, revision 9 published)',
        isNeedsDesign: false,
      },
      { label: 'Gallery', view: undefined, statusText: 'needs-design', isNeedsDesign: true },
    ])
    expect(parseVisualDesign(PROPOSAL_MD, DESIGN)).toEqual([
      { label: 'export-dialog', view: 'export-dialog', statusText: 'named in the proposal', isNeedsDesign: true },
    ])
  })

  test('design decisions and the change date', async () => {
    expect(parseDecisions(DECISIONS_MD)).toEqual({ approvedAt: '2026-10-11', updatedAt: '2026-10-13', revisions: 7 })
    expect(parseDecisions('# x\n\nStatus: **Approved — revision 5** (2026-09-06)\n').approvedAt).toBe('2026-09-06')
    expect(parseCreated(OPENSPEC_YAML)).toBe('2026-10-22')
  })

  test('commits by kind', async () => {
    expect(classifyCommits(GIT_LOG, 'demo-change', HINTS.commits)).toEqual([
      { hash: 'a1b2c3d', subject: 'feat(demo-change): Task 1 Decisions and the ADR', kind: 'task', group: '1' },
      { hash: 'e4f5a6b', subject: 'docs(demo-change): add openspec change artifacts', kind: 'artifacts', group: undefined },
    ])
    // Without commit hints, the scope still finds the commits of the change, and none has a kind.
    expect(classifyCommits(GIT_LOG, 'demo-change').map(commit => commit.kind)).toEqual(['other', 'other'])
  })

  test('review findings and the verify verdict', async () => {
    expect(countFindings(REVIEW_REPORT, HINTS.findings)).toEqual({ MISSING: 1, DIVERGED: 1, PRACTICE: 1 })
    expect(countFindings(REVIEW_REPORT, undefined)).toEqual({})
    expect(parseVerifyVerdict('2 critical issue(s) found. Fix before archiving.')).toBe('2 critical')
    expect(parseVerifyVerdict('All checks passed. Ready for archive.')).toBe('all checks passed')
  })

  test('a table wider than the pane becomes a list; one that fits stays', async () => {
    const { text, reflowed } = reflowTables(WIDE_TABLES_MD, 80)
    expect(reflowed).toBe(2)
    expect(text).toContain(
      '- **1 · Stateless services** — Status: ✅\n\n  No new volume and no new file. `start.sh` keeps the resolved address',
    )
    // A row whose notes are short keeps them on its title line.
    expect(text).toContain('- **4 · Small modules** — Status: ✅ · Notes: No new module.')
    expect(text).toContain('- **0020 §1c · Transport constraints** — Compliant: Yes, with a note\n\n  The change builds')
    expect(text).not.toContain('|---')
    expect(text).toContain('## ADR Compliance')

    const narrow = '| a | b |\n|---|---|\n| 1 | 2 |\n'
    expect(reflowTables(narrow, 80)).toEqual({ text: narrow, reflowed: 0 })
    const fenced = '```\n| a | b |\n|---|---|\n```\n'
    expect(reflowTables(fenced, 3).reflowed).toBe(0)
    expect(tableCells('| `a\\|b` | c |')).toEqual(['`a|b`', 'c'])
  })

  test('word wrap for task text', async () => {
    expect(wrapWords('Add the streaming writer of 10 characters', 20)).toEqual(['Add the streaming', 'writer of 10', 'characters'])
    expect(wrapWords('a verylongwordthatbreaks b', 8)).toEqual(['a', 'verylong', 'wordthat', 'breaks b'])
    expect(wrapWords('', 10)).toEqual([])
  })

  test('the group an agent works on', async () => {
    const groups = parseTasks(TASKS_MD)
    expect(inferGroup('Implement task group 2', groups)).toBe('2')
    expect(inferGroup('Implement the CSV writer in `export-service`', groups)).toBe('2')
    expect(inferGroup('Do tasks 2.1 to 2.3 of the change', groups)).toBe('2')
    expect(inferGroup('Bump openspec to 1.14.1', groups)).toBeUndefined()
    expect(inferGroup('Group 7 work', groups)).toBeUndefined()
  })

  test('command arguments and branches', async () => {
    expect(phaseOfCommand('opsx:explore')).toBe('explore')
    expect(phaseOfCommand('opsx:propose')).toBe('propose')
    // The design command is a workflow command only where the hints name it.
    expect(phaseOfCommand('designer', HINTS)).toBe('design')
    expect(phaseOfCommand('designer')).toBeUndefined()
    expect(changeFromArgs(' demo-change ')).toBe('demo-change')
    expect(changeFromArgs('')).toBeUndefined()
    expect(changeFromArgs('make the gallery faster')).toBeUndefined()
    expect(isChangeName('csv-import')).toBe(true)
    expect(isChangeName('x&calc')).toBe(false)
    expect(isChangeName('../..')).toBe(false)
    expect(designFromArgs('component status-chip', DESIGN.skipArgs)).toBeUndefined()
    expect(designFromArgs('component status-chip')).toEqual({ view: 'component', mode: 'new' })
    expect(parseVisualDesign('## Visual Design\n\nSee `designs/../../secret/` first.\n', DESIGN)).toEqual([])
    expect(designFromArgs('update export-dialog')).toEqual({ view: 'export-dialog', mode: 'update' })
    expect(designFromArgs('app-shell')).toEqual({ view: 'app-shell', mode: 'new' })
    expect(changeFromBranch('worktree-demo-change', ['demo-change', 'other'])).toBe('demo-change')
    expect(changeFromBranch('feat/other', ['demo-change', 'other'])).toBe('other')
    expect(changeFromBranch('worktree-r2-wi-12-P2', ['demo-change'])).toBeUndefined()
  })

  test('the change a shell command creates or a file path lies in, and the picker search', async () => {
    expect(createdChanges('openspec new change "csv-export" 2>&1; openspec status --change "csv-export" --json')).toEqual(['csv-export'])
    expect(createdChanges("cd app && openspec new change 'csv-import' --schema spec-driven")).toEqual(['csv-import'])
    expect(createdChanges('openspec new change ../outside')).toEqual([])
    expect(createdChanges('openspec status --change csv-export --json')).toEqual([])
    expect(changeOfPath('C:\\repo\\openspec\\changes\\csv-export\\proposal.md')).toBe('csv-export')
    expect(changeOfPath('/repo/openspec/changes/csv-export/specs/csv/spec.md')).toBe('csv-export')
    expect(changeOfPath('/repo/openspec/changes/archive/2026-10-01-csv-export/tasks.md')).toBeUndefined()
    expect(changeOfPath('/repo/openspec/specs/csv/spec.md')).toBeUndefined()
    expect(matchChanges(['csv-export', 'csv-import-86abc', 'gallery'], ' CSV 86abc ')).toEqual(['csv-import-86abc'])
    expect(matchChanges(['csv-export', 'gallery'], '')).toEqual(['csv-export', 'gallery'])
    expect(matchChanges(['csv-export', 'gallery'], 'pdf')).toEqual([])
  })

  test('the host of a remote URL, and the kind its name tells', async () => {
    const hosts = [
      'https://github.com/o/r.git',
      'https://oauth2@GitLab.example.com/group/sub/r.git',
      'ssh://git@git.corp.example:2222/o/r.git',
      'git@github-work:o/r.git',
      'gitlab.com:o/r',
      'https://acme.ghe.com/o/r',
    ].map(remoteHost)
    expect(hosts).toEqual(['github.com', 'gitlab.example.com', 'git.corp.example', 'github-work', 'gitlab.com', 'acme.ghe.com'])
    expect(hosts.map(host => hostKind(host ?? ''))).toEqual(['github', 'gitlab', undefined, 'github', 'gitlab', 'github'])
    // A local path, a Windows drive, a file URL, and an odd name have no host.
    for (const url of ['/srv/git/r.git', '../r', 'C:/repos/r', 'C:\\repos\\r', 'file:///srv/git/r.git', 'https://ho$t/o/r', '']) {
      expect(remoteHost(url)).toBeUndefined()
    }
  })
})
