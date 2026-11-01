// The files and the CLI output of a demo change. The shapes are those that the openspec 1.14.1
// CLI and a change of a project with a review gate wrote; the names and the text are made up.

export const STATUS_JSON = {
  changeName: 'demo-change',
  schemaName: 'gated-spec-driven',
  artifactPaths: {
    proposal: { outputPath: 'proposal.md', existingOutputPaths: ['/repo/openspec/changes/demo-change/proposal.md'] },
    specs: {
      outputPath: 'specs/**/*.md',
      existingOutputPaths: [
        '/repo/openspec/changes/demo-change/specs/csv-export/spec.md',
        '/repo/openspec/changes/demo-change/specs/export-status/spec.md',
      ],
    },
  },
  isPlanningComplete: true,
  isComplete: true,
  applyRequires: ['tasks'],
  artifacts: [
    { id: 'proposal', outputPath: 'proposal.md', status: 'done', requires: [] },
    { id: 'arch-review', outputPath: 'arch-review.md', status: 'done', requires: ['proposal'] },
    { id: 'specs', outputPath: 'specs/**/*.md', status: 'done', requires: ['proposal', 'arch-review'] },
    { id: 'design', outputPath: 'design.md', status: 'done', requires: ['proposal', 'arch-review'] },
    { id: 'tasks', outputPath: 'tasks.md', status: 'done', requires: ['specs', 'design'] },
  ],
}

export const TASKS_MD = `# Tasks: demo-change

## 0. Backlog Update

- [x] 0.1 Read proposal.md § Planning Items and find each item in the file that holds it.
- [x] 0.2 Mark the found items \`[~]\` (in progress).
- [x] 0.3 Add a row to the **Active Changes** table in \`docs/backlog.md\`:

| demo-change | Release 2 | In Progress | \`openspec/changes/demo-change/\` |

## 1. Decisions and the ADR

> Task 1.1 blocks task groups 2 to 9.

- [x] 1.1 Record the decision on the file format in design D3 and the proposal.
- [~] 1.2 If the owner chose option A or B, run \`/opsx:update\` to revise the specs and the design.

## 2. The CSV writer in \`export-service\`

- [ ] 2.1 Allow a column name of letters, digits, and spaces only, and refuse every other name.
- [ ] 2.2 Add the streaming writer that sends each row as it is ready, independent of the page size of the client.
- [ ] 2.3 Write \`export-status.json\` in \`exports\` with the state, the warnings, and the time.

## 11. Verification

### Common

- [ ] 11.11 Run \`openspec validate demo-change --strict\`.
`

export const ARCH_REVIEW_MD = `# Architecture Review: demo-change

## Verdict

**REQUIRES-ADR**

## Notes for Design Phase

**ADR created**: Not created in this step: the file format is an open owner decision.
`

export const PROPOSAL_MD = `## Why

People want their library in a spreadsheet.

## Planning Items

### \`docs/backlog.md\`

- [~] **WI-12 · CSV export of the library** — a person can export the library as CSV.
  - _Added 2026-10-11: the export also feeds the backup check._

## Visual Design

The approved design \`designs/export-dialog/\` needs an update before the frontend tasks start. The owner runs \`/designer update export-dialog\`.

## Impact

Backend and frontend.
`

export const TABLE_PROPOSAL_MD = `## Visual Design

| View | Design | Status |
|------|--------|--------|
| Settings · Export dialog | \`designs/export-dialog/artifact.html\` with \`designs/export-dialog/decisions.md\` | approved (2026-10-11, revision 9 published) |
| Gallery | — | needs-design |
`

export const BACKLOG_MD = `# Backlog

- [~] **WI-12 · CSV export of the library** — a person can export the library as CSV.

## Active Changes

| Change | Release | Status | OpenSpec Path |
|--------|---------|--------|---------------|
| demo-change | Release 2 | In Progress | \`openspec/changes/demo-change/\` |

---
`

export const DECISIONS_MD = `# Settings · Export dialog — Design Decisions

Approved: **2026-10-11** (revision 7). The owner approved the design and answered Q1–Q3 on the same day.

## Updates

- 2026-10-12: Revision 8. The format picker moved.
- 2026-10-13: Revision 9. Copy fixes.
`

export const OPENSPEC_YAML = `schema: gated-spec-driven
created: 2026-10-22
`

