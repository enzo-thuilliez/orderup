# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/enzo-thuilliez/orderup/security/advisories/new).
Do not open a public issue.

Private reporting becomes available once the repository is public.

<!-- TODO(maintainer): enable it in Settings > Security > Private vulnerability reporting. -->

We aim to acknowledge reports within a week. Only the latest `main` is supported for now.

## What OrderUp does

- **Network:** the server listens on `127.0.0.1` only (default port 7717). It rejects HTTP
  and WebSocket requests whose `Host` or `Origin` headers don't match the local kitchen.
- **Data read:**
  - Claude Code hook payloads sent to the local server.
  - Transcripts under `~/.claude/projects/**/*.jsonl`.

  From these, OrderUp derives session state, tool names, file paths, commands, working
  directories and token counts. Prompt text is ignored: never stored or broadcast.

- **Data written:** `~/.claude/settings.json`, only when you confirm the hook install, with
  a backup (`settings.json.orderup-bak`). Nothing else in V0.
- **No LLM calls** when watching sessions. **No telemetry.** Nothing leaves your machine.

## Future crew mode (V1)

Crew cooks will call the Anthropic API with your own credentials, only when you start them,
and will store crew state in a local SQLite database. The command channel that controls
them will require a per-launch secret in addition to the Host/Origin checks. This policy
will be updated before that ships.
