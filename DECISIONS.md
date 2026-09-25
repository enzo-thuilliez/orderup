# Decisions

Short architecture decision records. Add new entries at the bottom; never rewrite accepted
ones, supersede them instead.

## ADR-001: Hooks for state, transcript tail for usage and discovery

- **Status:** accepted (2026-09-25)
- **Context:** Claude Code hooks give low-latency, exact state changes but carry no token
  usage and only exist once installed. Transcripts (`~/.claude/projects/**/*.jsonl`) have
  usage and every session, but state inferred from them is approximate.
- **Decision:** Use both. Hooks drive state when present. The tailer always runs: it provides
  token counts, discovers sessions started before OrderUp, and infers state when hooks are
  not installed.
- **Consequences:** Two event sources feed one reducer, so events must be idempotent and
  keyed by `sessionId`. Without hooks, `waiting` cannot be detected reliably.

## ADR-002: Fixed default port 7717

- **Status:** accepted (2026-09-25)
- **Context:** Installed hooks contain the server URL, so the port must be stable across runs.
- **Decision:** Default to `7717`, overridable with `--port`. Hooks installed with a custom
  port record that port.
- **Consequences:** If 7717 is taken, OrderUp fails fast with a clear message rather than
  silently picking another port that hooks don't know about.

## ADR-003: Bind 127.0.0.1 and check Host/Origin

- **Status:** accepted (2026-09-25)
- **Context:** The server exposes file paths, commands and (later) a control channel. Any
  website open in the browser could otherwise reach `localhost` or use DNS rebinding.
- **Decision:** Bind to `127.0.0.1` only. Reject HTTP and WebSocket requests whose `Host`
  is not `127.0.0.1:<port>` or `localhost:<port>`, and whose `Origin` (when present) is not
  the kitchen's own origin.
- **Consequences:** No LAN or remote viewing in V0. The Vite dev proxy must forward a valid
  origin.

## ADR-004: TypeScript everywhere, compiled with tsc

- **Status:** accepted (2026-09-25)
- **Context:** Node can strip types at runtime, but not for files inside `node_modules`,
  which is where a published package lives.
- **Decision:** TypeScript strict in every package. Node packages compile with `tsc -b`
  (project references); the web app is bundled by Vite. In dev, `tsx` and Vite resolve
  workspace packages to sources through a `source` export condition.
- **Consequences:** A build step before publishing. Single-package bundling for npm is V2 work.

## ADR-005: A `shared` workspace for the protocol

- **Status:** accepted (2026-09-25)
- **Decision:** Wire types and constants live in `orderup-shared`, imported by server and web.
- **Consequences:** One source of truth for the protocol; one more workspace to build.

## ADR-006: Hooks are never installed automatically

- **Status:** accepted (2026-09-25)
- **Context:** `~/.claude/settings.json` belongs to the user and may hold their own hooks.
- **Decision:** The CLI shows a diff and asks before writing, or acts only on
  `--install-hooks`. It backs up the file (`settings.json.orderup-bak`), merges instead of
  replacing, tags its entries so a second install is a no-op, and `--uninstall-hooks`
  removes exactly those entries.
- **Consequences:** First run without hooks falls back to transcript-only mode (ADR-001).

## ADR-007: `packages/` layout, npm scripts as the only task runner

- **Status:** accepted (2026-09-25)
- **Decision:** npm workspaces under `packages/`. No Makefile, no Docker, no extra task runner.
- **Consequences:** `npm run <script>` is the whole interface for humans, agents and CI.

## ADR-008: Observed cooks and crew cooks

- **Status:** accepted (2026-09-25); implementation starts in V1
- **Context:** OrderUp starts as an observer, but the goal includes a crew of agents that
  users can talk to and that build OrderUp itself. The protocol and storage should not need
  a rewrite when control arrives.
- **Decision:**
  - Two cook kinds. `observed`: any Claude Code session, read-only, zero tokens. `crew`:
    persistent roles run by the server through the Claude Agent SDK, can receive messages,
    cost tokens.
  - `sessionId` (one run) is distinct from `agentId` (a persistent crew identity with role and
    persona). Observed sessions have `agent: null`. Every session carries `cwd` and `repo`.
  - A client→server command channel is reserved in the protocol now (`crew.message`,
    `crew.spawn`). Until V1 the server answers `not_implemented`. Observed sessions never
    accept commands.
  - Crew state and session history persist in a local SQLite database via `node:sqlite`.
    `engines` is `>=22.13` in every package: the first 22.x release where `node:sqlite`
    works without `--experimental-sqlite`. CI tests Node 22.13 and 24.
- **Consequences:**
  - The command channel is a control surface that spends tokens and runs tools. Before it is
    enabled, it needs ADR-003 plus a per-launch secret handed to the browser by the CLI.
  - Crew sessions also write transcripts, so the tailer must skip session ids owned by crew.
  - `node:sqlite` is still marked experimental and may print a warning on older supported
    versions; the CLI should silence that one warning, not all of them.

## ADR-009: npm package names

- **Status:** accepted (2026-09-25)
- **Context:** `orderup` and the `@orderup` scope are taken on npm. The maintainer owns the
  `@orderup-cli` org, but a scoped name makes `npx` longer for no benefit.
- **Decision:**
  - The published package is `orderup-cli` (unscoped), with bin `orderup`. Users run
    `npx orderup-cli`, or `npm i -g orderup-cli` then `orderup`.
  - Internal workspaces are `orderup-shared`, `orderup-server` and `orderup-web`. They are
    never published: V2 bundles them into `orderup-cli`.
  - Every package stays `"private": true` until the npm-publish issue lands.
  - The GitHub repo stays `enzo-thuilliez/orderup`. The product name stays OrderUp.
- **Consequences:** A 0.0.1 placeholder of `orderup-cli` should be published early to hold
  the name. The `@orderup-cli` org is unused.
