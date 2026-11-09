# The board in detail

[← README](../README.md) · [board.yaml](board-yaml.md)

The examples on this page use the example of [board.yaml](board-yaml.md#add-stages-with-boardyaml): a
Plan stage of backlog items (`WI-12`), a Design stage of a `/designer` command, and a review
agent, labeled Review.

- [Where the pane sits](#where-the-pane-sits)
- [Which change the pane shows](#which-change-the-pane-shows)
- [Stages](#stages)
- [Clicks](#clicks)
- [The reader](#the-reader)
- [Apply run](#apply-run)
- [Next](#next)
- [Progress report tool](#progress-report-tool)
- [Tokens](#tokens)
- [What the board reads](#what-the-board-reads)

## Where the pane sits

Claude Code places the pane:

- docked beside the transcript, in the fullscreen layout from 110 columns;
- inline above the prompt, in a narrower terminal or on the main screen (`CLAUDE_CODE_NO_FLICKER=0`,
  tmux by default).

A workflow command opens the pane by itself from 144 columns, or from 110 once you have opened it
with `/opsx-board`. In a narrower terminal, `/opsx-board` opens it.

Claude Code seats a pane when it opens it. When a terminal that was too narrow widens to 110
columns in the fullscreen layout, the board closes its pane and opens it again, so that it docks
beside the transcript.

## Which change the pane shows

Each session follows its own change: the argument of its last `/opsx:*` command, else the only
active change in its folder, else the change its branch names, else the one picked in the pane.

The board reads the folder that the session works in, and it follows the session into a worktree
and out of it. A session can leave a worktree that still holds the bound change, for a folder
without that change. Then the board keeps reading the change in the worktree. When the session
leaves a worktree that it removed, the board reads the change in the new folder, also from the
archive there.

## Stages

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

## Clicks

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
| `← Main session` | Shows the main session again. It appears under the stage chip, and in the reader, only while an agent's session is in view. The hotkey `m` presses it while the pane holds the keyboard |
| Review (Verify), verify | Shows the last report of the review agent, else of `/opsx:verify`, in the reader |
| PR, or MR on GitLab | Opens the pull request, or the merge request, in the browser (an archived change finds the one that merged it) |
| Next | Fills the prompt with the next command. It never runs the command. The pane hides it while a stage is in progress, see [Next](#next) |

## The reader

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

## Apply run

An apply run starts with `/opsx:apply` for the bound change. It lasts while that command is the
last workflow command of the session. It stops in two cases:

- The strict validation at the start of the run refuses the change. The run stays stopped.
- A main turn ends by an interrupt, an error, or a refusal. The next main turn resumes the run,
  such as the person's next prompt or the notification of a background agent.

During an apply run, the pane hides Next until no task is `[ ]` and the pull request (on GitLab,
the merge request) exists.
Then Next offers `/opsx:archive`. A task left `[~]` for the owner does not hold the archive back.
While an apply run is stopped and none of its agents runs, Next offers `/opsx:apply` again.

## Next

Next offers nothing while a stage is in progress. A stage is in progress while one of these
runs:

- The main turn of its command, such as `/opsx:propose`, `/opsx:verify`, or the design command.
- An apply run, for the Apply stage.
- An agent that the session started in that stage. An interrupt does not stop a background agent.
- The review agent of the hints, for Verify, or the agent of the Plan stage.

Explore, Design, and Propose `in review` are active, but no work runs in them after the turn of
their command. Then Next offers the step that ends them.

Without the CLI of the repository's host, `gh` for GitHub or `glab` for GitLab, or in a repository
on another host, the board cannot see a pull request. It shows no PR stage, and when no task is
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
change persist across sessions in
`~/.claude/opsx-board/projects/<project>/ledgers/<change>/<session>.json`, one file per session.

`<project>` is the name of the repository's folder and a hash of its path, such as
`opsx-demo-3f2a1c9e`. Every worktree of a repository shares it, so a change keeps its totals in
and out of a worktree. Outside a repository, the session's folder is the project. Two projects
never share totals, also for changes of the same name, and `also active` in the header lists only
the changes of the same project that other sessions worked on in the last 15 minutes.

Up to 0.2.0, the ledgers sat in `~/.claude/opsx-board/ledgers/<change>/`, shared by every
project. The first project that shows a change copies that change's old ledgers into its own
folder, and leaves a `MOVED.txt` in the old folder, so that no other project takes them too. The
old folder can be deleted by hand once no session of an older version runs.

## What the board reads

The plugin observes the workflow. It reads the `openspec` CLI JSON, the schema and its hints,
the change files, the files the hints name, git, `gh`, and `glab`, and the session's own agent
and token events. It changes no workflow file.
