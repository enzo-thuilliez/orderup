# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Monorepo scaffold: `shared`, `server`, `cli` and `web` workspaces building with stub code.
- Wire protocol types for observed and crew cooks, with a reserved command channel.
- Tooling: TypeScript, ESLint, Prettier, Vitest, lint-staged, commitlint, GitHub Actions CI.
- Docs: architecture, decisions log, roadmap, contributing guide, security policy.
- Server: `POST /hook` intake, session reducer and timers, transcript tail with token usage,
  WebSocket `/ws` with snapshot and diffs, Host/Origin checks, static serving of the web app.
