# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-27

First release on npm: `npx orderup-cli`.

### Added

- Package: `orderup-cli` ships as one self-contained package (the CLI, server and built
  kitchen bundled together, with `ws` and `jsonc-parser` as its only dependencies), checked
  on Linux, macOS and Windows with Node 22.13 and 24.
- Releases are published from GitHub Actions with npm provenance.

### Fixed

- CLI: installing or removing hooks keeps `settings.json` as it was: key order, indentation,
  one-line arrays and line endings. The diff shows only OrderUp's entries.
- CLI: `npm run dev` no longer offers to install hooks into your real `settings.json`.

### Added

- Monorepo scaffold: `shared`, `server`, `cli` and `web` workspaces building with stub code.
- Wire protocol types for observed and crew cooks, with a reserved command channel.
- Tooling: TypeScript, ESLint, Prettier, Vitest, lint-staged, commitlint, GitHub Actions CI.
- Docs: architecture, decisions log, roadmap, contributing guide, security policy.
- Server: `POST /hook` intake, session reducer and timers, transcript tail with token usage,
  WebSocket `/ws` with snapshot and diffs, Host/Origin checks, static serving of the web app.
- Kitchen (web): procedural low-poly kitchen with stations, the pass and its bell, a ticket rail
  and a patio out back; one cook per session placed and animated by state, commis for
  subagents, speech bubbles with the current file or command, token tickets.
- Kitchen (web): orbit overview and first-person walk (Tab), wave (E), cook panel (F or click)
  with live activity, and a crew chat placeholder.
- Kitchen (web): reconnecting WebSocket client and a `?demo` mode that runs without a server.
- CLI: `orderup` serves the built kitchen on `127.0.0.1:7717` and opens it in the browser,
  including the Windows browser from WSL. Flags: `--port`, `--no-open`, `--demo`,
  `--install-hooks`, `--uninstall-hooks`, `--help`, `--version`. A second `orderup` opens
  the running kitchen instead of failing.
- CLI: Claude Code hook installer. Shows the diff of `settings.json` and asks first, keeps a
  `settings.json.orderup-bak` backup, merges with your hooks, is idempotent, and uninstall
  removes only OrderUp's entries. Offered on start when hooks are missing, never automatic.
- CLI: hooks never slow Claude Code down. A tiny Node forwarder always exits 0, gives up
  after 1.5 s, stays silent when OrderUp is down, and runs in the background on Claude Code
  2.1.119+.
- CLI: hooks run Node by absolute path, so they work without your shell's PATH (nvm, fnm,
  volta). The installer warns when that Node belongs to a version manager, and `orderup`
  warns at start if it's gone.
- CLI: `orderup --doctor` checks hook entries, their Node, the server, recent events, and
  sends a live test event through the installed hook.
- Server: `GET /health` reports `lastHookAt`.
- Dev: `npm run cli:sandbox` runs the CLI with a temporary `HOME`; tests always get one, and a
  guard fails any test that escapes it.
