# OrderUp

**Your Claude Code sessions, cooking in a cozy 3D kitchen.**

[![CI](https://github.com/enzo-thuilliez/orderup/actions/workflows/ci.yml/badge.svg)](https://github.com/enzo-thuilliez/orderup/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-orange.svg)](LICENSE)

<!-- TODO: demo GIF recorded from ?demo mode -->
<p align="center"><em>Demo GIF coming soon.</em></p>

Every Claude Code session on your machine becomes a cook. Working sessions cook at their
station, sessions waiting for you ring the bell at the pass, finished ones plate up with an
"Order up!", and quiet ones take a coffee break out back. Subagents show up as commis cooks
next to their chef, and token usage runs on the ticket rail.

> **Status:** early (0.1). See [ROADMAP.md](ROADMAP.md).

## Quick start

```sh
npx orderup-cli
```

Or install it globally and run `orderup`:

```sh
npm i -g orderup-cli
orderup
```

That starts a local server, opens the kitchen in your browser, and offers to install Claude
Code hooks (only with your confirmation). Requires Node 22.13+.

Without hooks OrderUp still works from your transcripts, but states lag and the bell for
sessions waiting on you never rings.

## Usage

```text
orderup [options]

  --port <n>          port for the local server (default 7717)
  --no-open           don't open the browser
  --demo              open the kitchen with a scripted demo instead of live sessions
  --install-hooks     add OrderUp hooks to ~/.claude/settings.json (shows the diff first)
  --uninstall-hooks   remove OrderUp hooks from ~/.claude/settings.json
  --doctor            check hooks, their Node, the server and event delivery
  -h, --help          show this help
  -v, --version       print the version
```

- **Browser.** On macOS, Linux and Windows the kitchen opens in your default browser. From
  WSL it opens in your Windows browser.
- **Already running?** A second `orderup` just opens the kitchen that's already up.
- **Custom port.** Hooks remember the port they were installed with. If you use `--port`,
  install hooks with the same one: `orderup --install-hooks --port 8123`.
- **Hooks.** Before writing, OrderUp shows the diff of `~/.claude/settings.json` (or
  `$CLAUDE_CONFIG_DIR/settings.json`) and asks. Your own hooks are kept, the previous file is
  saved as `settings.json.orderup-bak`, and installing twice changes nothing. Each hook is a
  one-line Node command that forwards the event to `127.0.0.1` and always exits 0. It gives
  up within 1.5 s and says nothing when OrderUp isn't running, so Claude Code never waits
  on it. On Claude Code 2.1.119+ hooks run in the background.
- **nvm, fnm, volta…** Hooks run the Node you installed them with, by absolute path, so
  they work even when Claude Code runs them without your shell's PATH. They stay on that
  Node version: after switching versions, run `orderup --install-hooks` again to update
  them.
- **Something off?** `orderup --doctor` checks the hook entries, that their Node still
  exists, that the kitchen is reachable, when the last hook event arrived, and sends a test
  event through the installed hook.

## How it works

1. Claude Code hooks send session events to a server on `127.0.0.1:7717`.
2. The server also tails your local transcripts in `~/.claude/projects` for token usage and sessions started before OrderUp.
3. A three.js page turns each session's state into an animated cook.

More in [docs/architecture.md](docs/architecture.md).

## Privacy

- **Localhost only.** The server binds to `127.0.0.1` and rejects requests from other origins.
- **No LLM calls.** Watching your sessions costs zero tokens.
- **No telemetry.** Nothing leaves your machine.

Details in [SECURITY.md](SECURITY.md).

## Uninstall hooks

```sh
npx orderup-cli --uninstall-hooks
```

This shows the diff, asks, and removes only the hooks OrderUp added to
`~/.claude/settings.json`. The file as it was before each OrderUp change is kept as
`settings.json.orderup-bak`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Code is [MIT](LICENSE). The OrderUp name and logo are not covered by the license; see
[TRADEMARKS.md](TRADEMARKS.md).
