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
  ADR-015; crew identity refined by ADR-016
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
  - _Refined by [ADR-016](#adr-016-head-chef-and-brigade-model): crew is a head chef plus
    fixed stations, not free-form agents, and commands go to the head chef only._
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

- **Status:** accepted (2026-09-29); supersedes the Agent SDK runtime in ADR-008; crew member
  model and concurrency refined by ADR-016
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
    _Refined by [ADR-016](#adr-016-head-chef-and-brigade-model): one head chef plus fixed
    stations replace free-form members._
  - **Guardrails.** Defaults, all configurable:
    - Crew is disabled unless `orderup` is started with `--crew`.
    - The permission mode is never bypassed by default. Each member has an explicit allowed
      tools list.
    - Daily usage cap per member, measured in API-equivalent USD as reported by the CLI (on a
      subscription this is notional: it measures quota consumption, not money billed; with an
      API key or a future metered credit it is real spend): default 5, set to 0 to disable. A
      run is refused when the cap is reached and killed if it crosses the cap mid-run.
    - Max turns per run: 30. Max concurrent members: 3. _ADR-016: a member is one `claude -p`
      process (the head chef); stations do not count._
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
  - Issues #17 to #26 implement this ADR, as refined by ADR-016.

## ADR-016: Head chef and brigade model

- **Status:** accepted (2026-10-15); refines the crew member model of ADR-008 and ADR-015.
  ADR-015's runtime, auth, billing, budget cap and command channel stay as decided.
- **Context:** ADR-015 described crew as free-form members the user chats with one by one.
  That does not read well in the kitchen (any cook could be doing anything) and makes the user
  manage every member. The V1 product decision (2026-10-15) is a brigade: the user talks only
  to a head chef, who splits the work, dispatches it to cooks at fixed stations and collects
  their reports on a whiteboard at the pass. This ADR decides how that runs on top of
  ADR-015, what OrderUp can and cannot enforce, and what V1 stores. It is the contract for
  #19, #20, #21, #22, #23, #26, #31 and #36.
- **Decision:**
  - **1. Runtime: one head chef session, stations as subagents.** The runner launches only
    the head chef, as one `claude -p` session exactly as in ADR-015 (stream-json,
    `--resume`, the user's own CLI and credentials). Each station is a Claude Code
    [subagent](https://code.claude.com/docs/en/sub-agents): a name, a description, a tool
    list, `isolation` for writing stations (point 10) and the station prompt. The chef
    dispatches work with the `Agent` tool; Claude Code runs the subagents, in parallel when
    the chef asks for it. How the definitions reach the chef is settled in #21 (see Follow-ups):
    preferably the CLI's `--agents` flag, so nothing is written into the user's repo, with
    files in the repo's `.claude/agents/` as the fallback, installed after a diff and a
    confirmation like the hooks. The runner never passes `--bare`: bare mode skips hooks,
    which the peek and station identification need, and `.claude/agents/`
    ([headless docs](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)).
  - **2. Stations: a fixed enum with stable ids.** The ids are the wire values (#36) and never
    change. The subagent name (the `--agents` key, or the file name and frontmatter `name` in
    the fallback) is `orderup-<id>` so it cannot clash with the user's own subagents. Tool lists are Claude Code tool names.

    | Id             | Purpose                                                                                                             | Allowed tools                                                                  | Writes files                                               |
    | -------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
    | `head-chef`    | Orchestrator: reads the task, splits it, dispatches to stations, owns the branch and the PR, writes the report card | `Agent` (station types only), `Read`, `Grep`, `Glob`, `Bash` (git and `gh pr`) | No source edits; git and PR only                           |
    | `hot`          | Backend / API: server code, protocol, CLI                                                                           | `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash`                                | Yes, in its own worktree (point 10)                        |
    | `garde-manger` | Frontend / UI: web, scene, styles                                                                                   | `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash`                                | Yes, in its own worktree (point 10)                        |
    | `commis`       | Research and code reading: answers questions, maps code, prepares context for other stations                        | `Read`, `Grep`, `Glob`                                                         | No (read-only tools only, no `Bash`)                       |
    | `pastry`       | Tests / QA: writes and runs tests, lint, typecheck; reports failures                                                | `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash`                                | Yes, tests and fixtures only (prompt), in its own worktree |
    | `dish`         | Refactor / cleanup: renames, dead code, formatting, small refactors without behaviour change                        | `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash`                                | Yes, in its own worktree (point 10)                        |

    `head-chef` is the main session, not a subagent: its tools are set by the runner's
    permission flags. No station gets the `Agent` tool, and the runner sets
    `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` so stations cannot spawn cooks of their own
    ([sub-agents docs](https://code.claude.com/docs/en/sub-agents)). "Tests and fixtures
    only" for `pastry` is an instruction in its prompt, not something the tool list can
    enforce. Every station inherits ADR-015's rules: permissions are never bypassed and
    nothing is pushed to `main`.

  - **3. Theme split.** A kitchen theme only changes visuals: the dish, the gesture, the props
    and the palette. Station ids, prompts, tools and caps never depend on the theme. V1 ships
    one theme, the Chinese kitchen gestures (#22). One kitchen per repo with a theme dropdown
    (#33) and the full Chinese theme kit (#34) are out of scope for V1.
  - **4. Concurrency: what OrderUp can enforce.** Several cooks may work at the same station.
    Targets: 4 per station, 8 in total.
    - With option A, subagent parallelism happens inside Claude Code, not in OrderUp. The
      per-station cap of 4 is an instruction in the head chef's prompt, so it is a **soft
      limit**: OrderUp shows it when the chef exceeds it but cannot prevent it.
    - The global cap of 8 is passed to the chef process as
      `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=8`; Claude Code then refuses the next `Agent`
      call with `Concurrent subagent limit reached`
      ([sub-agents docs](https://code.claude.com/docs/en/sub-agents)). This is enforced by
      Claude Code, not by OrderUp, and depends on the user's CLI version, so OrderUp treats
      it as best effort and also states the cap in the chef's prompt.
    - The **hard limit** stays ADR-015's: the daily usage cap is checked before each run and
      the runner kills the chef process (and with it every station) when a run crosses it,
      plus max 30 turns per run.
    - ADR-015's "max 3 concurrent members" now counts `claude -p` processes. The head chef
      is one member; stations are not members and do not count. V1 runs one head chef per
      kitchen, so the limit is met by construction and stays as a guard for later (#33).
  - **5. Report card.** Every chef run is tied to a task id chosen by the server and given
    to the chef in its prompt. The chef's final message for a task must contain exactly one
    fenced code block with the info string `json` matching schema version 1. The runner
    parses that block from the run's final result.
    - Example:

      ```json
      {
        "schema": 1,
        "taskId": "t_01J…",
        "ticket": { "repo": "owner/name", "number": 31 },
        "stations": ["hot", "pastry"],
        "summary": "One paragraph, plain text, at most 600 characters.",
        "prUrl": "https://github.com/owner/name/pull/42",
        "filesChanged": ["packages/server/src/board.ts"],
        "unmerged": []
      }
      ```

    - Fields: `ticket` and `prUrl` are `null` when there is none. `stations` holds station
      ids other than `head-chef`. `filesChanged` holds repo-relative paths. `unmerged` lists
      the station branches the chef could not merge (point 10), and is empty otherwise.
    - Card statuses are exactly these five:
      - `cooking`: created when a task starts, on an `assign` or on a `send-back` that
        resumes it.
      - `ready`: the run ended. This is when the "Order up!" bell rings and the browser
        notification fires (#31).
      - `read`: the user opened the card.
      - `approved`: the user approved the work.
      - `sent-back`: the user sent it back to the chef with a comment.
    - A `talk` that ends with a report block also creates a card, directly as `ready`. A
      `talk` without one is plain conversation.
    - If the block is missing, appears more than once, is not valid JSON, fails the schema or
      names a different `taskId`, the card is still created (or moved) as `ready` with
      `malformed: true` and the chef's raw final text, so nothing is lost.
    - A run that ends with an error or a stop also ends as `ready`. Its run status is stored
      on the card and shown as an error badge.
    - A card with a non-empty `unmerged` list shows a "needs you" badge.
  - **6. Talking: the chef only.** Every command goes to the head chef: `talk`, `assign`,
    `stop`, and the card actions `approve` and `send-back`. No command prompts a cook, and a
    command naming any other station is rejected (#20, #36). `send-back` resumes the chef's
    session with the card id and the user's comment, and moves the card back to `cooking`.
    `approve` only records the decision and starts no run: it spends no tokens and never
    merges anything.
  - **7. Peek.** Clicking a cook opens a read-only view built from hook events and
    transcripts, the same sources as observed cooks: current tool and target, files touched
    (from `tool_input` paths), and the last few assistant messages. It makes no LLM call and
    sends no command. Peek data lives in memory only. Prompt text is never stored or
    broadcast: not the user's prompts, and not the `prompt` input of the chef's `Agent`
    calls (the dispatch is shown by its short `description` only).
  - **8. Identifying stations.** Documented fields are enough; no extra protocol is needed
    in the chef's output:
    - Hooks fired inside a subagent carry the common fields `agent_id` and `agent_type`;
      `agent_type` is the subagent's name (`orderup-hot` maps to `hot`)
      ([hooks: common input fields](https://code.claude.com/docs/en/hooks#common-input-fields)).
    - `SubagentStart` carries `agent_id` and `agent_type`; `SubagentStop` adds
      `agent_transcript_path` and `last_assistant_message`
      ([SubagentStart](https://code.claude.com/docs/en/hooks#subagentstart-input),
      [SubagentStop](https://code.claude.com/docs/en/hooks#subagentstop-input)).
    - The chef's `Agent` tool call has `tool_input.subagent_type`, and its `tool_response`
      carries `agentId`, for foreground and background runs
      ([hooks: PreToolUse input](https://code.claude.com/docs/en/hooks#pretooluse-input)).
      The runner also sees these `tool_use` blocks in its own stream-json output, where
      subagent messages carry `parent_tool_use_id`
      ([headless: follow subagent messages](https://code.claude.com/docs/en/headless#follow-subagent-messages)).
    - Subagent transcripts are stored as
      `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`
      ([sub-agents docs](https://code.claude.com/docs/en/sub-agents)). The docs do not name a
      field inside a transcript line that holds the agent type, so the station of a
      transcript comes from its `agentId` (file name) joined with the hook or stream data
      above, never from the transcript alone.
    - Fallback: when no `agent_type` arrives (older CLI, or a dropped hook), the runner uses
      the `subagent_type` → `agentId` pair from its own stream. When neither is known, or the
      type is not an `orderup-*` station (for example the built-in `Explore`), the cook is
      shown as an unassigned commis cook next to the chef, exactly like observed subagents
      today. `SubagentStop` events with an empty `agent_type` (Claude Code's internal agents)
      are ignored. All of these fields are optional in OrderUp, as with every hook field.
  - **9. Persisted entities (node:sqlite).** V1 stores the following. #17 builds the
    database, migrations, runs and usage; #31 builds the report cards; the rest land with
    the issue named.
    - `runs`: one row per `claude -p` invocation of the chef: id, chef session id, task id,
      trigger (`talk`, `assign`, `send-back`), start and end time, status (#17, #19).
    - `usage`: tokens and API-equivalent USD per run, rolled up per day for the cap (#17).
    - `chef_messages`: the head chef conversation: what the user typed in OrderUp's chat and
      the chef's final replies, so history survives a restart (#23). This is text the user
      typed into OrderUp, not prompt text read from hooks or transcripts.
    - `report_cards`: one per task: task id, ticket ref, stations, summary, PR URL, files
      changed, status, `malformed` flag with the raw text when malformed, run status,
      timestamps (#31).
    - `card_events`: status changes of a card with who/when, and the user's comment for
      `send-back` (#31).
    - `owned_sessions`: the chef session ids and subagent ids (`agentId`) the runner owns, so
      those cooks render as crew and the tailer skips them (ADR-015) (#19).
    - `brigade_config`: working repo, chef model, per-station and global caps, daily usage
      cap, and the version/hash of the station definitions in use (#21).
    - Not stored: peek data, hook payloads, transcript content, prompts.
  - **10. Write isolation.** Writing stations (`hot`, `garde-manger`, `pastry`, `dish`) may
    run in parallel and must never edit the same checkout at the same time. Claude Code
    supports this: `isolation: worktree` in a subagent definition (frontmatter or the
    `--agents` JSON) runs the subagent in its own temporary git worktree
    ([sub-agents: frontmatter fields](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields),
    [worktrees: isolate subagents](https://code.claude.com/docs/en/worktrees#isolate-subagents-with-worktrees)).
    The [Claude Code changelog](https://code.claude.com/docs/en/changelog) lists it in 2.1.50.
    - The four writing stations set `isolation: worktree`. `commis` is read-only and reads
      the chef's checkout directly.
    - Subagent worktrees branch from the repo's default branch unless `worktree.baseRef` is
      `"head"`. The runner passes that setting with `--settings`, so each station starts from
      the task branch the chef has checked out.
    - Each writing station commits its work on its worktree branch and names that branch in
      its final message. The docs do not say how the `Agent` result reports a worktree
      branch, so the station prompt makes it explicit.
    - The head chef merges the station branches into the task branch one at a time, then
      pushes the task branch and opens the PR (#26).
    - On a merge conflict the chef aborts that merge and sends the work back to the same
      station once, with the conflicting files, to redo it on top of the current task
      branch. If it conflicts again, the chef leaves that branch unmerged, lists it in the
      card's `unmerged` field, and the card reaches `ready` with a "needs you" badge. The
      chef never resolves a conflict by picking a side.
    - `-p` runs do not clean up their worktrees
      ([worktrees: clean up](https://code.claude.com/docs/en/worktrees#clean-up-worktrees)).
      The runner removes merged station worktrees and their branches when the card reaches
      `ready`, and keeps unmerged ones until the card is approved or sent back. Worktrees
      live under `.claude/worktrees/`, which the runner adds to `.git/info/exclude` (local,
      never committed).
    - Isolation is about files, not headcount: the caps of point 4 still apply.
- **Alternatives considered:**
  - **Option B: one `claude -p` process per station, dispatched by the server.** Gives
    OrderUp hard per-station concurrency and budget, and lets cooks talk to each other. It
    also means OrderUp writes its own scheduler, splits tasks itself or through an extra
    chef process, and multiplies processes against ADR-015's limit of 3. Deferred: it is
    only needed for cooks talking to each other (#35), which is not in V1.
  - Station files in `.claude/agents/` as the only path: visible and reviewable as a diff,
    but they write into the user's repo. Kept as the fallback to `--agents` (see Follow-ups,
    #21).
  - No write isolation, one writing station at a time: simpler, but serialises most tasks.
    Not needed, since `isolation: worktree` exists (point 10).
  - Free-form members as in ADR-015: rejected for V1, see Context.
  - The chef announcing each dispatch in a parseable line: not needed, documented hook and
    stream fields identify stations (point 8). Revisit if they disappear.
- **Consequences:**
  - The protocol types from #29 change: free-form `CrewMember` and `memberId` go away in
    favour of stations and the chef (#36).
  - OrderUp now also depends on Claude Code's subagent file format, the `Agent` tool and the
    `agent_id` / `agent_type` hook fields. `orderup --doctor` checks the CLI version and the
    installed station files.
  - Per-station caps are soft. Users who need hard per-station limits wait for option B.
  - The cost of a run includes its stations; it is shown per run and per day, not per
    station, in V1.
  - With `--agents`, the station definitions never touch the user's repo; with the fallback
    files, installing them is a visible, confirmed change, like the hooks.
  - Station worktrees take disk space until the runner removes them, and merge conflicts
    between stations are possible; the chef retries once, then hands them to the user.
- **Follow-ups (answers to the open questions on PR #37, 2026-10-15):**
  - #19, crew runner:
    - Whether `total_cost_usd` in the chef's `-p` result includes its stations' cost is
      verified with a real run before the budget cap is trusted.
    - Push guard: in addition to permission rules, the runner installs a git `pre-push` hook
      in the chef's checkout that refuses pushes to the repo's default branch.
  - #21, brigade config:
    - Station definitions: prefer the CLI's `--agents` flag, which carries the full
      definition (prompt plus frontmatter fields, `tools` and `isolation` included), so
      nothing is written into the user's repo
      ([sub-agents: choose the subagent scope](https://code.claude.com/docs/en/sub-agents#choose-the-subagent-scope)).
      Files in `.claude/agents/` stay the fallback. Passing `--agents` a JSON file path (for
      long prompts) needs Claude Code 2.1.281; inline JSON has no stated minimum.
    - Minimum CLI version: at least 2.1.217, the first with
      `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` per the
      [Claude Code changelog](https://code.claude.com/docs/en/changelog). The exact hook field
      versions are pinned in #21 for `--doctor`; the changelog lists `agent_id` and
      `agent_type` on hook events in 2.1.69, `agent_id` and `agent_transcript_path` on
      `SubagentStop` in 2.0.42 and `isolation: worktree` in 2.1.50, all below 2.1.217.
  - #31, report whiteboard:
    - The bell rings when a card becomes `ready`: confirmed.
    - Failed or stopped runs end as `ready` with their run status on the card, shown as an
      error badge: confirmed for V1.
  - #19, real CLI probe (`scripts/probe-claude-cli.mjs`, Claude Code 2.1.301, 2026-10-16,
    `--model haiku`, the arguments of `buildChefArgs` on `main`):
    - a. `--agents`: 2.1.301. Accepted: the `system/init` line lists all five `orderup-*`
      names in `agents`. The chef's call is `tool_use` `name: "Agent"` with
      `input.subagent_type: "orderup-commis"`, and the `user` line of its `tool_result` has
      `tool_use_result.agentId` (also in the text as `agentId: …`). The dispatch ran in the
      background by default (`tool_use_result.isAsync: true`, `status: "async_launched"`,
      `subagent_stats.requested.unset: 1`, `started_in_background: 1`): the `tool_result`
      comes back at once, the chef's turn ends with a first `result` (`result_index: 0`),
      then a `system/task_notification` starts a second turn in the same process, with a
      second `system/init` and a second `result` (`result_index: 1`,
      `origin.kind: "task-notification"`). `system/task_started` carries `task_id` (equal
      to `agentId`), `tool_use_id`, `subagent_type` and also `prompt`. Station messages carry
      `parent_tool_use_id`. Runner change: a `result` line is not the end of a run; keep
      ending at process exit and taking the last `result` as final (as today), and never
      forward `system/task_started.prompt` (`stream.ts` ignores `system` lines today, keep it
      so if it starts reading `task_*` lines as a second source of `agentId` →
      `subagent_type`).
    - b. Cost: 2.1.301. `result.total_cost_usd` includes the station: `modelUsage` token
      totals equal the chef's plus the station's per-message sums (cache reads 92596 + 3880 =
      96476, cache writes 34166 + 7549 = 41715). `total_cost_usd` and `modelUsage` are
      cumulative for the process (both `result` lines reported 0.00903), while `result.usage`
      covers only that turn and the chef only (its two `result.usage` values add up to the
      chef's sums, without the station). The per-message `usage.output_tokens` in
      `assistant` lines are partial (53 summed against 579 in `modelUsage`). On `--resume`
      both totals also carry the session's earlier runs (case e: cache reads 8730 + 39903 =
      48633 in the resumed run's `modelUsage`). Runner change: the cost delta logic (subtract
      what the session already recorded) is right; take tokens from `modelUsage` (summed over models, as
      a delta like the cost) instead of adding up `result.usage`, which misses stations.
    - c. Worktree branch: 2.1.301. Not in the `Agent` `tool_result` (an async launch).
      The station's worktree is `.claude/worktrees/agent-<agentId>` on the branch
      `worktree-agent-<agentId>`, both derivable from `agentId`. When the station commits,
      a `system/vcs_state_changed` line has `kind: "commit"`, `branch` and `cwd` (no agent
      id field; `cwd` contains it). The branch contains the chef's HEAD (the task branch
      commit), so `worktree.baseRef: "head"` through `--settings` works. With the runner's
      flags as-is the station could not write: a background station cannot prompt, so its
      `Bash` call was denied with `system/permission_denied`,
      `decision_reason_type: "asyncAgent"`, and the empty worktree was removed. That denial
      is not in `result.permission_denials` (empty). A user-level `PreToolUse` hook also ran
      inside the station and blocked its first `Bash` call. With
      `--permission-mode acceptEdits` and `--allowedTools` for `git add` / `git commit` the
      station committed. Runner change: give writing stations a permission policy (permission
      mode plus allow rules for git, through flags or `--settings`), surface
      `system/permission_denied` lines, and take the station branch from `agentId` or
      `vcs_state_changed` rather than only the `Branch:` line of the station prompt.
    - d. Settings merge: 2.1.301. With `--settings {"worktree":{"baseRef":"head"}}` and no
      `--model`, the `system/init` fields `model`, `permissionMode`, `mcp_servers` (count),
      `agents`, `slash_commands` and the user's hook lines (`system/hook_started`,
      `hook_response`) were identical to a run without `--settings`. `tools` differed only by
      one claude.ai connector whose `mcp_servers` status was `pending` instead of
      `connected` at init (timing: another `--settings` run had it `connected`). A
      project-local settings layer written by the probe (a `model` and a `permissions.deny`
      rule) applied under `--settings`: haiku in `init.model` and
      `permission_denials: ["Read"]`. Merged, not replaced. Runner change: none.
    - e. `--append-system-prompt`: 2.1.301. Works with `-p` and `--agents` (five `orderup-*`
      in `init.agents`) and with `--resume` (same `session_id`): both `result` texts ended
      with the appended instruction's marker word. It was passed again on the resumed run.
      Runner change: none, as long as it is passed on every run, resumes included.
    - f. Budget: 2.1.301, on a subscription. `--max-budget-usd 0.05` on a one-turn run:
      `subtype: "success"`, `is_error: false`, `total_cost_usd` about 0.0064, exit code 0, no
      false budget error. `0.01` on a heavier run: exit code 1, last `result` with
      `subtype: "error_max_budget_usd"`, `is_error: true`,
      `errors: ["Reached maximum budget ($0.01)"]`, `terminal_reason: "budget_exhausted"`
      and no `result` text, after a first `success` result. `total_cost_usd` was 0.0114:
      the cap is checked between turns and a run can overshoot it by one turn. Runner change:
      map `error_max_budget_usd` (or `terminal_reason: "budget_exhausted"`) to the
      `usage_cap_reached` status and `budget.exceeded` instead of `error`, and count on
      overshoot. A minimal haiku turn costs about 0.0064, so the `MIN_BUDGET_USD` floor of
      0.01 leaves room for about one turn: consider refusing the start below a larger floor.
    - g. Flags: 2.1.301. `-p --output-format stream-json` without `--verbose` exits 1 with no
      stdout; the CLI says stream-json requires `--verbose` in print mode. Runner change:
      none, keep `--verbose`.
