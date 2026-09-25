@AGENTS.md

## Claude Code notes

- `git push` is denied in `.claude/settings.json`: the maintainer pushes. When a branch is
  ready, give the exact `git push -u origin <branch>` and `gh pr create …` commands.
- You are probably being watched by OrderUp while you work on it. Keep hook experiments on a
  temporary `HOME` so you don't break the session you're running in.
- Hook payload shapes change between Claude Code versions. Check
  [docs/architecture.md](docs/architecture.md#hook-events) and tolerate missing fields.
