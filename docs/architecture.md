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
- Installed hooks use a short timeout and always exit 0, so a stopped OrderUp never blocks
  Claude Code.

## Wire protocol

Defined in `packages/shared/src/protocol.ts`.

- On connect the server sends `hello` (protocol version), then `snapshot` (all sessions).
- Then `session.upsert` and `session.remove` as things change.
- The client may send `{ type: 'command', id, command }`. Until V1 every command gets
  `command.result` with `ok: false, error: 'not_implemented'`.

## Security

See [SECURITY.md](../SECURITY.md) and ADR-003. In short: `127.0.0.1` only, `Host`/`Origin`
checks on HTTP and WebSocket, and a per-launch secret before the command channel is enabled.

## Web controls

| Input | Action                                                           |
| ----- | ---------------------------------------------------------------- |
| Tab   | Toggle orbit overview ↔ first-person walk                        |
| WASD  | Walk (first-person, pointer lock)                                |
| E     | Wave at the nearest cook                                         |
| F     | Open the cook panel: live activity (observed) or chat (crew, V1) |