export const GIT_LOG = [
  'a1b2c3d\tfeat(demo-change): Task 1 Decisions and the ADR',
  'e4f5a6b\tdocs(demo-change): add openspec change artifacts',
  '0c64bc4\tfix(ui): update a build dependency for an advisory (#225)',
].join('\n')

// Two wide tables of an arch-review, with long and short notes.
export const WIDE_TABLES_MD = `## Principles Check

| # | Principle | Status | Notes |
|---|-----------|--------|-------|
| 1 | Stateless services | ✅ | No new volume and no new file. \`start.sh\` keeps the resolved address in a shell variable. The root file system of \`proxy\` stays read-only. |
| 4 | Small modules | ✅ | No new module. |

## ADR Compliance

| ADR | Title | Compliant | Notes |
|-----|-------|-----------|-------|
| 0020 §1c | Transport constraints | Yes, with a note | The change builds the second form of the direct candidate (\`0020:167\`). The network gate (\`0020:169\`) needs one test, per N8. |
| 0014 | URL versioning | Yes | No API change. The status read of the admin API does not change. |
`

export const REVIEW_REPORT = `Mode: A — change-backed (demo-change)
## Spec Alignment
- [ ] MISSING: The writer refuses an empty column name (export/csv.py:40)
- [ ] DIVERGED: The status file omits the time (export/status.py:12)
## Published-Spec Drift
No published-spec drift detected.
## Best-Practice Violations
- [ ] PRACTICE: tests: The test mocks the repository (tests/unit/test_csv.py:8)
`

// A schema.yaml with a review gate between the proposal and the specs, in the forms the
// OpenSpec 1.14.1 schemas use: flow and block \`requires\`, folded and literal instructions with
// list lines and blank lines.
export const GATED_SCHEMA_YAML = `name: gated-spec-driven
version: 1
description: Spec-driven workflow with an architecture review gate
artifacts:
  - id: proposal
    generates: proposal.md
    description: Initial proposal document outlining the change
    template: proposal.md
    instruction: >
      Write the proposal in short sentences. Read
      \`docs/writing.md\` first.

      Sections:
      - **Why**: 1-2 sentences on the problem or opportunity. What problem does
      this solve? Why now?
    requires: []

  - id: arch-review
    generates: arch-review.md
    description: Architecture review against the design principles and ADRs
    requires: [ proposal ]
    template: arch-review.md
    instruction: |
      - VERDICT: pass | pass-with-notes | requires-adr | block

  - id: specs
    generates: specs/**/*.md
    instruction: |
      #### Scenario: Export
      - **WHEN** user clicks "Export" button
    requires: [proposal, arch-review]

  - id: design
    generates: design.md
    requires: [proposal, arch-review]
  - id: tasks
    generates: tasks.md
    instruction: >
      Task lines are procedural writing.
         - Has no basis in the proposal → flag as **SCOPE DRIFT**
    requires:
      - specs
      - design
apply:
  requires:
    - tasks
  tracks: tasks.md
  instruction: |
    ## 0. Update the backlog
`

// A fork of spec-driven with an extra artifact: research comes between the proposal and the
// specs. Block-form \`requires\` and a quoted \`generates\`, as the package schema writes them.
export const TEAM_SCHEMA_YAML = `name: team-flow
version: 1
artifacts:
  - id: proposal
    generates: proposal.md
    requires: []
  - id: research
    generates: research.md
    requires:
      - proposal
  - id: specs
    generates: "specs/**/*.md"
    requires:
      - research
  - id: design
    generates: design.md
    requires:
      - research
  - id: tasks
    generates: tasks.md
    requires:
      - specs
      - design
apply:
  requires: [tasks]
  tracks: tasks.md
`

// The status of a change of the plain spec-driven schema, as openspec 1.14.1 writes it.
export const SPEC_DRIVEN_STATUS_JSON = {
  changeName: 'plain-change',
  schemaName: 'spec-driven',
  isComplete: false,
  applyRequires: ['tasks'],
  artifacts: [
    { id: 'proposal', outputPath: 'proposal.md', status: 'done', requires: [] },
    { id: 'specs', outputPath: 'specs/**/*.md', status: 'ready', requires: ['proposal'] },
    { id: 'design', outputPath: 'design.md', status: 'ready', requires: ['proposal'] },
    { id: 'tasks', outputPath: 'tasks.md', status: 'blocked', requires: ['specs', 'design'], missingDeps: ['specs', 'design'] },
  ],
}

