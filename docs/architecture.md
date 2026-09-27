# Architecture

## Overview

```
Claude Code ──hooks (HTTP POST)──▶ server ◀──tail── ~/.claude/projects/**/*.jsonl
                                     │ session reducer (pure)
                                     │ crew runner (V1, Claude Agent SDK) ─▶ node:sqlite
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

## Cook kinds (ADR-008)

|             | Observed                          | Crew (V1)                                 |
| ----------- | --------------------------------- | ----------------------------------------- |
| Source      | Any Claude Code session, any repo | Run by the server (Claude Agent SDK)      |
| Identity    | `sessionId`, `agent: null`        | `sessionId` + `agent` (id, role, persona) |
| Control     | Read-only                         | Commands: `crew.message`, `crew.spawn`    |
| Token cost  | Zero                              | Spends the user's tokens                  |
| Persistence | In memory (history later)         | `node:sqlite`                             |

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
idle for 2 h ──▶ forgotten
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

| Condition                           | Effect            | In the kitchen          |
| ----------------------------------- | ----------------- | ----------------------- |
| `done` with no events for 5 min     | `idle`            | Coffee break out back   |
| `working` with no events for 30 min | `idle`            | Terminal closed quietly |
| `idle` with no events for 2 h       | session forgotten | Cook goes home          |

`waiting` never times out: the bell keeps ringing until someone answers.

### Transcripts

The tail watches `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`) recursively. At
startup it reads transcripts modified in the last hour; after that it reads any transcript
that changes, from the beginning the first time.

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
(`--install-hooks`, `--uninstall-hooks`, `--doctor`) or starts the server:

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

`OrderUpDoctor` is not a Claude Code event, so the server accepts it and changes no session.

## Wire protocol

Defined in `packages/shared/src/protocol.ts`.

- On connect the server sends `hello` (protocol version), then `snapshot` (all sessions).
- Then `session.upsert` and `session.remove` as things change.
- The client may send `{ type: 'command', id, command }`. Until V1 every command gets
  `command.result` with `ok: false, error: 'not_implemented'`.

## Security

See [SECURITY.md](../SECURITY.md) and ADR-003. In short: `127.0.0.1` only, `Host`/`Origin`
checks on HTTP and WebSocket, and a per-launch secret before the command channel is enabled.

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

| State     | Where           | Pose                                                                                  | Bubble                       |
| --------- | --------------- | ------------------------------------------------------------------------------------- | ---------------------------- |
| `working` | Own station     | By tool: chop (Edit/Write), stir (Bash), taste (Read/Grep), read (Web), direct (Task) | `Tool · file or command`     |
| `waiting` | The pass        | Rings a bell; the pass bell rings too                                                 | "Chef! Need you at the pass" |
| `done`    | The pass        | Holds up a plate                                                                      | "Order up!"                  |
| `idle`    | Patio, out back | Sips coffee                                                                           | none                         |

- Cooks present when the page loads start at their spot; later ones walk in through the back
  door, and removed sessions walk out through it.
- Commis (subagents) stand beside their chef at 0.68 scale, with their own pose and bubble.
- Each session has a ticket on the rail: name, state and total tokens.
- **Demo.** `?demo` replaces the WebSocket with a scripted feed (`demo/script.ts`): five cooks,
  commis and one crew cook through every state, looping every 15 s. It goes through the same
  reducer as live data.

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
