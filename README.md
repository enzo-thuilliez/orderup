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

> **Status:** early scaffold (V0). Not on npm yet. See [ROADMAP.md](ROADMAP.md).

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

This removes only the hooks OrderUp added to `~/.claude/settings.json`. A backup of your
original file is kept as `settings.json.orderup-bak`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Code is [MIT](LICENSE). The OrderUp name and logo are not covered by the license; see
[TRADEMARKS.md](TRADEMARKS.md).
