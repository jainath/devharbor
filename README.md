# DevHarbor

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon%20%2B%20Intel)-black.svg)](#install)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**A harbor for your local dev servers.** macOS-first desktop app for managing local Node.js projects. Register your apps once, then start/stop/restart them, switch Node versions per project, edit env vars, watch logs, organize them into folders, and see what's running — all without leaving one window.

Think of it like a "Postman for your local dev servers." Everything stays local — no accounts, no cloud, no telemetry.

Website: [www.devharbor.app](https://www.devharbor.app)

## Install

macOS (Apple Silicon or Intel). From [**Releases**](https://github.com/jainath/devharbor/releases),
download `devharbor-<version>-arm64.dmg` for Apple Silicon (M-series) or `…-x64.dmg` for Intel,
open it, and drag DevHarbor to Applications. (Not sure? Apple menu →  About This Mac → "Chip" says
"Apple" for arm64.)

> Releases are signed with a Developer ID and notarized by Apple, so they open normally — no right-click bypass needed.

## Contributing

Contributions welcome! Start with [CONTRIBUTING.md](CONTRIBUTING.md) — it covers dev setup
(`pnpm install && pnpm dev`), the spec-driven workflow, and the PR checklist. Please also
read the [Code of Conduct](CODE_OF_CONDUCT.md). For security issues, see [SECURITY.md](SECURITY.md).

## Status

See [`specs/PROGRESS.md`](specs/PROGRESS.md) for the build-status matrix — that file is authoritative.

The `specs/` folder is the source of truth for this project. See [`specs/WORKFLOW.md`](specs/WORKFLOW.md) for the rules of the road (read-before / update-before-code, step-back review after every change, etc.).

## Where to start

1. [`specs/WORKFLOW.md`](specs/WORKFLOW.md) — how we work
2. [`specs/PROGRESS.md`](specs/PROGRESS.md) — what's actually built right now
3. [`specs/00-overview.md`](specs/00-overview.md) — problem, goals, non-goals
4. [`specs/01-architecture.md`](specs/01-architecture.md) — tech stack, process model, IPC
5. [`specs/02-data-model.md`](specs/02-data-model.md) — SQLite schema and core types (incl. multi-task model)
6. [`specs/03-features.md`](specs/03-features.md) — every feature, with acceptance criteria
7. [`specs/04-ui.md`](specs/04-ui.md) — screens, layout, key interactions
8. [`specs/05-roadmap.md`](specs/05-roadmap.md) — phased delivery plan

## Stack (as built)

Electron 33 + Vite + React 18 + TypeScript · Tailwind 3 (hand-rolled components; theme via semantic CSS variables driven by the **Radix Colors slate scale** — same palette family shadcn/ui, Linear, and Vercel use) · Zustand · better-sqlite3 · `@homebridge/node-pty-prebuilt-multiarch` · `@xterm/xterm` (+ fit, search, webgl) · chokidar · pidusage · `package-manager-detector` · cmdk · react-window + anser · electron-builder + electron-updater · Vitest.

See [`specs/01-architecture.md`](specs/01-architecture.md) for the full rationale and [`specs/PROGRESS.md`](specs/PROGRESS.md) for current build status.

## License

[GNU AGPL-3.0](LICENSE) © 2026 Jainath Ponnala

DevHarbor is free and open source. You may use, study, modify, and share it — but if you
distribute a modified version, or run a modified version as a network service, you must release
your source under the same AGPL-3.0 license. See [`LICENSE`](LICENSE) for the full terms.

The **name "DevHarbor" and its logo are trademarks** and are *not* covered by the AGPL — see
[`TRADEMARK.md`](TRADEMARK.md). Forks are welcome, but please ship them under a different name.
