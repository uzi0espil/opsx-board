# Contributing

Issues and pull requests are welcome.

## Before you start

- For a bug, open an issue with the bug form. It asks for the versions and the pane.
- For a feature, or a change of what the board shows, open an issue first, so we agree on the
  change before you write code.
- For a vulnerability, follow [SECURITY.md](SECURITY.md). Do not open an issue.

## Set up

You need Claude Code, git, and the `openspec` CLI. `gh` and `glab` are optional.

Load the plugin from your clone and run the checks:

```
claude --plugin-dir <your clone>
claude plugin validate <your clone>
claude plugin test <your clone>
```

To load the board from your clone in every session, add the clone to
`CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. The variable takes a
list of folders, separated by `;` on Windows and `:` elsewhere. A change of the variable takes
effect in the next session.

The tests need no login. They use the `board.yaml` of a demo project. Other tests cover a plain
`spec-driven` change, an archived change of a forked schema, GitHub issues with and without
`gh`, GitLab merge requests with and without `glab`, tasks from `apply.tracks`, a session that
leaves a worktree, and the `reportTool` setting.

CI runs both checks on Ubuntu and Windows for each pull request, and each week on the newest
Claude Code.

## Pull requests

- One change per pull request.
- A change of behaviour comes with a test in `tests/`.
- When the board shows or does something new, the README says so.
- The title is a [Conventional Commit](https://www.conventionalcommits.org/) header. Pull
  requests are squash-merged, so the title becomes the commit on `main`, and the release notes
  sort the commits by its type. A check rejects any other title.

### Titles

`<type>(<scope>): <what the change does>`, where the scope is optional:

- `feat: add a Jira provider for work items`
- `fix(apply): hide Next while the run continues`
- `docs: describe the Apply run`

| Type | For | Release notes |
| --- | --- | --- |
| `feat` | something new the board shows or does | Features |
| `fix` | a bug fix | Bug fixes |
| `perf` | a faster board | Performance |
| `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert` | anything else | Other changes |

A breaking change, such as a renamed `board.yaml` key, takes a `!` after the type or the scope,
or a `BREAKING CHANGE: <what changed>` line in the description. It goes under Breaking changes.

## Writing

The README and the code comments use plain words and short sentences, in the present tense.
One thing keeps one name: a stage, a task group, a change. Write new text the same way.

## Releases

1. A pull request titled `chore(release): <version>` raises `version` in
   `.claude-plugin/plugin.json`. The commits since the last release set the least version:
   - a breaking change raises the major version, or the minor version while it is 0;
   - a `feat` raises the minor version;
   - anything else raises the patch version.
2. Once it is merged, the maintainer runs the Release workflow on `main`, from the Actions tab
   or with `gh workflow run release.yml`. The workflow:
   - refuses a version lower than the commits ask for;
   - validates and tests the plugin;
   - runs `claude plugin tag --push`, which creates the tag `opsx-board--v<version>`;
   - creates the GitHub release, with notes from the commits since the last release.

`node .github/scripts/release.mjs` prints the notes of the next release. It needs the version
raised first.

## License

A contribution is licensed under the [MIT License](LICENSE) of this repository.