// The board.yaml of the demo project: every part the board reads.
export const DEMO_BOARD_YAML = String.raw`# openspec-board hints for the gated-spec-driven schema of a demo project.
version: 1

stages:
  - id: plan
    label: Plan
    collects: work-item
    before: explore
    section: Planning Items|Backlog Items
    agent: planner
  - id: design
    label: Design
    collects: design
    section: Visual Design
    command: designer
    skipArgs: [component]
    next:
      new: /designer {id}
      update: /designer update {id}

refs:
  - kind: work-item
    provider: file
    pattern: 'WI-\d+'
    file: docs/backlog.md
  - kind: work-item
    provider: file
    pattern: 'BUG-\d+'
    file: docs/bugs.md
    history: docs/bugs-closed.md
  - kind: design
    provider: file
    pattern: 'designs/([A-Za-z0-9][\w-]*)/'
    dir: designs/{id}
    open: artifact.html
    screenshots: screenshots
    decisions: decisions.md
    needs: 'needs-design|needs an update|designer update'

artifacts:
  arch-review:
    verdict:
      values: [PASS-WITH-NOTES, PASS, REQUIRES-ADR, BLOCK]
      block: [BLOCK]
      warn: [REQUIRES-ADR]
      next: /opsx:update {change}
      notes:
        - { pattern: 'ADR created.*?docs/adr/(\d{4})-', text: 'ADR-{1}' }
        - { pattern: 'ADR created', text: 'ADR not created yet' }

commits:
  artifacts: 'add openspec change artifacts'
  task: '^\w+\({change}\): Task (\d+)'
  reviewFix: 'address review findings'
  archive: 'archive change'

verify:
  label: Review
  agent: spec-reviewer
  findings: '^\s*- \[[ xX]\]\s+(MISSING|DIVERGED|EXTRA|PRACTICE)\b'

apply:
  skipReportAgents: [architect]
`

// ── GitHub issues ───────────────────────────────────────────────────────────

// A board.yaml that reads the work items of a change from GitHub: the proposal's Issues
// section, the issue number at the start of the branch name, and what the pull request closes.
export const GITHUB_BOARD_YAML = String.raw`version: 1
stages:
  - { id: plan, label: Issues, collects: work-item, section: Issues }
refs:
  - { kind: work-item, provider: github, branch: '^(\d+)-' }
`

export const GITHUB_PROPOSAL_MD = `## Why

People want their library in a spreadsheet.

## Issues

- #12 CSV export
- Needs the upstream fix https://github.com/other/lib/issues/7
- See #12 again, and the heading anchor [notes](#13-notes)

## Impact

Backend.
`

const closing = (number: number) => ({
  id: `I_${number}`,
  number,
  repository: { id: 'R_1', name: 'r', owner: { id: 'O_1', login: 'o' } },
  url: `https://github.com/o/r/issues/${number}`,
})

/** `gh pr list --json number,state,url,closingIssuesReferences`, as gh 2.101 writes it. */
export const GITHUB_PRS = JSON.stringify([
  { closingIssuesReferences: [closing(12), closing(40)], number: 51, state: 'OPEN', url: 'https://github.com/o/r/pull/51' },
])

const issue = (number: number, title: string, state: string, stateReason: string | null) => ({
  number,
  state,
  stateReason,
  title,
  url: `https://github.com/o/r/issues/${number}`,
})

/** `gh issue view N --json ...` by `<repo>#<N>`; a string is what gh writes to stderr as it fails. */
export const GITHUB_ISSUES: Record<string, object | string> = {
  'o/r#12': {
    ...issue(12, 'CSV export of the library', 'OPEN', null),
    body: '## Steps\n\nExport a CSV.',
    author: { login: 'sam' },
    createdAt: '2026-10-01T09:00:00Z',
    labels: [{ id: 'L_1', name: 'feature', description: '', color: 'aaaaaa' }],
    assignees: [{ id: 'U_1', login: 'dana', name: 'Dana' }],
  },
  'o/r#34': issue(34, 'Streaming writer', 'CLOSED', 'COMPLETED'),
  'o/r#40': issue(40, 'Excel export', 'CLOSED', 'NOT_PLANNED'),
  'other/lib#7': 'GraphQL: Could not resolve to an issue or pull request with the number of 7. (repository.issue)',
}
