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
