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
- **Consequences:** A build step before publishing. Single-package bundling for npm: ADR-013.

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

- **Status:** accepted (2026-09-25); implementation starts in V1; runtime superseded by
  ADR-015
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
    never published: they are bundled into `orderup-cli` (ADR-013).
  - Every package stays `"private": true` until the npm-publish issue lands.
  - The GitHub repo stays `enzo-thuilliez/orderup`. The product name stays OrderUp.
- **Consequences:** A 0.0.1 placeholder of `orderup-cli` should be published early to hold
  the name. The `@orderup-cli` org is unused.

## ADR-010: Kitchen text as DOM overlays, scene derived from sessions

- **Status:** accepted (2026-09-25)
- **Context:** Cooks need readable, changing text (file paths, commands, names) and the page
  must never drift from what the server says. Text rendered into the WebGL scene is blurry
  at a distance and costly to redraw every time an activity changes.
- **Decision:**
  - Speech bubbles and name tags are DOM elements positioned with three.js `CSS2DRenderer`.
    Only the order tickets, which hang in the scene, are canvas textures, redrawn when their
    text changes.
  - The web keeps no history: a pure reducer turns server messages into the current sessions,
    and the scene is synced from them (station slots are the only extra state).
  - `?demo` feeds scripted `ServerMessage`s through the same reducer instead of a separate
    code path.
- **Consequences:** Labels stay crisp and cheap to update, but show through walls in walk
  mode. Placement and animation rules are pure functions under `web/src/logic` and are
  unit-tested without a browser.

## ADR-011: Hooks are a silent Node forwarder, not native `http` hooks

- **Status:** accepted (2026-09-27)
- **Context:** Claude Code has native `http` hooks since 2.1.63, which would POST straight
  to the server. But for an `http` hook, a refused connection is a non-blocking error, and
  Claude Code shows a "hook error" notice in the transcript for it. OrderUp is often not
  running, so users would see a notice on every tool call. A `command` hook that exits 0
  with empty output is silent. Hooks must never slow down or clutter Claude Code (AGENTS.md).
- **Decision:**
  - Install `command` hooks running Node with a tiny inline forwarder (`-e`, no file on
    disk to go missing when the npx cache is cleared). It exits 0 with no output in every
    case, gives up after 1 s on the socket and 1.5 s overall, and the hook `timeout` is 5 s.
  - Run Node by absolute path: the `process.execPath` of the Node running the installer.
    Claude Code may run hooks without the user's shell PATH, and version managers (nvm,
    fnm, volta, asdf, mise) only put `node` on PATH in interactive shells.
  - Use exec form (`command` = Node, `args` = `["-e", script]`, no shell, no quoting) on
    Claude Code 2.1.139 or later. Older or unknown versions get shell form with the path
    POSIX-quoted, which `sh` and Git Bash accept.
  - Add `"async": true` when `claude --version` is 2.1.119 or later: background hooks cost
    Claude Code no latency, and since that version their completion is silent and writes no
    empty transcript entries. `SessionEnd` stays synchronous so it isn't cancelled on exit.
    When the version is unknown, hooks stay synchronous (about 50 ms of Node startup each).
  - Tag entries with a `/*orderup-hook*/` marker inside the command, because extra keys in
    hook entries might fail Claude Code's settings validation.
- **Consequences:**
  - Hooks are pinned to one Node binary. With a version manager, they keep using that
    version after a switch, and fail (silently, by design) once it is uninstalled. The
    installer warns when the path is inside a version manager's directory. Re-running
    `orderup --install-hooks` updates our entries in place. `orderup` warns at start when the
    pinned Node is gone, and `orderup --doctor` checks the whole chain, including a live
    test event (`OrderUpDoctor`, accepted and ignored by the server).
  - Shell form doesn't run under PowerShell (Windows without Git Bash) on Claude Code
    older than 2.1.139.
  - Background hooks can arrive out of order, but only within a burst: `Pre`/`PostToolUse` of a fast tool
    may swap, which the reducer maps to the same `working` state. A turn's `Stop` follows a
    model response, far later than a forwarder's ~50 ms, so it doesn't overtake them. Revisit
    `http` hooks if Claude Code ever lets them fail silently.

