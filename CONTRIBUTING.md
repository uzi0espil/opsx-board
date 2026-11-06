# Contributing

Issues and pull requests are welcome.

## Before you start

- For a bug, open an issue with the bug form. It asks for the versions and the pane.
- For a feature, or a change of what the board shows, open an issue first, so we agree on the
  change before you write code.
- For a vulnerability, follow [SECURITY.md](SECURITY.md). Do not open an issue.

## Set up

You need Claude Code, git, and the `openspec` CLI. `gh` is optional.

Load the plugin from your clone and run the checks:

```
claude --plugin-dir <your clone>
claude plugin validate <your clone>
claude plugin test <your clone>
```

[Develop](README.md#develop) in the README has the details. The tests need no login.

CI runs both checks on Ubuntu and Windows for each pull request, and each week on the newest
Claude Code.

## Pull requests

- One change per pull request.
- A change of behaviour comes with a test in `tests/`.
- When the board shows or does something new, the README says so.
- Write the title as the commit subject: what the change does, in the imperative, such as
  "Hide Next while a stage is in progress". Pull requests are squash-merged, so the title
  becomes the commit on `main`.

## Writing

The README and the code comments use plain words and short sentences, in the present tense.
One thing keeps one name: a stage, a task group, a change. Write new text the same way.

## Releases

The maintainer raises `version` in `.claude-plugin/plugin.json`, runs
`claude plugin tag --push`, and writes the release notes on GitHub.

## License

A contribution is licensed under the [MIT License](LICENSE) of this repository.
