# Changelog

All notable changes to DevHarbor are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] — 2026-06-07

### Changed
- Canonical website domain is now **www.devharbor.app** (About panel, Help menu, repo homepage).

## [1.0.0] — 2026-06-07

First public stable release: code-signed, notarized, and auto-updating.

### Added
- **Code-signed + notarized** macOS builds with hardened runtime; **per-architecture** (Apple Silicon + Intel) DMG/zip artifacts and GitHub-based **auto-update** via `electron-updater`.
- **Folders** in the sidebar — group apps, drag to reorder, rename/delete, collapse; a glowing dot marks collapsed folders that contain a running app.
- **Tags** — chip input with autocomplete in app settings; group the sidebar by tag, filter on the dashboard, and search tags in ⌘P.
- **Group-by switcher** (Folder ⇄ Tag) and a **shared sort** (Name · Recently used · Running first) across the sidebar and dashboard.
- **Folder picker** combobox in app settings (select existing or create new).
- Open-source community files (CONTRIBUTING, Code of Conduct, Security policy, issue/PR templates).
- macOS menu actions: **Settings (⌘,)**, **Add App (⌘N)**, **Add Folder (⌘⇧N)**.
- Hover tooltips on every icon control.

### Changed
- Softened the dark theme to a zinc scale (less harsh contrast).
- App lists default to **stable alphabetical** order so rows don't jump on start/edit.
- Detail-page lifecycle buttons read **Start app / Stop app / Restart app**.

### Fixed
- Stopped apps now read **Stopped/Crashed** consistently — including after the teardown window and across app restarts (persisted from run history) — instead of flickering back to Idle.
- Single-instance relaunch always surfaces a window (no more "running but no window" dead state).
- Smaller install: renderer libraries are bundled, not double-shipped as `node_modules` (asar ~40 MB → ~4 MB).
- Numerous correctness fixes from an internal review (atomic app-add, env parsing, stale stats, navigation origin checks, folder-state drift).

## [0.1.0] — 2026-05-30

First public preview. macOS-only (Apple Silicon).

### Added
- Register local Node.js projects; auto-detect package manager, Node version, scripts, `.env` files.
- Multi-task orchestration with dependency ordering and readiness signals (port / log / exit / delay).
- Per-app Node version resolution across nvm / fnm / volta / asdf / system.
- Live logs (xterm) with search, plus a virtualized regex filter view.
- Three-tier environment variables: global → app → task, with `.env` watching.
- Live CPU/memory stats and automatic port detection with clickable links.
- Dashboard control room, folder organization, and a ⌘K command palette.
- Local-only storage (SQLite). No accounts, no telemetry.

[Unreleased]: https://github.com/jainath/devharbor/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/jainath/devharbor/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jainath/devharbor/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/jainath/devharbor/releases/tag/v0.1.0
