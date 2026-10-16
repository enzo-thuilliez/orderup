# Architecture

## Overview

```
Claude Code ──hooks (HTTP POST)──▶ server ◀──tail── ~/.claude/projects/**/*.jsonl
                                     │ session reducer (pure)
                                     │ crew runner (V1, headless `claude -p`) ─▶ node:sqlite
                                     ▼
                         WebSocket snapshot + diffs ◀──▶ web (three.js kitchen)
                                                   commands (reserved)
cli (npx orderup-cli): starts server → opens browser → offers hook install
```

| Package          | Role                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `orderup-shared` | Wire protocol: `SessionView`, `ServerMessage`, `ClientMessage`, constants |
| `orderup-server` | HTTP hook intake, transcript tail, session store and reducer, WebSocket   |
| `orderup-cli`    | Entry point: args, starts server, opens browser, installs/removes hooks   |
| `orderup-web`    | Vite + three.js kitchen, cooks, props, camera, cook panel                 |

## Cook kinds (ADR-008, ADR-015, ADR-016)

|             | Observed                          | Crew (V1)                                           |
| ----------- | --------------------------------- | --------------------------------------------------- |
| Source      | Any Claude Code session, any repo | The user's `claude` CLI, run headless               |
| Identity    | `sessionId`, `agent: null`        | Head chef session or station subagent               |
| Control     | Read-only                         | Commands to the head chef only; cooks are peeked at |
| Token cost  | Zero                              | Spends the user's tokens                            |
| Persistence | In memory (history later)         | `node:sqlite` at `~/.orderup/orderup.db`            |

Every session carries `cwd` and `repo` so the kitchen can group or label cooks by project.

## Session states

```
            UserPromptSubmit / PreToolUse
   ┌────────────────────────────────────────────┐
   ▼                                            │
working ──Notification / PermissionRequest──▶ waiting
   │                                            │
   └──Stop──▶ done ──(quiet 5 min)──▶ idle ─────┘
SessionEnd (any state) ──▶ removed
idle for 10 min ──▶ walks out (removed)
```

### Hook → state

| Hook event                           | State / effect                          | In the kitchen                        |
| ------------------------------------ | --------------------------------------- | ------------------------------------- |
| `SessionStart`                       | create session, `idle`                  | A cook arrives                        |
| `UserPromptSubmit`                   | `working`                               | New ticket, cook heads to the station |
| `PreToolUse`                         | `working`, activity = tool + target     | Cooking; bubble shows file or command |
| `PostToolUse`, `PostToolUseFailure`  | `working`, activity kept until the next | Keeps cooking                         |
| `PreToolUse` for `Task`/`Agent`      | add subagent, keyed by `tool_use_id`    | A commis appears next to the chef     |
| `PostToolUse` for `Task`/`Agent`     | remove that subagent                    | The commis leaves                     |
| `PermissionRequest`, `Notification`  | `waiting`                               | The bell rings at the pass            |
| `Notification` of type `idle_prompt` | ignored (the turn is already `done`)    |                                       |
| `Stop`                               | `done`, subagents cleared               | Plate at the pass, "Order up!"        |
| `SessionEnd`                         | remove session                          | Cook leaves by the back door          |

Subagent tool calls report the parent's `session_id`, so they show as the chef's activity.
Background subagents return from `Task` immediately, so their commis leaves early (V0 limit).

### Timers (store)

| Condition                           | Effect          | In the kitchen          |
| ----------------------------------- | --------------- | ----------------------- |
| `done` with no events for 5 min     | `idle`          | Coffee break out back   |
| `working` with no events for 30 min | `idle`          | Terminal closed quietly |
| `idle` with no events for 10 min    | session removed | Cook walks out          |

`waiting` never times out: the bell keeps ringing until someone answers. A cook who walked out
comes back with the next event for their session.

Each timer fires at the time it fell due (`updatedAt` + delay), not at the tick that notices
it, and every overdue timer runs at once. So a session whose last transcript line is old
enough expires before it is stored, and is never broadcast.

Sessions whose `cwd` is under `os.tmpdir()` (symlinks resolved) are ignored: throwaway repos
never get a cook. If such a cwd only shows up on a later event, the cook is removed then.

### Transcripts

The tail watches `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`) recursively. At
startup it reads transcripts modified in the last hour; after that it reads any transcript
that changes, from the beginning the first time. Each read up to the file's current end goes
to the store as one batch, which broadcasts only the net change per session: a replayed
transcript never flashes its intermediate states.

- **Tokens:** every assistant line's `message.usage`, deduplicated by `message.id` (one
  message is written over several lines), summed per `sessionId`. Sidechain (subagent) lines
  count towards their session's ticket.
- **State**, only for sessions that never sent a hook (ADR-001):

| Transcript line                                   | Event                    |
| ------------------------------------------------- | ------------------------ |
| User message (not meta, not a slash-command echo) | `prompt` → `working`     |
| Assistant `tool_use`                              | `tool.start` → `working` |
| User `tool_result`                                | `tool.end`               |
| Assistant with `stop_reason: end_turn`, no tool   | `stop` → `done`          |

