# opsx-board

A Claude Code plugin that shows, in a pane beside the chat, where the OpenSpec change of the
session stands: Explore, Propose, Apply, Verify, PR, and Archive. The Propose section lists the
artifacts of the change's schema in their `requires` order. The Apply section lists each task
group with its progress, the agent that runs it, its tokens, and its commit.

The board reads the schema of each change from the `openspec` CLI, so it works with any schema.
A `board.yaml` beside the schema adds what OpenSpec does not know, such as a Plan stage of work
items and a Design stage. See [Schemas and board.yaml](#schemas-and-boardyaml).

> **Work in progress.** The plugin is not in a marketplace yet. Work items come from files of the
> repository or from GitHub issues. A Jira provider comes next. The plugin is not affiliated with
> the OpenSpec project.

## The board

The examples in the rest of this README use the `board.yaml` of
[Schemas and board.yaml](#schemas-and-boardyaml): a Plan stage of backlog items (`WI-12`), a
Design stage of a `/designer` command, and a review agent, labeled Review.

Explore and Design can run before a change exists. Then the pane shows the stage rail, the
explored topics with the tokens spent on them, and the design views. When `/opsx:propose <name>`
runs later in the same session, the pane binds the change and moves the explored topics and the
tokens into it. The session explores while `/opsx:explore` is its last workflow command. An
explore argument binds the pane only when it names an active change. An archived change binds
only through `/opsx-board <change>`.

A session explores in the context of the change that it is bound to. In a folder with exactly
one active change, the session binds that change by itself, so its explore tokens count for that
change.

Propose and Design stay active until the next step starts, because the person reviews their
output and asks for changes. When every artifact exists, Propose shows `in review` until one of
these signals shows that Apply started:

- `/opsx:apply`, `/opsx:verify`, `/opsx:sync`, or `/opsx:archive` runs for the change.
- A task gets its check.
- A commit of the apply run lands, such as the artifacts commit or a `Task N` commit.
- The change moves to the archive.

When the strict validation at the start of `/opsx:apply` refuses the change, the review goes on.
A pull request of the branch is not a signal. A design view shows `in review` while the design
command (`/designer`) is the last workflow command of the session, also after its
approval. The tokens of the review count for the stage in review.

Every row acts on a click:

| Row | Click |
|-----|-------|
| Section header | Folds or unfolds the section |
| Planning item (`WI-12`) | Shows its block of the file that holds it in the reader |
| Design view | Opens its file (`artifact.html`) in the browser; `decisions` opens its decision log in the reader |
| Artifact (proposal, arch-review, design, tasks) | Opens the file in the reader |
| `specs` | Lists the spec files; each opens in the reader |
| Task group | Folds or unfolds its tasks |
| Agent cell of a task group (`general-purpose 44k 2m`) | Opens the session of its agent |
| Task (clipped) | Unfolds its whole text in place; a second click folds it. A hover shows it in a floating card |
| Agent | Opens its session |
| Review (Verify), verify | Shows the last report of the review agent, else of `/opsx:verify`, in the reader |
| PR | Opens the pull request in the browser (an archived change finds the PR that merged it) |
| Next | Fills the prompt with the next command. It never runs the command. The pane hides it during an apply run, see [Apply run](#apply-run) |

The reader is a view of the board pane. A document replaces the board in the same pane, and
`← Board` brings the board back, at the row that opened the document. The hotkey `b` presses
`← Board` while the pane holds the keyboard. Esc does not close the reader, because the engine
never passes Esc to a mod. Esc gives the keyboard back to the prompt. When the pane closes, or
when `/opsx-board` runs, the pane shows the board again.

The reader is not a second pane, for two reasons:

- The engine shows a new pane in front only while no pane holds the keyboard. A reader tab
  behind the board therefore stayed behind.
- The engine treats a pane that opens after a click as unrequested. An unrequested pane waits
  undrawn in a terminal narrower than 144 columns.

A table wider than the pane is shown as a list, one item per row. The reader says so, and the
app of the file shows the original. The reader reads its file at each refresh, so an open
`tasks.md` shows the checks as they land. `Open in its app` opens the file with the default app
of the system. The browser and the default app open through the system opener:
`rundll32 url.dll,FileProtocolHandler` on Windows, `open` on macOS, and `xdg-open` elsewhere.
The opener runs a program or a script as it opens it, so the board opens only URLs and
document files (`.html`, `.md`, `.pdf`, images, and a few more). The schema and its hints name
the files, and they come with the repository.

The plugin observes the workflow. It reads the `openspec` CLI JSON, the schema and its hints,
the change files, the files the hints name, git, and `gh`, and the session's own agent and token
events. It changes no workflow file.

## Use

- `/opsx-board`: open the pane.
- `/opsx-board <change>`: pin the pane to a change, also an archived one.
- `/opsx-board auto`: let the session choose the change again.
- `/opsx-board close`: close the pane.

The pane opens by itself on any `/opsx:*` command and on the design command of the hints, when
the terminal is wide enough. A status line under the prompt shows the stage when the pane is closed.

Each session follows its own change: the argument of its last `/opsx:*` command, else the only
active change in its folder, else the change its branch names, else the one picked in the pane.

## Apply run

An apply run starts with `/opsx:apply` for the bound change. It lasts while that command is the
last workflow command of the session. It ends early in two cases:

- The strict validation at the start of the run refuses the change.
- A main turn ends by an interrupt, an error, or a refusal.

During an apply run, the pane hides Next until no task is `[ ]` and the pull request exists.
Then Next offers `/opsx:archive`. A task left `[~]` for the owner does not hold the archive back.
After an apply run ends early, Next offers `/opsx:apply` again.

Without `gh`, the board cannot see a pull request. It shows no PR stage, and when no task is
`[ ]`, Next offers `/opsx:verify`, then `/opsx:archive`.

## Progress report tool

During an apply run of a change with open tasks, the board asks the main agent and each new
subagent to call `mcp__opsx-board__progress` before and after each task. The pane then marks
the exact task in progress. The agents `Explore`, `Plan`, `claude-code-guide`, and
`statusline-setup` do not get the request, and neither do the review agent, the plan agent, and
the agents in `apply.skipReportAgents` of the hints. The setting `reportTool` in `/config` stops these requests. The pane then
infers the group from the agent's prompt.

The request to the main agent rides on `/opsx:apply` as hidden context. A managed plugin can skip
the `skill.prompt` hooks of other plugins, so the plugin does not use that hook.

Every change name passes a kebab-case check before it reaches a command line or a ledger path.
On Windows the `openspec` CLI runs through `cmd /c`, which reads `&` and `|` as its own syntax.

## Tokens

Tokens count per model request, so a running agent's total grows while it works. Totals for a
change persist across sessions in `~/.claude/opsx-board/ledgers/<change>/<session>.json`, one
file per session.

## Schemas and board.yaml

The stages come from OpenSpec:

- **Propose** lists the artifacts of the change's schema, each after the artifacts it
  `requires`. Artifacts of one level can be written side by side. An active change gets them
  from `openspec status --json`. An archived change gets them from the `schema.yaml` that its
  `.openspec.yaml` names, which `openspec schema which <name>` finds.
- **Explore**, **Apply**, **Verify**, and **Archive** follow the `/opsx:*` commands, the task
  checks, and the archive folder. The tasks come from the files that `apply.tracks` of the
  schema names, a path or a glob in the change folder. A schema without `apply.tracks` tracks no
  tasks, as the CLI does.
- **PR** comes from `gh`. Without `gh`, the board shows no PR stage. An archived change finds
  the pull request that its squash commit names. In a checkout of the change's own branch, it
  finds the pull request of the branch whose commits hold the archive commit.

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
| `stages` | A stage that `collects: work-item` (Plan) and a stage that `collects: design` (Design). Each reads one `section` of the proposal. `before: explore` puts a stage before Explore. A design stage names its `command` and the commands that Next offers. |
| `refs` | How a reference resolves. A `work-item` ref maps an ID `pattern` to the `file` that holds the items, and their `history`. A `design` ref maps a path `pattern` to a design folder (`dir` with `{id}`), the file a click opens, its screenshots, and its decision log. |
| `artifacts.<id>.verdict` | The verdict values of a review artifact, which values `block` or `warn`, the command that revises a blocked change, and notes. |
| `commits` | Commit subject patterns of the apply run: `artifacts`, `task` (group number in its first group), `reviewFix`, and `archive`. `{change}` stands for the change name. |
| `verify` | The label of the Verify stage, the review agent, and the pattern of its finding lines. |
| `apply.skipReportAgents` | More agents that never get the progress request. |

### GitHub issues

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

### The check

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

## Develop

```
claude --plugin-dir <this folder>
claude plugin validate <this folder>
claude plugin test <this folder>
```

To load the board in every session, add this folder to
`CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. The variable takes a
list of folders, separated by `;` on Windows and `:` elsewhere. A change of the variable takes
effect in the next session.

The tests use the `board.yaml` of a demo project. Other tests cover a plain `spec-driven`
change, an archived change of a forked schema, GitHub issues with and without `gh`, tasks from
`apply.tracks`, and the `reportTool` setting.
