# Security

## Report a vulnerability

Report it privately through
[private vulnerability reporting](https://github.com/uzi0espil/opsx-board/security/advisories/new).
Do not open a public issue for it.

Fixes go into the next release. Only the latest release gets fixes.

## What the plugin does in a session

The plugin runs inside the Claude Code session of the person who installs it. In that session it:

- reads the files of the repository the session works in: the OpenSpec changes, the schema, a
  `board.yaml`, and the files the `board.yaml` names;
- reads `~/.claude/opsx-board/schemas/<schema>/board.yaml`, the person's own copy;
- writes token ledgers to `~/.claude/opsx-board/ledgers/`, and reads the ledgers of the
  person's other sessions;
- runs `openspec`, `git`, and `gh` in the session's working directory. On Windows, `openspec`
  runs through `cmd /c`;
- opens a URL, or a file of a listed type (HTML, PDF, image, Markdown, text, YAML, JSON), with
  the operating system's opener, when the person clicks it in the pane;
- registers a tool that agents call to report their task. The tool only updates the pane;
- fills the prompt with a slash command. It never runs the command.

Every change name passes a kebab-case check before it reaches a command line or a ledger path.
The patterns of a `board.yaml` must compile and have 300 characters or fewer.

## In scope

A repository, a change, or a `board.yaml` that makes the plugin:

- run a command, or a command with arguments, other than those above;
- read or write a file outside the folders above;
- open a file of another type;
- hang or crash the session.

## Out of scope

A vulnerability of Claude Code, OpenSpec, `gh`, or `git` itself. Report it to that project.
