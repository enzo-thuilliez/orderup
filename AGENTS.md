# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, ...) working on OrderUp.
Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Project

OrderUp is a cozy low-poly 3D restaurant kitchen (three.js) where Claude Code sessions come
alive as cooks. Users run `npx orderup-cli` to watch their existing sessions. Zero config.

Two kinds of cooks (ADR 008):

- **Observed**: any Claude Code session on the machine. Read-only, zero token cost. OrderUp only
  reads hook events and local transcripts. It never calls an LLM on this path.
- **Crew** (V1+): persistent roles run by the server through the Claude Agent SDK. They can be
  talked to and cost tokens.

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
npm run lint           # eslint
npm run format         # prettier --write
npm run format:check   # prettier --check
npm run typecheck      # tsc -b + web
npm test               # vitest
npm run build          # tsc -b + vite build
```

Run lint, format:check, typecheck, test and build before proposing a PR. CI runs the same.

## Conventions

- **Never commit or push to `main`.** Work on a feature branch (`feat/…`, `fix/…`, `docs/…`,
  `chore/…`) and open a PR. CI must pass before merge.
- **Conventional commits**, enforced by commitlint: `feat(web): add coffee break animation`.
  Scopes: `shared`, `server`, `cli`, `web`, `docs`, `ci`, `deps`, `repo`.
- TypeScript strict, ESM only. In Node packages, relative imports end in `.js`.
- Wire types live in `orderup-shared` only. Never duplicate them in server or web.
- The session reducer (`server/src/sessions/machine.ts`) stays pure; timers and I/O live outside it.

## Hard rules

- The observer path makes **no network calls** other than to `127.0.0.1`, **no LLM calls** and
  **no telemetry**.
- The server binds to `127.0.0.1` only and checks `Host` and `Origin` on HTTP and WebSocket.
- Never modify `~/.claude/settings.json` without explicit user confirmation. In tests and
  manual checks, point `HOME` at a temporary directory.
- Hooks installed by OrderUp must never slow down or break Claude Code: short timeout, silent
  failure, exit code 0.
- No external assets: geometry is procedural, colours come from `web/src/palette.ts`.
- Prompt text from hooks or transcripts is never stored or broadcast.

## When you change things

- Behaviour or protocol: update [docs/architecture.md](docs/architecture.md).
- A decision with trade-offs: add an ADR to [DECISIONS.md](DECISIONS.md).
- User-visible change: add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
