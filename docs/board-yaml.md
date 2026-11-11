# board.yaml

[← README](../README.md) · [The board in detail](board.md)

- [The stages that OpenSpec gives](#the-stages-that-openspec-gives)
- [Add stages with board.yaml](#add-stages-with-boardyaml)
- [Shape the flow](#shape-the-flow)
- [GitHub issues](#github-issues)
- [The check](#the-check)

## The stages that OpenSpec gives

The stages come from OpenSpec:

- **Propose** lists the artifacts of the change's schema, each after the artifacts it
  `requires`. Artifacts of one level can be written side by side. An active change gets them
  from `openspec status --json`. An archived change gets them from the `schema.yaml` that its
  `.openspec.yaml` names, which `openspec schema which <name>` finds.
- **Explore**, **Apply**, **Verify**, and **Archive** follow the `/opsx:*` commands, the task
  checks, and the archive folder. The tasks come from the files that `apply.tracks` of the
  schema names, a path or a glob in the change folder. A schema without `apply.tracks` tracks no
  tasks, as the CLI does.
- **PR** comes from the host of the repository's `origin` remote: from `gh` on GitHub, and from
  `glab` on GitLab, where the stage is **MR** and a merge request shows as `!N`. A host whose
  name holds `github` or `gitlab` is that host. Another host is the one whose CLI is logged in to
  it, `gh` first, such as a GitHub Enterprise or GitLab server. Without that CLI, or on another
  host, the board shows no PR stage. An archived change finds the pull request that its squash
  commit names. In a checkout of the change's own branch, it finds the pull request of the
  branch whose commits hold the archive commit. On GitLab, it finds the merge request that
  GitLab relates to the archive commit. A change archived on the main branch after its merge,
  such as by a CI job, finds the merge request of the last commit that changed its active
  folder. While that pull request is open, the board reads it again once a minute, until it is
  merged or closed.

## Add stages with board.yaml

A `board.yaml` adds what OpenSpec does not know. The board reads the first one it finds:

1. `~/.claude/opsx-board/schemas/<schema>/board.yaml`, the person's own copy.
2. `board.yaml` in the folder of the schema, for example
   `openspec/schemas/<schema>/board.yaml`. It passes `openspec schema validate`.

Without one, the board shows the OpenSpec stages only. A problem in the file shows as a warning
line in the pane. An example for a schema with an `arch-review` artifact:

```yaml
version: 1

stages:
  - { id: plan, label: Plan, collects: work-item, before: explore, section: Planning Items, agent: planner }
  - id: design
    label: Design
    collects: design
    section: Visual Design
    command: designer
    next: { new: '/designer {id}', update: '/designer update {id}' }

refs:
  - { kind: work-item, provider: file, pattern: 'WI-\d+', file: docs/backlog.md }
  - { kind: work-item, provider: file, pattern: 'BUG-\d+', file: docs/bugs.md, history: docs/bugs-closed.md }
  - kind: design
    provider: file
    pattern: 'designs/([A-Za-z0-9][\w-]*)/'
    dir: designs/{id}
    open: artifact.html
    screenshots: screenshots
    decisions: decisions.md
    needs: 'needs-design|needs an update'

artifacts:
  arch-review:
    verdict:
      values: [PASS-WITH-NOTES, PASS, REQUIRES-ADR, BLOCK]
      block: [BLOCK]
      warn: [REQUIRES-ADR]
      next: /opsx:update {change}
      notes:
        - { pattern: 'ADR created.*?docs/adr/(\d{4})-', text: 'ADR-{1}' }

commits:
  artifacts: 'add openspec change artifacts'
  task: '^\w+\({change}\): Task (\d+)'

verify:
  label: Review
  agent: spec-reviewer
  findings: '^\s*- \[[ xX]\]\s+(MISSING|DIVERGED|EXTRA)\b'

apply:
  skipReportAgents: [architect]
```

Its parts:

| Key | What it adds |
|-----|--------------|
| `stages` | A stage that `collects: work-item` (Plan) and a stage that `collects: design` (Design). Each reads one `section` of the proposal. A design stage names its `command` and the commands that Next offers. An entry without `collects` sets a stage of the board, see [Shape the flow](#shape-the-flow). |
| `refs` | How a reference resolves. A `work-item` ref maps an ID `pattern` to the `file` that holds the items, and their `history`. A `design` ref maps a path `pattern` to a design folder (`dir` with `{id}`), the file a click opens, its screenshots, and its decision log. |
| `artifacts.<id>.verdict` | The verdict values of a review artifact, which values `block` or `warn`, the command that revises a blocked change, and notes. |
| `commits` | Commit subject patterns of the apply run: `artifacts`, `task` (group number in its first group), `reviewFix`, and `archive`. `{change}` stands for the change name. |
| `verify` | The label of the Verify stage, the review agent, and the pattern of its finding lines. |
| `apply.skipReportAgents` | More agents that never get the progress request. |

## Shape the flow

The flow of a change runs Explore › Plan › Design › Propose › Apply › Verify › PR › Archive, and
a team may work another way. An entry of `stages` without `collects` names a stage by its `id`
and sets it:

```yaml
stages:
  - { id: verify, label: Review, optional: true }
  - { id: pr, hidden: true }
  - { id: explore, after: propose }
```

| Key | What it does |
|-----|--------------|
| `label` | The name of the stage in the rail and its section. |
| `hidden` | `true` leaves the stage out of the rail, the pane, and Next. The header still shows `archived` for an archived change when Archive is hidden. |
| `optional` | `true`: Next skips the stage, and it shows as not applicable (`–`) until it starts. |
| `before`, `after` | Moves the stage before or after another one. A stage that `collects` takes them too, such as `before: explore` for Plan. |

The ids are `explore`, `plan`, `design`, `propose`, `apply`, `verify`, `pr`, and `archive`. A new
kind of stage needs code in the board, as a `board.yaml` names no behaviour.

## GitHub issues

A `work-item` ref with `provider: github` takes the work items of a change from GitHub issues.
This `board.yaml` works for any schema:

```yaml
version: 1

stages:
  - { id: plan, label: Issues, collects: work-item, section: Issues }

refs:
  - { kind: work-item, provider: github, branch: '^(\d+)-' }
```

The board finds the issues of a change in three places, and shows each issue once:

1. The proposal section of the stage: each `#12`, `owner/name#12`, and issue URL on a list
   line of it. A prose line names no issue, and a number after "PR" or "pull request" names a
   pull request.
2. The branch name: the first group of the `branch` pattern, such as `12` in `12-csv-export`.
3. The pull request of the branch: the issues it closes. Set `pr: false` to leave them out.

`gh issue view` gives the title and the state of each issue: `[ ]` open, `[x]` closed as done,
`[-]` closed as not planned. The board reads an issue again after two minutes, and it shows the
first 12 issues of a change. A click on an issue shows its body in the reader, with a button
that opens its page.

A bare `#12` names an issue of the home repository: `repo` of the ref (`owner/name`), else the
repository of the pull request, else the one `gh` finds from the working directory. Without
`gh`, the issues show `[?]` and a warning.

## The check

A `board.yaml` comes with any repository, so the board checks it strictly:

- It names built-in providers only. Version 1 has the `file` and `github` providers. The
  `github` provider runs `gh issue view` and reads the pull request that the PR stage reads.
  The file chooses which issues count, never a command. A provider that calls a tool or a
  command of the file's choice is not built in, and the board ignores a ref that names one.
- A `repo` must be `owner/name`.
- Every path stays inside the repository: no absolute path, no drive, and no `..`.
- A design opens a document file only.
- Next fills the prompt with one slash command and a short argument. It never runs it.
- Each pattern must compile and have 300 characters or fewer. A pattern runs on the files of
  the same repository, and a slow pattern can slow the board.
