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
- Kitchen (web): procedural low-poly kitchen with stations, the pass and its bell, a ticket rail
  and a patio out back; one cook per session placed and animated by state, commis for
  subagents, speech bubbles with the current file or command, token tickets.
- Kitchen (web): orbit overview and first-person walk (Tab), wave (E), cook panel (F or click)
  with live activity, and a crew chat placeholder.
- Kitchen (web): reconnecting WebSocket client and a `?demo` mode that runs without a server.
