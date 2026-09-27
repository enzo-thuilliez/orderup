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

CI runs `lint`, `format:check`, `typecheck`, `test` and `build` on Node 22.13 and 24, on every push to `main` and every PR.

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
- [CHANGELOG.md](CHANGELOG.md) under `Unreleased` for user-visible changes.

## Testing hooks safely

Never test the hook installer against your real `~/.claude/settings.json`:

```sh
HOME=$(mktemp -d) npx tsx --conditions=source packages/cli/src/index.ts --install-hooks
```
