# Changelog

All notable changes to DevHarbor are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-06-14

A hardening + feature release driven by a comprehensive internal audit (see
`specs/IMPROVEMENT-PLAN.md`).

> **Downgrading:** after running 1.1.0 once, secret env values are encrypted at rest and the
> database schema is upgraded. Going back to 1.0.x is not supported - export a backup first
> (Settings → Danger zone → Export) if you want a safety net.

### Added
- **Menubar (tray) presence** - see aggregate state at a glance; start/stop any app, see its
  ports, or stop everything without opening the window. Toggle in Settings.
- **Desktop notifications** when an app crashes (on by default) and, optionally, when an app
  becomes ready.
- **Bulk import** - point DevHarbor at a folder of repos and register every detected project
  in one pass (sidebar `+` menu, ⌘K, or the welcome screen).
- **Global log search (⌘⇧F)** - search every running task's logs at once; jump to the app.
- **Monorepo detection** - pnpm/yarn/npm workspaces are detected on add, with a one-click
  "create a task per workspace package" option.
- **Launch at login** and per-app **start automatically** toggles.
- **Start all / Stop all** per folder, and keyboard reordering for folders (Move up / down).
- **Quit confirmation** that gracefully stops running servers (SIGTERM → grace → kill) before
  exiting - auto-update installs included.
- **Port-conflict callout** - a crash caused by a busy port now names the port and, when
  known, which app holds it.
- Update banner shows **release notes** before "Quit & install"; **Check for Updates…** and
  **Open Logs Folder** in the Help menu; update checks repeat every 6 h on long-running Macs.
- Local **diagnostics log** (`~/Library/Logs/DevHarbor/`) for bug reports - local-only, in
  keeping with the no-telemetry promise.
- Window size and position are remembered across launches.

### Changed
- **Secret env values are encrypted at rest** (macOS Keychain-backed `safeStorage`); existing
  plaintext secrets are migrated on first launch.
- Project `.env` files can no longer override env vars you set in DevHarbor, nor
  process-control variables (`PATH`, `NODE_OPTIONS`, `DYLD_*`) - the UI is the source of
  truth, and a checked-in `.env` can't hijack the spawned process.
- `.env` parsing now matches dotenv semantics: multiline quoted values (PEM keys), `export `
  prefixes, and trailing comments; `.env.development` / `.env.development.local` variants
  load in the conventional order.
- Stopping a task now signals the **whole process tree** (graceful SIGTERM first), so dev
  servers get a clean shutdown instead of skipping straight to a hard kill.
- Hardened packaged binaries: Electron fuses disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`,
  and `--inspect`; app code loads only from the asar archive.
- Keyboard + screen-reader support across the app: focus-trapped dialogs with Escape,
  arrow-key menus and comboboxes, focusable sidebar rows, accessible status indicators,
  screen-reader-readable logs, and a light terminal theme.
- Faster under load: batched process polling (one `ps`/`lsof` per tick instead of dozens of
  forks), a global log-memory budget, render-throttled log filtering, and log streaming only
  for visible tasks.

### Fixed
- **Restart-on-change** now works (the file watcher had been silently inert after a
  dependency major bump) - with regression tests.
- Apps that had ever run can be **removed** again; lifecycle errors (missing Node version,
  moved folder, no tasks) now surface as messages from every view instead of failing silently.
- A failed start no longer leaves the app stuck on "Starting"; Stop is instant even while an
  app is still starting; readiness probes time out instead of hanging forever.
- One-shot tasks (`exit` readiness) are no longer marked ready before they finish.
- Deleted task env vars no longer resurrect after a relaunch; task-scoped overrides of an
  app-level key now save correctly.
- Database export/reset are WAL-safe (backups no longer miss recent changes); a corrupt
  database produces a recovery dialog instead of a silent no-window launch.
- Env editor warns before discarding unsaved changes and confirms saves; long app names
  truncate instead of breaking layouts; the welcome screen no longer flashes on startup for
  existing users; many smaller fixes.

## [1.0.1] - 2026-06-07

### Changed
- Canonical website domain is now **www.devharbor.app** (About panel, Help menu, repo homepage).

## [1.0.0] - 2026-06-07

First public stable release: code-signed, notarized, and auto-updating.

### Added
- **Code-signed + notarized** macOS builds with hardened runtime; **per-architecture** (Apple Silicon + Intel) DMG/zip artifacts and GitHub-based **auto-update** via `electron-updater`.
- **Folders** in the sidebar - group apps, drag to reorder, rename/delete, collapse; a glowing dot marks collapsed folders that contain a running app.
- **Tags** - chip input with autocomplete in app settings; group the sidebar by tag, filter on the dashboard, and search tags in ⌘P.
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
- Stopped apps now read **Stopped/Crashed** consistently - including after the teardown window and across app restarts (persisted from run history) - instead of flickering back to Idle.
- Single-instance relaunch always surfaces a window (no more "running but no window" dead state).
- Smaller install: renderer libraries are bundled, not double-shipped as `node_modules` (asar ~40 MB → ~4 MB).
- Numerous correctness fixes from an internal review (atomic app-add, env parsing, stale stats, navigation origin checks, folder-state drift).

## [0.1.0] - 2026-05-30

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

[Unreleased]: https://github.com/jainath/devharbor/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/jainath/devharbor/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/jainath/devharbor/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jainath/devharbor/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/jainath/devharbor/releases/tag/v0.1.0
