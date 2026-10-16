# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, ...) working on OrderUp.
Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Project

OrderUp is a cozy low-poly 3D restaurant kitchen (three.js) where Claude Code sessions come
alive as cooks. Users run `npx orderup-cli` to watch their existing sessions. Zero config.

Two kinds of cooks (ADR 008):

- **Observed**: any Claude Code session on the machine. Read-only, zero token cost. OrderUp only
  reads hook events and local transcripts. It never calls an LLM on this path.
- **Crew** (V1+): a head chef the server runs as the user's own headless `claude` CLI
  (ADR-015), with cooks at fixed stations run as Claude Code subagents (ADR-016). The user
  talks only to the head chef; cooks can be peeked at, never prompted. Crew costs tokens.

## Kitchen metaphor

| Claude Code            | Kitchen                                  |
| ---------------------- | ---------------------------------------- |
| Session                | A cook with a station                    |
| Working (tool calls)   | Cooking at the station, showing file/cmd |
| Waiting for user input | The bell rings at the pass               |
| Turn finished          | Plate at the pass, "Order up!"           |
| Idle                   | Coffee break out back                    |
| Subagent               | Commis cook next to their chef           |
| Token usage            | Running ticket on the rail               |
| GitHub issue           | Order ticket                             |

States are `working | waiting | done | idle`. Mapping from hook events:
[docs/architecture.md](docs/architecture.md).

## Layout

```
packages/shared   orderup-shared  wire protocol types and constants (server <-> web)
packages/server   orderup-server  hook intake, transcript tail, session reducer, WebSocket
packages/cli      orderup-cli      `orderup` bin: starts server, opens browser, installs hooks
packages/web      orderup-web     Vite + three.js kitchen
```

## Commands

```sh
npm install            # also installs git hooks (lint-staged, commitlint)
npm run dev            # server on :7717 + Vite on :5173
npm run cli:sandbox -- <flags>   # CLI from source with a temporary HOME
npm run demo:record   # build, then record docs/assets/demo.gif from ?demo (needs Playwright Chromium)
npm run lint           # eslint
npm run format         # prettier --write
npm run format:check   # prettier --check
npm run typecheck      # tsc -b + web
npm test               # vitest
npm run build          # tsc -b + vite build + bundle orderup-cli (scripts/bundle-cli.mjs)
npm run smoke          # npm pack orderup-cli, install it in a temp dir, run and stop it
```

Run lint, format:check, typecheck, test, build and smoke before proposing a PR. CI runs the same.

## Conventions

- **Never commit or push to `main`.** Work on a feature branch (`feat/…`, `fix/…`, `docs/…`,
  `chore/…`) and open a PR. CI must pass before merge.
- **Conventional commits**, enforced by commitlint: `feat(web): add coffee break animation`.
  Scopes: `shared`, `server`, `cli`, `web`, `docs`, `ci`, `deps`, `repo`.
- TypeScript strict, ESM only. In Node packages, relative imports end in `.js`.
- Wire types live in `orderup-shared` only. Never duplicate them in server or web.
- The session reducer (`server/src/sessions/machine.ts`) stays pure; timers and I/O live outside it.

## Working from an issue

- **Start**: read the issue, every issue in its Dependencies and the ADRs it names in
  [DECISIONS.md](DECISIONS.md). If a dependency is still open, stop and say so.
- **Branch**: `feat/`, `fix/`, `chore/` or `docs/` plus a short slug. One issue, one branch,
  one PR.
- **PR body**: first line `Closes #N`, or `Part of #N` when the issue says the PR is one step.
  Then What, How, Tests, and anything left for a later PR.
- **Commits**: conventional, subject lowercase after the type and scope (commitlint rejects
  `ADR…`, `GitHub…`). PR titles are not linted.
- **CHANGELOG**: one bullet under `Unreleased`, added in its own last commit. Never edit
  existing bullets.
- **Conflicts**: merge `main` into the branch. Never rebase, never force push (denied by
  `.claude/settings.json`). Never resolve conflicts in GitHub's web editor.
- **Migrations**: only one open PR may add a sqlite migration. Check open PRs touching
  `packages/server/src/persistence/db.ts` before adding one.
- **GitHub**: use `gh api` (REST) for issues and PRs. `gh issue view` and `gh pr edit` without
  `--json` fail on the Projects classic deprecation.
- **Web changes**: before/after screenshots in the PR.
- **Real `claude` CLI behaviour**: check it with `scripts/probe-claude-cli.mjs` and record the
  findings in the ADR's Follow-ups. Never guess.
- **Before pushing**: lint, format:check, typecheck, test, build, smoke.

## Hard rules

- The observer path makes **no network calls** other than to `127.0.0.1`, **no LLM calls** and
  **no telemetry**.
- The server binds to `127.0.0.1` only and checks `Host` and `Origin` on HTTP and WebSocket.
- Never modify `~/.claude/settings.json` without explicit user confirmation. Tests get a
  temporary `HOME` from `test/setup.ts` (a guard fails them otherwise); for manual checks use
  `npm run cli:sandbox`.
- Hooks installed by OrderUp must never slow down or break Claude Code: short timeout, silent
  failure, exit code 0.
- No external assets: geometry is procedural, colours come from `web/src/palette.ts`.
- Prompt text from hooks or transcripts is never stored or broadcast. The one exception
  (ADR-017): the cook panel's live terminal may show it over the token-authenticated crew
  channel, held in memory only. Without `--crew` it shows none.

## When you change things

- Behaviour or protocol: update [docs/architecture.md](docs/architecture.md).
- A decision with trade-offs: add an ADR to [DECISIONS.md](DECISIONS.md).
- User-visible change: add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