## ADR-012: Edit settings.json as text

- **Status:** accepted (2026-09-27)
- **Context:** Re-serializing `settings.json` with `JSON.stringify` moved `hooks` to the end
  and re-laid out the user's one-line arrays. The diff we show then held lines we never
  meant to change, which undermines the point of asking (ADR-006).
- **Decision:**
  - Compute changes on the parsed object (`withOurHooks`, `withoutOurHooks`, both
    order-preserving). Apply them to the text with minimal edits: `jsonc-parser` (Microsoft,
    MIT, no dependencies) for insertions and in-place replacement, plus our own removal.
    jsonc-parser's removal miscounts by one character in one-line arrays.
  - New content follows its surroundings: the file's indentation and line endings, or a
    single line inside a one-line container.
  - Before writing, the edited text must parse to exactly the object model's result.
    Otherwise nothing is written.
- **Consequences:** One runtime dependency for the CLI. Its ESM build doesn't load in Node,
  so it's imported through its CommonJS entry. Appending after the user's last key still
  adds a comma to that line, which JSON requires.

## ADR-013: One bundled npm package, published from CI with provenance

- **Status:** accepted (2026-09-27)
- **Context:** Users run `npx orderup-cli`. The internal workspaces aren't on npm (ADR-009),
  so the package must carry them, and a Node CLI can't ship TypeScript sources (ADR-004).
- **Decision:**
  - esbuild bundles `cli`, `server` and `shared` from their sources (`source` condition) into
    one ESM file, `packages/cli/dist/index.js`. The built kitchen is copied to
    `packages/cli/dist/web/`. No source maps ship. `tsc -b` still typechecks the CLI but emits
    nothing for it.
  - `ws` and `jsonc-parser` stay runtime dependencies instead of being inlined: both are
    CommonJS (`ws` with optional native add-ons, `jsonc-parser` as UMD with runtime
    `require` calls) and break inside an ESM bundle. Neither has dependencies of its own.
  - `npm run smoke` installs the packed tarball in a temp project with a throwaway `HOME`
    and checks its contents, `--help`, and a start/serve/stop. CI runs it on Linux, then on
    macOS and Windows with the same tarball, for Node 22.13 and 24.
  - Changesets bumps versions. `changelog: false`: CHANGELOG.md stays hand-written.
  - `release.yml` publishes on a `v*` tag, or manually with a dry-run default, through npm
    trusted publishing (OIDC): no stored token, provenance on every version, behind a
    GitHub `npm` environment.
- **Consequences:** Two runtime dependencies. A release is a version PR followed by a tag.
  The one-time npm and GitHub setup is in [docs/releasing.md](docs/releasing.md).

## ADR-014: Record the README GIF on a fake clock, encode it in JavaScript

- **Status:** accepted (2026-09-27)
- **Context:** The README GIF must come from `?demo`, loop cleanly, stay under 5 MB and be
  re-recordable by anyone. Screen-capturing a real-time render drops or repeats frames
  depending on the machine, and headless Chromium renders WebGL in software, slowly.
- **Decision:**
  - `npm run demo:record` serves the built kitchen with `orderup --demo`, loads it in
    headless Chromium with Playwright's clock installed and paused, and advances it by one
    frame interval (50 ms, 20 fps) per screenshot. `requestAnimationFrame` is routed through
    the fake `setTimeout` at that interval, so the page renders once per kept frame. CSS
    animations (bell, bubbles) run on the compositor's real clock, so the recorder pauses
    each one and sets its `currentTime` from fake time every frame. One
    15 s loop plays first so the cooks are where the loop leaves them, then one loop is
    captured.
  - Encoding uses `gifenc` and `pngjs` (MIT, pure JavaScript) rather than ffmpeg or gifski:
    no system binaries to install on any OS. One global palette avoids colour flicker, and
    pixels within a small colour tolerance of what is already shown stay transparent.
  - The scene has no randomness (ticket sway is seeded by session id). With the above, two
    recordings of the same build are byte-identical (checked by SHA-256).