`waiting` is not detectable from transcripts (permission prompts aren't written there).

## Hook events

All hook payloads share `session_id`, `transcript_path`, `cwd`, `hook_event_name` and usually
`permission_mode`. Event-specific fields OrderUp uses:

| Event                               | Fields used                              |
| ----------------------------------- | ---------------------------------------- |
| `SessionStart`                      | none beyond the common ones              |
| `UserPromptSubmit`                  | none (`prompt` is never read)            |
| `PreToolUse`                        | `tool_name`, `tool_input`, `tool_use_id` |
| `PostToolUse`, `PostToolUseFailure` | `tool_name`, `tool_use_id`               |
| `PermissionRequest`                 | none beyond the common ones              |
| `Notification`                      | `notification_type`, `message`           |
| `Stop`, `SessionEnd`                | none beyond the common ones              |

Other events (`SubagentStart`, `SubagentStop`, `PreCompact`, …) are accepted and ignored.
Payloads differ across Claude Code versions (checked against 2.1.x): every field except
`session_id` and `hook_event_name` is optional.

The bubble target comes from `tool_input`: `file_path` / `notebook_path` / `path` (relative
to `cwd` when inside it), else the first line of `command`, `pattern`, `url`, `query` or
`description`, truncated to 80 characters.

### `POST /hook`

- Body: the hook payload as JSON, `content-type: application/json` required (415 otherwise),
  8 MiB max (413).
- Response: `204 No Content`, even if OrderUp ignores the event.
- Any well-formed JSON payload, even an ignored event, sets `lastHookAt`.

### `GET /health`

`HealthResponse` in `orderup-shared`: `{ "ok": true, "protocol": 1, "lastHookAt": <epoch ms> | null }`.
The CLI uses it to detect a running OrderUp and for `--doctor`. Only a timestamp: no
session data.

- Installed hooks forward the payload here and always exit 0 (see [CLI](#cli)).

## CLI

`orderup` (`packages/cli`) parses flags, then either acts on hooks and exits
(`--install-hooks`, `--uninstall-hooks`, `--doctor`), runs an `orderup crew` command (see
[Brigade config](#brigade-config-orderup-crew)) or starts the server. `--crew` is stored in
the server options (`ServerOptions.crew`): with it the server runs the crew runner (see
[Crew runner](#crew-runner)), and without it the
server is the observer only:

1. Starts the server on `127.0.0.1:<port>` (default 7717), serving the built kitchen:
   `dist/web/` next to the bundled CLI in the npm package, or `packages/web/dist` in the monorepo. If the port
   is taken by OrderUp (`GET /health`), it opens that kitchen and exits. If something else
   holds the port, it fails without trying another port (ADR-002).
2. Opens `/` (or `/?demo` with `--demo`) unless `--no-open`: `open` on macOS, `xdg-open` on
   Linux, `rundll32 url.dll,FileProtocolHandler` on Windows and from WSL (the Windows browser
   reaches the WSL server through localhost forwarding).
3. Outside `--demo`, checks `settings.json`. With no OrderUp hooks it offers to install them
   in an interactive terminal, otherwise it prints the command. Hooks whose Node binary is
   gone, hooks for another port, or an incomplete set get a hint to reinstall.

### Hook install (ADR-006, ADR-011)

- File: `$CLAUDE_CONFIG_DIR/settings.json`, default `~/.claude/settings.json`. A symlink is
  followed, and the file is written atomically with its mode kept.
- The file is edited as text (ADR-012): only OrderUp's entries change. Keys keep their
  order, and the file keeps its indentation, one-line arrays and line endings. An existing
  OrderUp group is replaced where it is; new groups go after the user's, and new keys
  (`hooks`, an event) go last. Every edit is checked against the object model before
  writing, and a mismatch aborts without touching the file.
- Every change shows a diff and asks (y/N) in a terminal. Without a terminal, the
  explicit flag is the confirmation. The file as it was before goes to
  `settings.json.orderup-bak`. Invalid JSON, or a `hooks` value of the wrong shape, is
  never overwritten.
- One group `{ "hooks": [ourHook] }` is appended per event in the
  [hook table](#hook--state). User groups are never edited, except to take out an
  OrderUp hook someone moved into them.
- `ourHook` runs the installer's own Node by absolute path (`process.execPath`), never a
  bare `node` from PATH. Its shape depends on `claude --version`:

  | Claude Code       | `ourHook`                                                                                       |
  | ----------------- | ----------------------------------------------------------------------------------------------- |
  | 2.1.139+          | `{ "type": "command", "command": "<node>", "args": ["-e", "/*orderup-hook*/…"], "timeout": 5 }` |
  | older, or unknown | `{ "type": "command", "command": "'<node>' -e '/*orderup-hook*/…'", "timeout": 5 }`             |

  `"async": true` is added (except for `SessionEnd`) on 2.1.119+. The `/*orderup-hook*/`
  marker identifies our entries: install first removes them (so it's idempotent and picks
  up a new port or Node), and uninstall removes only them. If the Node path is inside a
  version manager's directory (nvm, fnm, volta, asdf, mise, nodenv, n), the installer
  warns that hooks stay on that version until reinstalled.

- The inline forwarder reads stdin, POSTs it to `127.0.0.1:<port>/hook` with a 1 s socket
  timeout, and exits 0 with no output on every path. A 1.5 s timer bounds the whole run. It
  contains no quote characters, so it fits in one pair of single quotes.

### `orderup --doctor`

A plain-text report, one line per check, with level `ok`, `warn` or `FAIL`. Exit code 1 if
any check fails.

| Check      | What                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `claude`   | `claude --version` found                                                                              |
| `hooks`    | OrderUp entries for every event, a single port, the form this Claude Code would get                   |
| `node`     | each Node path in the entries exists and is executable (a bare `node` is a warning)                   |
| `server`   | `GET /health` answers on the hooks' port                                                              |
| `events`   | `lastHookAt` from `/health`: when the last hook payload arrived                                       |
| `delivery` | runs the installed `PreToolUse` command with an `OrderUpDoctor` event, then checks `lastHookAt` moved |
| `crew`     | `claude` on PATH, version 2.1.217+, logged in, fallback station files up to date (below)              |

`OrderUpDoctor` is not a Claude Code event, so the server accepts it and changes no session.

The `crew` lines fail the report only when crew is set up (`orderup --doctor --crew`, or a
repo set with `orderup crew set --repo`); otherwise they are warnings, so an observer-only
setup still passes.

- Version: below 2.1.217, the first release with `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`
  (ADR-016 Follow-ups), the check fails with `Fix: claude update`.
- Login: `claude auth status`, the documented non-interactive check (exit 0 logged in, 1
  not). Only its `authMethod` field is read. Any other outcome, or a CLI too old to ask,
  reports "unknown" rather than guessing. It is never run below 2.1.217.
- Station files: in the configured repo, else the current directory's git repo. Checked only
  when an `orderup-<station>.md` file exists; a stale or missing one is a warning.
- The database is read only if `~/.orderup/orderup.db` already exists: the doctor creates none.

## Wire protocol

Defined in `packages/shared/src/protocol.ts`.

- On connect the server sends `hello` (protocol version), then `snapshot` (all sessions).
- Then `session.upsert` and `session.remove` as things change.
- The client may send `{ type: 'command', id, command }` (the reserved V0 command). It
  always gets `command.result` with `ok: false, error: 'not_implemented'`.
- Crew commands (below) are top-level messages whose `type` is a crew command type. The
  server answers each one with an `ack` or an `error` (`CrewCommandReply`). Crew events are
  not sent yet. Both stay in their own unions (`CrewCommand`, `CrewServerMessage`).

### Command channel (ADR-015, #20)

`packages/server/src/crew/`: `channel.ts` (per-connection checks), `token.ts`,
`controller.ts`.

- **Off by default.** Without `--crew` every crew command gets `crew_disabled` and nothing
  else changes: no token, no file, no `<meta>`.
- **Token.** With `--crew`, each start generates 32 random bytes (hex) and writes them to
  `~/.orderup/command-token`: created as a temporary file with mode `0600`, checked, then
  renamed over the old one (in a `0700` `~/.orderup`). If that fails, `startServer` throws and
  crew does not start. The file is removed on shutdown if it still holds this start's token.
  The token is written after `listen`, so an OrderUp that loses the port never replaces the
  running one's token. It is never logged and never put in a URL.
- **Page.** The server adds `<meta name="orderup-command-token" content="…">`
  (`COMMAND_TOKEN_META`) to `index.html` when it serves it, with `cache-control: no-store`.
  Under `npm run dev` a Vite plugin reads the token file and adds the same tag. The web
  `Connection.sendCrew` attaches it to every crew command.
- **Checks, in order.** The WebSocket upgrade already passed Host/Origin (ADR-003). Then per
  command: crew enabled (`crew_disabled`), rate limit of 10 commands per second per
  connection (`rate_limited`), token by `timingSafeEqual` on SHA-256 digests
  (`unauthorized`, checked before the shape so an unauthenticated client learns nothing),
  then `parseCrewCommand` (`chef_only`, `invalid_command`). Only then is the command
  executed. On Windows the token file's `0600` check is skipped (no POSIX modes there; see
  SECURITY.md).
- **Controller.** Valid commands go to a `CrewController` (`talk`, `assign`, `stop`,
  `approve`, `sendBack`) without their token, and its typed `ack` or `error` is sent back.
  With `--crew` that is a `RunnerCrewController` over the crew runner (see
  [Crew controller](#crew-controller)), unless `startServer` is given a `crewController`.

### Crew messages (V1, ADR-016)

The command channel above handles crew commands; crew events are types only for now.

- **Stations** (`STATIONS`): `head-chef | hot | garde-manger | commis | pastry | dish`. These
  ids are the wire values and never change. Crew sessions carry `station` (`head-chef`) and
  their subagents carry `station` (a work station, or `null` for a non-OrderUp subagent).
  Both also carry `crewState`: `idle | working | talking-to-chef | needs-you | done | error`.
  Observed sessions have neither.
- **Commands** (client → server), each with `requestId`, `token` and `to: 'head-chef'`:
  `talk { text }`, `assign { ticket }`, `stop`, `approve { cardId }`,
  `send-back { cardId, comment }`. No command can address a cook: `to` only admits
  `head-chef`, and `parseCrewCommand` rejects any other station with `chef_only` and any
  other malformed command, including unknown fields, with `invalid_command`.
- **Replies**: `ack` names the command it answers and carries what it started (`runId`,
  `cardId`). `error` carries a `CrewErrorCode`: `unauthorized`, `chef_only`, `unknown_card`,
  `invalid_card_status`, `busy`, `rate_limited`, `usage_cap_reached`, `crew_disabled`,
  `invalid_command`.
- **Report cards** (`ReportCard`): `id`, `taskId`, `ticket`, `status`
  (`cooking | ready | read | approved | sent-back`), `runStatus` (how the last run ended,
  `null` while the first one cooks) and timestamps. A card holds the chef's report block
  (`ReportBlock`, schema 1: `taskId`, `ticket`, `stations`, `summary`, `prUrl`,
  `filesChanged`, `unmerged`), or `malformed: true` with the chef's `rawText`.
- **Events** (server → client, broadcast): `crew.run.started { runId, sessionId, trigger,
taskId }`, `crew.message.delta`, `crew.run.ended { status, usage }`,
  `crew.budget.exceeded { runId, capUsd, spentUsd }`, `crew.card.created` and
  `crew.card.updated { card }`, `crew.peek { peek }`, and
  `crew.tickets { tickets, status, message, updatedAt }` (see Tickets below).
- **Peek** (`CookPeek`): station, crew state, current tool and target, files touched, the
  last few assistant messages and, for a station, the `description` of the dispatching
  `Agent` call. It is built in memory from hooks and transcripts. No type carries prompt
  text: not the user's prompts, and not the `prompt` input of `Agent` calls.

## Security

See [SECURITY.md](../SECURITY.md) and ADR-003. In short: `127.0.0.1` only, `Host`/`Origin`
checks on HTTP and WebSocket, and a per-start token on every crew command (see Command
channel above).

## Crew (V1)

Runtime, auth, billing, guardrails and the command channel threat model are decided in
[ADR-015](../DECISIONS.md#adr-015-crew-runtime-auth-and-guardrails): crew runs as the user's
own `claude` CLI spawned headless (`claude -p`, stream-json, `--resume`), OrderUp never
touches credentials, crew is off unless started with `--crew`, and every run has a daily
usage cap in API-equivalent USD and a cost shown per run.

The brigade is decided in [ADR-016](../DECISIONS.md#adr-016-head-chef-and-brigade-model):

- The runner launches one head chef session. The user talks only to the chef (`talk`,
  `assign`, `stop`, card `approve` / `send-back`); no command prompts a cook.
- Stations are fixed: `hot` (backend), `garde-manger` (frontend), `commis` (read-only
  research), `pastry` (tests), `dish` (refactor). Each is a Claude Code subagent named
  `orderup-<id>` (passed with `--agents`, or as files in `.claude/agents/` as a fallback),
  identified in hooks by `agent_type`.
- Writing stations run in their own git worktrees (`isolation: worktree`); the chef merges
  their branches into the task branch and hands merge conflicts it cannot fix to the user.
- Caps: 4 per station (soft, in the chef's prompt) and 8 in total
  (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`); ADR-015's usage cap stays the hard limit.
- The chef ends each task with one fenced JSON report block; the runner turns it into a card
  on the whiteboard (`cooking | ready | read | approved | sent-back`).
- Clicking a cook opens a read-only peek built from hooks and transcripts, with no LLM call.
- A theme only changes visuals, never station ids, prompts or tools.

### Kitchen per repo, HUD and cook terminal (ADR-017)

Decided in
[ADR-017](../DECISIONS.md#adr-017-kitchen-per-repo-hud-and-live-cook-terminal), not built
yet:

- On arrival the user picks a repo, from session `cwd`s under `~/.claude/projects` and
  `brigade_config.repo_path` (no clone, no network). Its kitchen shows the observed sessions
  in that repo or its worktrees (`~/.orderup/worktrees/<repo>/…` included) plus its crew.
- A HUD shows the repo, the cooks with state, cost and tokens, today's and all-time spend and
  the plan limits (5-hour session, week): with `--crew` through the `get_usage` control
  request of the user's own `claude` CLI (#50), which starts no conversation; without it from
  local data only, else unknown.
- Clicking a cook opens a panel with a live terminal (text, tool calls, results, edit diffs)
  and a Changes tab (`git diff`). Only the head chef's panel has a talk input. Panel data is
  sent to the requesting client only and never stored.
- Prompt text may appear in the terminal only over the token-authenticated crew channel,
  from memory. Without `--crew` it never does.
- The walls hold three boards: Issues, Pull requests and head chef reports.

### Tickets

`packages/server/src/sources/tickets.ts` (`TicketSource`) turns open GitHub issues into order
tickets. It takes the brigade's repos as `owner/name` (one brigade per working repo, ADR-016)
and, for each, runs `gh issue list --repo <owner/name> --state open --json
number,title,labels,url,updatedAt --limit 100` with `execFile` (no shell, args as an array,
15 s timeout). A repo that does not match `owner/name` or starts with `-` is never passed to
gh: it is skipped and reported as an `error` status naming it.
It polls at start and then 60 s (configurable) after the previous poll ends, so polls never
overlap; `stop()` clears the timer. Each repo's issues are kept in memory, most recently
updated first.

- Failures never throw. Each repo keeps its last good list and the source reports a
  `TicketSourceStatus`: `gh-missing` (`ENOENT`), `unauthenticated` (exit 4 or a "gh auth login"
  hint), or `error` (network, timeout, non-zero exit, invalid JSON), with a short fixed message
  that never echoes gh's output or environment. Back to `ok` after a clean poll.
- It logs one line per status change, not per poll.
- Its state is the `crew.tickets` message. It is not started yet: the crew runner (#19) and
  crew config (#21) wire it behind `--crew`, and the ticket rail (#25) shows it. The observer
  path never runs `gh`.

### Station definitions

`packages/server/src/crew/stations.ts` holds the five stations as data (`STATION_DEFINITIONS`):
subagent name `orderup-<id>`, description, tools from ADR-016 point 2, `isolation: worktree`
for `hot`, `garde-manger`, `pastry` and `dish`, and a short station prompt. Writing stations
are told to commit on their worktree branch and end with a `Branch: <branch>` line; `pastry`
edits tests and fixtures only; no station pushes. No station gets `Agent`.

- `agentsJson()` builds the value of the claude CLI's `--agents` flag (inline JSON, keyed by
  subagent name, with `description`, `prompt`, `tools` and `isolation`). This is the default
  runtime path: the runner (#19) passes it to the head chef and nothing is written into the
  user's repo.
- `stationsHash()` is the SHA-256 of that JSON. It is stored in `brigade_config` when the CLI
  writes the config and written into fallback files, so stale definitions can be detected.
- `renderAgentFile()` renders a definition as a `.claude/agents/orderup-<id>.md` file (YAML
  frontmatter with an OrderUp marker comment and the hash, then the prompt) for the fallback.

### Crew runner

`packages/server/src/crew/runner.ts` (`CrewRunner`) runs the head chef (#19). Started only
with `--crew`: `startServer` then opens the database and a runner, and `close()` awaits
`stopAll()`. The command channel starts and stops runs through the
[crew controller](#crew-controller).

- **API.** `startRun({ trigger, taskId, prompt, resumeSessionId? })` resolves `{ ok, runId }`
  or a refusal: `busy` (already 3 chef processes, ADR-015, or this task already has one),
  `usage_cap_reached` (less than `MIN_BUDGET_USD` = $0.10 of the daily cap left), `no_repo`, `invalid` (task id not `[A-Za-z0-9_-]+`, a session id or
  model that could read as a flag) or `setup_failed`. `stop(runId)` and `stopAll()` resolve
  once the processes are gone. Progress goes to `onEvent`: `run.started { cwd, repo }`,
  `run.session`, `run.text` (the chef's own text), `run.tool` (with `target`, and
  `subagentType` and `description` for `Agent` calls, never their `prompt`), `run.subagent`
  (an `agentId`, its station and its `Agent` call, once), `run.subagent.ended { status }`,
  `run.permission-denied`, `run.branch { agentId, branch }`, `run.usage` (after each
  `result`), `run.ended { status, usage, resultText }` and `budget.exceeded`. `startRun` also
  takes the task's `ticket`, shown in the chef's report example (`null` for a `talk`).
- **Process.** The user's `claude` (path injectable), spawned without a shell in its own
  process group, in the task's chef worktree:
  `-p --output-format stream-json --verbose --max-turns 30 --agents <agentsJson()>
--settings <chefSettingsJson()>`, plus `--model` when `brigade_config` has one,
  `--resume <id>` when given and `--max-budget-usd <daily_cap_usd minus today's usage>`
  (whole cents, rounded down) when the daily cap is on; with a cap of 0 the
  flag is omitted, then `--append-system-prompt <buildChefSystemPrompt()>`: the head chef's
  instructions (`crew/chef-prompt.ts`): dispatch only to the `--agents` stations and never
  write code except merges, the station and global caps from `brigade_config`, merge the
  station branches into the task branch and retry a conflict once before listing it in
  `unmerged`, never push to the protected branch, and end with exactly one schema 1 report
  block with this run's task id. It is the server's own text; the user's goes on stdin. Never `--bare`, never a permission-bypass flag. The prompt goes on stdin, so it is
  neither parsed as a flag nor visible in the process list. stderr is dropped.
- **Environment.** `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` = `brigade_config.global_cap`,
  `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`, and the push guard: `GIT_CONFIG_COUNT=1`,
  `GIT_CONFIG_KEY_0=core.hooksPath`, `GIT_CONFIG_VALUE_0=~/.orderup/git-hooks` and
  `ORDERUP_PROTECTED_BRANCH=<default branch>`. Inherited `GIT_CONFIG_KEY_n` / `VALUE_n` and
  `GIT_CONFIG_PARAMETERS` are dropped.
- **Push guard.** The runner writes `~/.orderup/git-hooks/pre-push`, which refuses any push
  or deletion of `ORDERUP_PROTECTED_BRANCH` or of the remote's HEAD branch (`main` and
  `master` when neither is known). Only the chef process (and the stations, which inherit its
  environment) has that `core.hooksPath`; the user's own pushes never run it, and nothing is
  written into the repo's `.git/hooks`. While it is set, the repo's own hooks do not run for
  the chef.
- **Chef worktree.** One per task, at `~/.orderup/worktrees/<repo-basename>/<taskId>`, on a
  new branch `orderup/<taskId>` from the repo's default branch (`origin/HEAD`, else `main` or
  `master`). A later run of the task (`send-back`) reuses it, only if it belongs to the same
  repo. `removeChefWorktree()` removes the worktree and the branch once the card is approved or
  sent back (callers: #31). The user's checkout is never switched or written to.
- **Station permissions** (ADR-016 point 10, amended). Stations run in the background and
  cannot answer a prompt. Writing stations get `permissionMode: acceptEdits` in `--agents`;
  `--settings` is `{"worktree":{"baseRef":"head"},"permissions":{"allow":STATION_ALLOW_RULES}}`:
  `git add|commit|status|diff`, `npm test`, `npm run test|lint|typecheck` and
  `npx vitest|tsc|eslint`. Nothing allows `git push`, so stations are denied it; the CLI
  merges this layer with the user's settings (probe case d).
- **Stream.** `crew/stream.ts` (`parseStreamLine`) maps stream-json lines to typed events:
  `system/init` (session id), assistant `text` and `tool_use` blocks (`Agent` / `Task` with
  `subagent_type`; a `target` like hooks show it), `tool_result` (with
  `tool_use_result.agentId`, `status` and `worktreeBranch` when present), `system/task_started`
  and `system/task_notification` (ids, `subagent_type` and status only: never their `prompt`
  or `summary`), `system/permission_denied`, `system/vcs_state_changed`, `stream_event` text
  deltas and `result` (`total_cost_usd`, `modelUsage`, `usage`, `terminal_reason`).
  Malformed or unknown lines give no event and never end a run.
- **A result is not the end.** A background station's `Agent` result comes back at once
  (`async_launched`), the chef's turn ends with a first `result`, and the station's
  `task_notification` starts a second turn in the same process. The run ends at process exit,
  and the last `result` decides its status. A station ends at its `task_notification`, or at
  a `completed` `Agent` result when it ran in the foreground.
- **Station branches.** A writing station works in `.claude/worktrees/agent-<agentId>` on
  `worktree-agent-<agentId>`. `run.branch` reports it from the `Agent` result's
  `worktreeBranch` or from a `vcs_state_changed` commit (`agentIdOfWorktree` reads the
  `agentId` back from its `cwd` or branch).
- **Usage and budget.** Each `result` line adds a `usage` row for the run. `total_cost_usd`
  and `modelUsage` are cumulative for the process (stations included) and, for a resumed
  session, the conversation, so what that chef session already recorded is subtracted: cost
  and tokens (`modelUsage` summed over models) are recorded as deltas. Without `modelUsage`,
  the turn's `usage` (chef only) is added. A start is refused when less than $0.10 of
  `daily_cap_usd` is left (0 = no cap). A run whose result takes the day over the cap is
  killed, and one the CLI ends on `--max-budget-usd` (`error_max_budget_usd` or
  `terminal_reason: budget_exhausted`) exits by itself; both are reported with
  `budget.exceeded` and end as `usage_cap_reached`, stored as `stopped` in `runs`.
- **Status.** `success` (exit 0 with a non-error result), `stopped`, `usage_cap_reached`,
  else `error` (non-zero exit, no result, binary missing).
- **Shutdown.** A stop sends SIGTERM to the chef's process group, then SIGKILL after 3 s;
  when the chef exits, anything left in its group is killed. `stopAll()` runs on server close,
  and a synchronous `exit` handler kills the groups if the server dies without it. On Windows
  only the chef process itself is signalled.
- **Ownership.** The chef's session id and each subagent `agentId` go to `owned_sessions`.
- **Crew cooks.** `CrewCooks` (`crew/cooks.ts`) turns runner events into store events (source
  `crew`): the chef's session becomes a crew cook (`kind: crew`, `station: head-chef`, its
  worktree as `cwd`, the working repo's name as `repo`), each `Agent` call a subagent with its
  `station` (`null` for a non-OrderUp subagent), tool calls inside a station its activity, a
  station's end `done` (or `error`), `run.usage` its tokens and `run.ended` `done` (`error`
  for `error` and `usage_cap_reached`). `crewState` follows the cook state (`waiting` is
  `needs-you`). Once claimed, the store drops hook and transcript events for that session:
  the user's hooks fire inside the chef too, and its stations' hooks carry its session id.
  While its run is active (claim to `run.ended`) no store timer applies to it, so a chef
  waiting on a quiet background station never goes stale or walks out after 10 minutes; the
  usual timers resume once the run ends. The temp-dir filter does not apply to crew sessions.

### Crew controller

`RunnerCrewController` (`crew/controller.ts`) turns authorized commands into runner calls
(#20, ADR-016 point 6). Every command is for the head chef.

- **`talk`.** A new task id (`t_` + 26 Crockford base32 characters, ULID-style: time first,
  then random). The text goes to the chef on stdin unchanged. It resumes the chef session of
  the latest `talk` run that has one (`Repository.latestRunWithSession('talk')`). One `talk`
  at a time: while a `talk` run is active, or another `talk` is still starting, it answers
  `busy` ("the head chef is still answering") and starts nothing, so two processes never
  write the chef conversation. Active `assign` runs do not block it. Acks `runId`.
- **`assign`.** A new task id and a new session. The stdin prompt names the ticket
  (`owner/name#number`) and tells the chef to read it with `gh issue view`; the server does not
  fetch the issue. Acks `runId` and `cardId` = the task id (one card per task, #31).
- **`stop`.** Stops the most recently started active run (including one still setting up its
  worktree) and acks once its process is gone, with its `runId`, or `null` when nothing runs.
- **`approve`, `send-back`.** `unknown_card` until report cards are stored (#31).
- **Refusals.** The runner's `busy` and `usage_cap_reached` keep their code; `no_repo`,
  `invalid` and `setup_failed` become `invalid_command`. The message is the runner's.

### Brigade config (`orderup crew`)

| Command                                                                                         | What                                                                                        |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `orderup crew status`                                                                           | config, stations, caps, daily budget and what was used today                                |
| `orderup crew set --repo <path>`                                                                | working repo of the head chef: must be a git repo, stored as its top                        |
| `orderup crew set --model <name>`                                                               | chef model (alias or full name); `default` goes back to the CLI's                           |
| `orderup crew set --station-cap <n>` / `--global-cap <n>`                                       | positive integers (defaults 4 and 8)                                                        |
| `orderup crew set --budget <usd>`                                                               | daily usage cap, API-equivalent USD, `>= 0` (default 5; 0 disables the cap: no daily limit) |
| `orderup crew install-agents [--repo <path>]` / `orderup crew uninstall-agents [--repo <path>]` | fallback station files (below)                                                              |

`set` takes several flags at once and validates all of them before writing anything. The
config goes to `brigade_config` in the database.

`install-agents` and `uninstall-agents` are the opt-in fallback of ADR-016 point 1. They act
on `--repo`, else the configured repo, else the current directory (a git repo either way),
and follow the hook installer's UX (ADR-006): a diff per file, then one y/N question in a
terminal (without one, the explicit command is the confirmation). Only the five
`.claude/agents/orderup-<station>.md` files are read, written or removed; other files,
including other `orderup-*` names, are never touched, and a symlink or non-file in their
place is refused. When every file already matches, nothing is asked or written.

### Persistence

Crew state lives in `~/.orderup/orderup.db` (follows `$HOME`), opened with `node:sqlite`
by `packages/server/src/persistence`. The observer path never touches it; `orderup crew`
opens it for the brigade config, and the server opens it with `--crew` for the crew runner.

- Migrations are an append-only list. `schema_version` records each applied version; pending
  ones run in order, each in its own transaction, so re-running is a no-op and a failure
  leaves the previous version intact. A database newer than the running OrderUp is refused.
- `node:sqlite` is loaded lazily, and only its own `ExperimentalWarning` is dropped while it
  loads (Node 22 prints it); every other warning is left alone (ADR-008).
- Tables so far (ADR-016 point 9):

| Table                          | Columns                                                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs`                         | `id`, `chef_session_id`, `task_id`, `trigger` (`talk` / `assign` / `send-back`), `started_at`, `ended_at`, `status` (`running` / `success` / `error` / `stopped`)                                                       |
| `usage`                        | `run_id`, input / output / cache read / cache write tokens, `cost_usd` (API-equivalent), `day` (local `YYYY-MM-DD`), `recorded_at`                                                                                      |
| `brigade_config` (migration 2) | one row: `repo_path`, `chef_model` (both NULL until set), `station_cap` (4), `global_cap` (8), `daily_cap_usd` (5; 0 = no daily cap), `stations_hash`, `updated_at`; caps `> 0` and budget `>= 0` are CHECK constraints |
| `owned_sessions` (migration 3) | `kind` (`chef` / `subagent`), `id` (session id or `agentId`), `run_id`, `agent_type`, `recorded_at`; one row per `(kind, id)`                                                                                           |

`Repository.usageTotalForDay(day)` sums `usage` for one local day: the figure the daily
budget cap is checked against. `getBrigadeConfig()` and `updateBrigadeConfig(patch)` read
and change `brigade_config` (only the fields given). `chef_messages`, `report_cards`,
`card_events` arrive as new migrations with #23 and #31. `addOwnedSession`, `getOwnedSession`
and `ownedSessions` read and write `owned_sessions`; `usageTotalForSession` sums a chef
session's usage across its runs.

## Kitchen (web)

`packages/web` renders the sessions it receives; it keeps no state of its own beyond them.

- **Data.** `net/store.ts` is a pure reducer over `ServerMessage`s (`snapshot` replaces all
  sessions, then `session.upsert` / `session.remove`). `net/connection.ts` opens `/ws` on the
  page's own origin and reconnects with backoff (0.5 s doubling to 10 s). Malformed frames are
  dropped. A `hello` with another `PROTOCOL_VERSION` stops the kitchen with a notice.
- **Placement.** Each session gets a stable slot (lowest free, kept while it lives). The slot
  picks its station (five islands facing the pass, then five on the back counter), its spot at
  the pass and its spot at the patio coffee table. Past ten cooks, slots wrap with a small offset.
  Cooks walk between spots through the island gaps and the back door (`logic/layout.ts`).

| State     | Where           | Animation                                                                                                 | Bubble                               |
| --------- | --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `working` | Own station     | By tool: chop (Edit/Write), stir (Bash), taste (Read/Grep), read (Web), direct (Task). Steam when cooking | `Tool · file or command`             |
| `waiting` | The pass        | Rings the bell and bounces with each ring; the pass bell rings too                                        | "!" and "Chef! Need you at the pass" |
| `done`    | The pass        | Carries the plate there, hops and holds it up                                                             | "Order up!" pops on arrival          |
| `idle`    | Patio, out back | Sips coffee, now and then stretches or looks around; rhythm and order differ per cook                     | none                                 |

- Cooks present when the page loads start at their spot; later ones walk in through the back
  door, and removed sessions walk out through it. Between states cooks walk, and limb poses
  blend over about a quarter second.
- The state → animation mapping and its transitions are pure (`logic/anim.ts`): `planFor` picks
  the motion, prop, steam, "!" and hop; `stepTrack` stamps arrival at a spot and fires the
  one-shot cues ("Order up!", first ring).
- Commis (subagents) pop in beside their chef at 0.68 scale, work with their own pose and
  bubble, help or mirror the chef otherwise, and wave before shrinking away.
- `prefers-reduced-motion`: cooks and commis appear at their spot without walking or popping,
  poses hold still, no hops, steam or CSS bubble animations; stove flames and the bell stop.
- Figures bake each rigid part into one vertex-coloured mesh (7 meshes per cook instead of ~23) and all
  steam is one instanced mesh.
- Each session has a ticket on the rail: name, state and total tokens.
- **Demo.** `?demo` replaces the WebSocket with a scripted feed (`demo/script.ts`): five cooks,
  commis and one crew cook through every state, looping every 15 s. It goes through the same
  reducer as live data. `?demo=N` (up to 40) adds time-shifted copies for load testing, and
  `?fps` shows frame rate, CPU time per frame and in cook animation, and draw calls.
  Nothing in the scene is random (ticket sway is seeded by session id), so a given time
  renders the same frame every run. `npm run demo:record` (`scripts/record-demo.mjs`)
  relies on that to record `docs/assets/demo.gif`: headless Chromium on Playwright's paused
  fake clock, one warm-up loop, then one loop captured frame by frame (ADR-014).

## Web controls

| Input         | Action                                                                               |
| ------------- | ------------------------------------------------------------------------------------ |
| Tab           | Toggle orbit overview ↔ first-person walk                                            |
| Drag / scroll | Orbit / zoom (overview)                                                              |
| Click a cook  | Open its panel (overview)                                                            |
| WASD, Shift   | Walk, run (first-person; click to capture the mouse)                                 |
| Arrow keys    | Walk and turn without the mouse                                                      |
| E             | Wave at the cook in front of you; it waves back                                      |
| F             | Open / close the cook panel: live activity (observed) or chat (crew, V1 placeholder) |
| Esc           | Close the panel, release the mouse                                                   |
