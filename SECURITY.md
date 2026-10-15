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

- **Data written:** `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`), only
  when you confirm a hook install or uninstall, after showing the diff, with a backup
  (`settings.json.orderup-bak`). Nothing else in V0.
- **Hooks:** each installed hook runs your Node (absolute path) with an inline script that
  sends the hook payload to `127.0.0.1:<port>/hook` and exits 0. It makes no other network
  call. `orderup --doctor` runs that same command once with a synthetic event that carries
  no session data.
- **No LLM calls** when watching sessions. **No telemetry.** Nothing leaves your machine.

## Future crew mode (V1)

Crew cooks will call the Anthropic API with your own credentials, only when you start them,
and will store crew state in a local SQLite database. The command channel that controls
them is only open with `orderup --crew`. Each start writes a fresh random token to
`~/.orderup/command-token` (`0600`, removed on shutdown; crew refuses to start if it can't be
written that way) and puts it in a `<meta>` tag of the locally served kitchen page. Every crew
command must pass the Host/Origin checks, carry that token (compared in constant time) and
pass schema validation; commands are also rate-limited per connection (`rate_limited`). The
token is never logged or put in a URL.

On Windows the `0600` check is skipped. Windows has no POSIX permission bits: Node reports a
writable file as `0666` whatever its ACL, so the check would stop `--crew` from ever starting
there. The token file then relies on the default ACL of the user's profile directory, which
only that user (and administrators) can read.

This policy will be updated before crew runs ship.
