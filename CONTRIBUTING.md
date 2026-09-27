# Contributing to OrderUp

Thanks for helping out in the kitchen! By participating you agree to our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You need Node 24 (see `.nvmrc`; Node 22.13+ works) and npm.

```sh
git clone git@github.com:enzo-thuilliez/orderup.git
cd orderup
nvm use          # optional
npm install      # also installs the git hooks
npm run dev      # server on http://127.0.0.1:7717, kitchen on http://localhost:5173
```

## Scripts

| Command                | What it does                              |
| ---------------------- | ----------------------------------------- |
| `npm run dev`          | Server (watch mode) and Vite dev server   |
| `npm run lint`         | ESLint                                    |
| `npm run format`       | Prettier, writes changes                  |
| `npm run format:check` | Prettier, check only                      |
| `npm run typecheck`    | `tsc -b` for Node packages, `tsc` for web |
| `npm test`             | Vitest                                    |
| `npm run build`        | Compile Node packages, bundle the web app |
| `npm run smoke`        | Pack `orderup-cli`, install it, run it    |

CI runs `lint`, `format:check`, `typecheck`, `test`, `build` and `smoke` on Node 22.13 and 24, on every push to `main` and every PR, then smoke-tests the packed CLI on macOS and Windows. The `ci-pass` check is green only if all of it is.

## Workflow

1. Pick or open an issue. Feature issues are "order tickets".
2. Branch from `main`: `feat/<short-name>`, `fix/…`, `docs/…` or `chore/…`.
3. Commit with [Conventional Commits](https://www.conventionalcommits.org/):
   `type(scope): summary`, e.g. `feat(web): add coffee break animation`.
   Scopes: `shared`, `server`, `cli`, `web`, `docs`, `ci`, `deps`, `repo`.
   The `commit-msg` hook runs commitlint; `pre-commit` runs ESLint and Prettier on staged files.
4. Open a PR against `main` using the template. CI must be green.
5. Nobody pushes to `main` directly.

## Using Claude Code

The repo ships project permissions in `.claude/settings.json`. Claude Code ignores their
allow rules until you trust the workspace: run `claude` once in the repo and accept the
trust dialog. Deny rules (no force pushes, no pushes to `main`) apply either way.

## Docs to keep in sync

- [docs/architecture.md](docs/architecture.md) when behaviour or the protocol changes.
- [DECISIONS.md](DECISIONS.md) for decisions with trade-offs (add an ADR).
- [CHANGELOG.md](CHANGELOG.md) under `Unreleased` for user-visible changes, plus a changeset
  (`npx changeset`) if `orderup-cli` needs a release for it. See
  [docs/releasing.md](docs/releasing.md).

## Testing hooks safely

Never test the hook installer against your real `~/.claude/settings.json`. Run the CLI
from source in a sandbox instead: a temporary `HOME`, no `CLAUDE_CONFIG_DIR`.

```sh
npm run cli:sandbox -- --install-hooks --port 7799
ORDERUP_SANDBOX_HOME=/tmp/… npm run cli:sandbox -- --doctor --port 7799   # same sandbox again
```

Use a spare port so a kitchen already running on 7717 keeps working.

- Tests get a temporary `HOME` automatically (`test/setup.ts`). A guard fails any test that
  runs with `HOME` or `CLAUDE_CONFIG_DIR` outside the system temp directory.
- `npm run dev` never offers to install hooks.
- When a coding agent is working in your checkout, `dist/` may hold half-finished code.
  Review and try its branches in a separate worktree
  (`git worktree add ../orderup-review <branch>`), not in the checkout it is editing.
