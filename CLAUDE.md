@AGENTS.md

## Claude Code notes

- `.claude/settings.json` allows `git push -u origin` for `feat/`, `fix/`, `chore/` and
  `docs/` branches and `gh pr create`. Pushes to `main` and force pushes are denied.
- Project allow rules only load once the workspace is trusted: run `claude` interactively in
  the repo and accept the trust dialog. Until then only the deny rules apply.
- You are probably being watched by OrderUp while you work on it. Keep hook experiments on a
  temporary `HOME` so you don't break the session you're running in.
- Hook payload shapes change between Claude Code versions. Check
  [docs/architecture.md](docs/architecture.md#hook-events) and tolerate missing fields.
