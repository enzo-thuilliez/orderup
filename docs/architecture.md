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
```

### Hook → state

| Hook event                                     | State / effect                      | In the kitchen                        |
| ---------------------------------------------- | ----------------------------------- | ------------------------------------- |
| `SessionStart`                                 | create session, `idle`              | A cook arrives                        |
| `UserPromptSubmit`                             | `working`                           | New ticket, cook heads to the station |
| `PreToolUse`                                   | `working`, activity = tool + target | Cooking; bubble shows file or command |
| `PostToolUse`                                  | `working`, activity kept briefly    | Keeps cooking                         |
| `PreToolUse` (`Task`/`Agent`), `SubagentStart` | add subagent                        | A commis appears next to the chef     |
| `SubagentStop`                                 | remove subagent                     | The commis leaves                     |
| `Notification`, `PermissionRequest`            | `waiting`                           | The bell rings at the pass            |
| `Stop`                                         | `done`                              | Plate at the pass, "Order up!"        |
| no event for 5 min while `done`                | `idle`                              | Coffee break out back                 |
| `SessionEnd`                                   | remove session                      | Cook leaves by the back door          |

Token usage comes from transcripts only and updates the ticket on the rail.

### Transcript-only fallback (no hooks)

| Last transcript entry                      | Inferred state |
| ------------------------------------------ | -------------- |
| User message or assistant `tool_use`       | `working`      |
| Assistant message with no pending tool use | `done`         |
| No new lines for 5 min                     | `idle`         |

`waiting` is not detectable from transcripts (permission prompts aren't written there).

## Hook events

All hook payloads share `session_id`, `transcript_path`, `cwd`, `hook_event_name` and usually
`permission_mode`. Event-specific fields OrderUp uses:

| Event               | Fields used                                        |
| ------------------- | -------------------------------------------------- |
| `SessionStart`      | `source` (`startup`, `resume`, `clear`, `compact`) |
| `UserPromptSubmit`  | none (`prompt` is dropped, never stored)           |
| `PreToolUse`        | `tool_name`, `tool_input` (file path or command)   |
| `PostToolUse`       | `tool_name`                                        |
| `Notification`      | `message`, notification type when present          |
| `PermissionRequest` | `tool_name`                                        |
| `Stop`              | none                                               |
| `SubagentStart`     | `agent_id`, `agent_type`                           |
| `SubagentStop`      | `agent_id`                                         |
| `SessionEnd`        | `reason`                                           |

Payloads differ across Claude Code versions (checked against 2.1.x). The server treats every
field except `session_id` and `hook_event_name` as optional.

Installed hooks POST the payload to `http://127.0.0.1:<port>/hook` with a short timeout and
always exit 0, so a stopped OrderUp never blocks Claude Code.

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