- **Consequences:** A recording takes about 2.5 minutes. Playwright and its Chromium are
  dev-only (`npx playwright install --only-shell chromium`). gifenc can't crop frames to
  the changed region, so size is managed with fps, viewport and tolerance flags.

## ADR-015: Crew runtime, auth and guardrails

- **Status:** accepted (2026-09-29); supersedes the Agent SDK runtime in ADR-008
- **Context:** ADR-008 planned to run crew cooks through the Claude Agent SDK. Its
  [docs](https://code.claude.com/docs/en/agent-sdk/overview) say that, unless previously
  approved, third-party products may not offer claude.ai login or rate limits and must use
  API keys. OrderUp is a distributed open-source tool, so that applies to it. Crew commands
  also run code on the user's machine and spend their money, so the runtime, auth, billing
  and guardrails are decided together, before any crew code.
- **Decision:**
  - **Runtime.** A crew member is the user's own installed `claude` CLI, spawned headless by
    the server: `claude -p` with `--output-format stream-json`, resumed by session id
    (`--resume`). OrderUp does not embed the Agent SDK.
  - **Auth.** OrderUp never reads, stores or forwards credentials. The spawned CLI uses
    whatever the user configured (subscription login or `ANTHROPIC_API_KEY`).
    `orderup --doctor` only checks that `claude` exists and is logged in.
  - **Billing (as of 2026-09-29).** Headless and SDK usage draws from subscription limits. A
    June 15 2026 split to a separate metered "Agent SDK credit" was announced, then paused;
    Anthropic says it will give notice before any change
    ([support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).
    So OrderUp always tracks and shows $ per run and per member: a switch to metered billing
    is then visible and needs no redesign.
  - **Observed vs crew.** Crew sessions also fire the user's OrderUp hooks. The runner
    records the session ids it owns, and the server renders those as `crew` cooks, not as
    duplicate observed ones (the tailer skip from ADR-008 uses the same list).
  - **Crew member.** `id`, `name`, `role`, `persona` (one line), working directory (a local
    repo path), `model`, allowed tools list, daily usage cap in API-equivalent USD.
  - **Guardrails.** Defaults, all configurable:
    - Crew is disabled unless `orderup` is started with `--crew`.
    - The permission mode is never bypassed by default. Each member has an explicit allowed
      tools list.
    - Daily usage cap per member, measured in API-equivalent USD as reported by the CLI (on a
      subscription this is notional: it measures quota consumption, not money billed; with an
      API key or a future metered credit it is real spend): default 5, set to 0 to disable. A
      run is refused when the cap is reached and killed if it crosses the cap mid-run.
    - Max turns per run: 30. Max concurrent members: 3.
    - Every child process is killed on server shutdown.
    - Crew never pushes to `main`: work happens on branches, and lands through PRs only.
  - **Command channel.** WebSocket commands (talk, assign, stop) run code on the user's
    machine, so the channel is treated as a remote code execution surface. It binds to
    `127.0.0.1` only (ADR-003), requires a random per-start token (written to a file with
    `0600` permissions and injected into the locally served page), checks `Origin`, and
    rejects everything else.
  - **Cloud routines** are out of scope for V1. They run on Anthropic's cloud, draw
    subscription usage with daily run caps, and never appear as cooks. They are a candidate
    for scheduled crew in V2, through the
    [routines fire API](https://platform.claude.com/docs/en/api/claude-code/routines-fire).
- **Alternatives considered:**
  - Agent SDK with subscription login: rejected, not allowed by its terms for a third-party
    product.
  - Agent SDK with an API key only: rejected as the default, because it forces API billing on
    every user. Can be revisited as an option.
  - Cloud routines as the crew runtime: deferred to V2 (see above).
- **Consequences:**
  - OrderUp depends on the `claude` CLI's flags and stream-json output format.
    `orderup --doctor` pins a minimum version and fails below it.
  - Cost must be visible everywhere crew appears: per run, per member, per day.
  - Issues #17 to #26 implement this ADR.
