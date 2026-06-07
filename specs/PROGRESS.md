# PROGRESS

The build-status matrix for DevHarbor. **This file is authoritative** — if a feature is listed as shipped here, it's actually working in the codebase; if listed as planned, no code exists for it yet.

Maintained by hand. Update after every meaningful change.

Legend:

- ✅ shipped — code exists, exercised manually at least once
- 🚧 in progress — partial implementation
- 📐 spec'd — exists in `specs/`, no code yet
- 💭 stretch — listed in `specs/` stretch sections, not committed for v1

Last sync: **2026-05-22** (after Phase 6 polish marathon — audit findings closed).

---

## Phases

| # | Phase | Status | Notes |
|---|---|---|---|
| 0 | Scaffold | ✅ | electron-vite + React + TS + Tailwind + better-sqlite3 booted. Migration runner. IPC ping round-trip. |
| 1 | Register + Detect + Run (F1–F5) | ✅ | App registry CRUD, NodeResolver, PMDetector, DetectionService, PTY-based ProcessManager, sidebar + detail view + xterm. |
| 1.5 | Multi-task apps (F19, F4/F5 task-aware) | ✅ | `tasks` table + backfill, AppOrchestrator (topo start, reverse-topo stop), all four readiness watchers (none/port/log/exit/delay), TaskTabs strip in App Detail, TaskEditor drawer. Single-task apps still work unchanged. |
| 2 | Logs polish + process hardening (F7, F15) | ✅ | Main-side `LogBuffer` ring buffer (5MB/10k lines per task) with `task:readBuffer` replay; coalesced IPC at ~30Hz / 16KB; xterm WebGL renderer + search addon (Cmd+F overlay); PTY resize on window resize via `task:resize`; `run_history` migration `0003` + writes per task; History sub-view in App Detail with Rerun; CrashPin component pins last 200 lines + Restart when a task crashes. |
| 3 | Env, Dashboard, Stats (F6, F9–F11, F18) | ✅ | `EnvStore` (global + per-app) + `EnvBuilder` layering + chokidar `EnvFileWatcher` with disk-changed banner. `PathProbe` login-shell PATH on startup. `StatsMonitor` (pidusage @ 1Hz) and `PortDetector` (lsof + stdout parse) push `task:stats`/`task:ports`. Dashboard with per-app cards + CPU sparkline + clickable port chips. EnvEditor drawer (App/Global tabs, secret masking, effective merged preview, .env file panel). `Settings` service plumbed via IPC. |
| 4 | Dev-friendly extras (F8, F12–F14, F16, F17) | ✅ | `cmdk` palette with Apps/Stop/Restart/Start/Actions sections (global ⌘K). `RestartWatcher` (chokidar, debounced 500ms) wired to `AppOrchestrator.restartApp` when `auto_restart_on_change` is enabled; `AppConfigDrawer` lets the user toggle it + edit globs. `LogSearchView` (react-window + anser) — virtualized regex/case-sensitive search with highlight + line numbers; new "Search" tab next to Logs/History. `DeepLinks` registers `devharbor://` protocol with `open` / `start` actions. `Updater` (`electron-updater`) plumbed end-to-end; no live feed yet (Phase 5). |
| 5 | Package + sign for macOS | ✅ | Full `electron-builder.yml` with hardened runtime, entitlements, asarUnpack for native deps, GitHub Releases publish target, deep-link URL scheme in Info.plist. `build/entitlements.mac.plist` + `build/notarize.cjs` afterSign hook. About panel set via `app.setAboutPanelOptions`. `UpdateBanner` consumes `update:available` / `update:ready`. `.github/workflows/release.yml` builds + signs + notarizes + publishes on `v*` tags. `specs/06-release.md` is the full runbook. **Unsigned arm64 DMG verified locally (105MB).** Signing requires Apple Developer credentials supplied via env vars / GitHub secrets. |
| 6 | v1 polish marathon | ✅ | Theming overhaul (Radix slate scale, semantic CSS variables), dashboard redesign (Recent strip + stable alphabetical grid), tab consolidation (Logs · Live/Filter), Node version picker, per-task port chips, sidebar/task right-click menus, Cmd+Enter to start, EnvEditor bulk paste/export, deep-link app focus, updater progress %, full Vitest suite, danger-zone settings, signed icon. |
| 7 | UI consistency + task-level env | ✅ | **Layout-stable cards & header** (port row + task strip reserve fixed height in IDLE state — no shift on Start; card min-h removed in round 2 since chip-row content already aligns same-task-count cards). **Three-tier env** (global / app / task) — `env_vars.task_id` column, EnvBuilder reads task rows from DB instead of `tasks.env_overrides` JSON (frozen via TaskRegistry guard), EnvEditor third tab + grouped preview Task→App→Global. **Detail header refactor** — header "Tasks" + "Script:" buttons both removed; single/multi-task headers identical. Smart delete (stop-then-remove when running). Lifecycle buttons share min-w. **Copy-path icon**. **Logs header typography**. **Sidebar count badge** switched to white text on success-strong green (was bg-base on green, ~2.8:1). EnvLayering test (9 cases) covers 3-scope precedence. |
| 8 | Folders in sidebar (F21) | ✅ | `apps.folder` column (migration 0005), AppRegistry helpers (listFolders, renameFolder, clearFolder), Sidebar grouped rendering with collapsible sections (localStorage state), right-click move/rename/delete, AppConfigDrawer folder field with datalist autocomplete. Tags remain orthogonal. |
| 8.b | Sidebar UX overhaul | ✅ | **⋮ overflow menu** per app row (replaces hidden right-click; right-click still works as fallback). State conveyed via **colored ring around the color dot** (green/amber/red); idle = no ring. **+** (add app) and **📁+** (new folder) icons moved up next to the APPS section label — Postman-style discoverability. Bottom row reduced to just the Settings cog. **PromptModal** component replaces silently-no-op `window.prompt()` for new/rename folder flows. **HTML5 drag-and-drop** apps between folder sections (drop on "(Ungrouped)" to clear). Empty folders persisted in `localStorage["devharbor:pinned-folders"]`. |
| 9 | Rebrand → DevHarbor | ✅ | App Manager → DevHarbor across package.json, electron-builder.yml (appId `app.devharbor.desktop`, productName, protocol `devharbor://`, repo), src/main (About panel, deep-link scheme, DB filename `devharbor.db`), all renderer strings + localStorage keys, README, specs, entitlements. New app icon (1024² → full .icns). DMG → `devharbor-0.1.0-arm64.dmg`. |
| 10 | Add-app flow + in-app dialogs | ✅ | **Add-app fix**: chosen default script is now materialised into the app's first Task via `tasks:add` (was: script stored on app row but no task → Start failed "No enabled tasks"). Add drawer gains **NodeVersionPicker**, **package-manager override** (pre-selected to detected PM), and optional **.env paste**. **`openConfirm`** added to the dialog host; all 5 native `confirm()` calls (TaskTabs, SettingsDrawer, Sidebar ×2, AppDetail) replaced with the custom danger-styled modal. `PromptModalHost` aliased to `DialogHost`. |
| 11 | DevHarbor UI-reference theme | ✅ | Ported the claude.ai/design reference: **teal accent `#2dd4bf`** + neutral near-black canvas, **single glowing status dot** (running=green+pulse) consistent across sidebar/dashboard/recent/detail, **thin CPU progress bar** (replaces sparkline), teal port numbers. Dashboard icon → Boxes, **count badge** = 18px green circle with dark text, settings gear → bottom-left dim. "Open in" detection fixed (`.app` bundle existence + `open -a`, PATH-independent). Color picker removed. Detail header **action row regrouped** (uniform icon buttons │ filled primary │ isolated destructive). |
| 12 | Prod hardening | ✅ | **Custom application menu** (`menu.ts`) replaces the Electron default — drops Toggle DevTools / Force Reload from prod (kept in dev), keeps ⌘R Reload, includes Edit roles for copy/paste, Help → www.devharbor.app, app menu with About/Quit DevHarbor. **Single-instance lock** + focus-on-second-instance. **`will-navigate` guard** + `<webview>` block. Launch `backgroundColor` → `#0a0a0a` (no flash). Dead-code sweep (Sparkline, HistoryView, taskCpuHistory, unused imports). Already-present security kept: contextIsolation, sandbox, nodeIntegration off, window-open http/https-only, CSP, hardened runtime. |
| 13 | Dashboard IA redesign | ✅ | **Removed the Recent strip** (redundant with sidebar + grid; `RecentStrip.tsx` deleted). Dashboard reframed as the **control room**: leads with an **aggregate stat strip** (Running / CPU / Memory / Open ports across all running tasks) — value the navigation-only sidebar can't provide. Dropped the redundant "ALL APPS" label. **Running cards emphasised in place** (teal inset left edge + lifted surface) — no reorder, no layout shift. Sidebar kept as the switcher; dashboard is now monitoring + control. |
| 13.b | macOS menu actions | ✅ | HIG-standard system-menu items wired to the renderer via typed `menu:*` events: **Settings… (⌘,)** in the app menu → opens the Settings drawer; **Add App… (⌘N)** + **Add Folder… (⌘⇧N)** in File. `installAppMenu` takes a window getter; `App.tsx` handles settings/add-app and relays new-folder to the sidebar via a DOM event. |
| 15 | Code-review fixes (high-effort recall pass) | ✅ | **Add-app**: stop persisting `default_script` (killed backfill resurrecting a deleted task) + roll back the app if task/env creation throws (no orphan). **Shared `src/shared/dotenv.ts`** parser + `isSecretKey` replaces 3 diverged copies (EnvBuilder expanded escapes, renderer copies didn't) + 8 new tests. **Menu** create/focus a window when none is open (⌘,/⌘N/⌘⇧N no longer dead keys). **Dashboard** `React.memo(AppCard)` — idle cards skip the ~1Hz re-render. **OpenIn** detect editors via LaunchServices (`osascript`) so non-standard install locations aren't hidden. **store** clears CPU/mem/ports when a task leaves running (no stale values on restart). **AddAppDrawer** memoizes env key-count parse. **will-navigate** compares URL origin, not string prefix. **Sidebar** drops a folder from the pinned list once it has an app (no zombie empty folders). |

## Feature-by-feature

| ID | Feature | Spec | Code | Notes |
|---|---|---|---|---|
| F1 | Register a local app | ✅ | ✅ | Direct-add (no confirmation drawer yet — Phase 1 trade-off). |
| F2 | Detect & resolve Node version | ✅ | ✅ | nvm / fnm / volta / asdf / system. `.nvmrc` / `.node-version` / `engines.node`. Blocks start with install hint if missing. |
| F3 | Detect & use package manager | ✅ | ✅ | `package-manager-detector` (lockfile + `packageManager` field). |
| F4 | Start / stop / restart | ✅ | ✅ | App-level Start/Stop/Restart drives the orchestrator (topo start, reverse-topo stop). Per-task Start/Stop in tab strip. |
| F5 | Script picker | ✅ | ✅ | Header dropdown for single-task apps, full task editor for multi-task. |
| F6 | Env vars (global + per-app + per-task) | ✅ | ✅ | `EnvStore` with replace-semantics save, **three scopes since Phase 7** via `env_vars.task_id` column. UI: drawer with Global / App / Task tabs (task tab only with task context), secret masking, override-chip indicators per scope, effective merged preview, .env file list. Disk changes raise a Restart banner. |
| F7 | Live logs (per app) | ✅ | ✅ | xterm + ANSI + WebGL + Cmd+F search + main-side ring buffer + coalesced IPC + PTY resize. Toolbar: copy all (clipboard), save to file (download), font size +/-, jump-to-bottom chip when scrolled. Long-line truncation in LogBuffer with `[line truncated]` marker. *(Autoscroll lock toggle deferred — a "jump to bottom" chip is shipped instead.)* |
| F8 | Searchable log history | ✅ | ✅ | `LogSearchView` virtualizes the live ring buffer via `react-window`. ANSI rendered with `anser`. Plain or regex search, case toggle, match-count + clear. |
| F9 | Dashboard / home screen | ✅ | ✅ | Cards per app with CPU sparkline, mem, port chips, Start/Stop. Start-all/Stop-all toolbar. |
| F10 | Port detection + clickable links | ✅ | ✅ | `PortDetector` polls lsof every 2s + parses stdout for hints. Chips render in App Detail header and Dashboard cards. Click opens in default browser via `setWindowOpenHandler`. |
| F11 | CPU & memory per process | ✅ | ✅ | `StatsMonitor` (`pidusage`) emits `task:stats`. Renderer keeps 60s CPU history for sparklines. Interval configurable via Settings (`dashboard_refresh_ms`). |
| F12 | Command palette (Cmd-K) | ✅ | ✅ | `cmdk`-based. Global ⌘K. Sections: Apps (jump), Stop/Restart, Running tasks (stop), Start, Actions (dashboard / add / settings / stop all). |
| F13 | .env file watching + reload prompt | ✅ | ✅ | Shipped in Phase 3 (`EnvFileWatcher` + AppDetail banner). |
| F14 | Restart-on-file-change | ✅ | ✅ | `RestartWatcher` (chokidar) debounced 500ms. Per-app toggle + globs in `AppConfigDrawer`. Defaults to `src/**/*.{ts,tsx,js,jsx,mjs,cjs}`; common dirs ignored. |
| F15 | Crash handling + run history | ✅ | ✅ | `crashed` state with CrashPin showing last 200 lines + Restart. `run_history` populated per task via `RunHistory` service. History sub-view with Rerun action. |
| F16 | Deep links (`devharbor://...`) | ✅ | ✅ | Protocol registered + `open-url` event. `open?path=` and `open?id=` push `deepLink:focusApp` to the renderer which selects the app. Unknown paths surface `deepLink:unknownPath` which opens the Add drawer pre-filled. `start?id=` focuses + starts. |
| F17 | Auto-update | ✅ | ✅ | `Updater` + `update:available` / `update:progress` / `update:ready` / `update:install`. `UpdateBanner` shows download percentage and Quit & install. GitHub Releases publish wired. Activates once a signed Release is published. |
| F18 | Settings | ✅ | ✅ | All settings honored: `kill_grace_ms` (TaskRunner), `log_ring_size` (LogBuffer + xterm scrollback), `theme` (renderer `<html>` class), `dashboard_refresh_ms` (StatsMonitor), `auto_update` (Updater). Node detection panel lists discovered nvm/fnm/volta/asdf/system installs. Danger zone: Export DB (file picker), Reset DB (archives + relaunches with empty DB). (The earlier inert `log_disk_persist_default` and `telemetry` flags were removed before 1.0 — no placeholder controls ship.) |
| F19 | Multi-task orchestration | ✅ | ✅ | Full implementation: `tasks` table, TaskRegistry CRUD with cycle detection, AppOrchestrator with topo levels, all four readiness watchers (`none`/`port`/`log`/`exit`/`delay`), TaskTabs + TaskEditor UI, per-task and per-app lifecycle IPC. |

## Stack inventory

What's actually installed and used vs. spec'd-only:

| Library | Spec'd | Installed | Used in code |
|---|---|---|---|
| electron + electron-vite | ✅ | ✅ | ✅ |
| electron-builder | ✅ | ✅ | config only, not run |
| React 18 + TS | ✅ | ✅ | ✅ |
| Tailwind 3 + tailwind-merge + clsx | ✅ | ✅ | ✅ |
| shadcn/ui + Radix | ✅ | not initialised | (hand-rolled components in `src/renderer/components/` for now) |
| Zustand | ✅ | ✅ | ✅ |
| better-sqlite3 | ✅ | ✅ | ✅ |
| `@homebridge/node-pty-prebuilt-multiarch` | ✅ | ✅ | ✅ |
| `@xterm/xterm` + addon-fit | ✅ | ✅ | ✅ |
| `@xterm/addon-search` | ✅ | ✅ | not used yet (Phase 2) |
| `package-manager-detector` | ✅ | ✅ | ✅ |
| semver | ✅ | ✅ | ✅ |
| tree-kill | ✅ | ✅ | ✅ |
| ulid | ✅ | ✅ | ✅ |
| lucide-react | ✅ | ✅ | ✅ |
| `@tanstack/react-table` | ✅ | ⏳ | (env editor — Phase 3) |
| `cmdk` | ✅ | ⏳ | (Cmd-K — Phase 4) |
| chokidar | ✅ | ⏳ | (.env watching — Phase 4) |
| pidusage | ✅ | ⏳ | (stats — Phase 3) |
| dockerode | 💭 | ⏳ | (stretch) |
| keytar | 💭 | ⏳ | (stretch — keychain secrets) |

## Known limitations / known-broken (carry list)

These are real and worth fixing; tracked here so they don't get lost. **Phase 6 is the polish marathon working through them.**

- **DevTools auto-opens in dev** — intentional, but ungated. Add a setting in Phase 6 if there's time.
- **Orchestrator can't await readiness on a task the user started manually** — if the user clicks Start on a single task and then starts the whole App, the orchestrator skips waiting on that task's readiness. Acceptable for v1.

### Phase 6 audit close-out (all ✅ unless noted)

All findings from the post-Phase-5 audit:

- ✅ **Sidebar:** filter input + ⌘P, right-click context menu (Start/Stop/Restart/Reveal/Open Terminal/Remove), tag chips. *Drag-to-reorder and group-by-tag deferred — a `sort_position` migration is the cleanest path.*
- ✅ **App Detail:** Open-in menu (Finder/Terminal/VS Code/Cursor/Sublime, auto-detected), ⌘↩ to start.
- ✅ **Log toolbar:** copy all, save to file, font size +/-, ⌘F search, jump-to-bottom chip on scroll-up. >10kB line truncation in LogBuffer.
- ✅ **Tasks:** drag-to-reorder in TaskEditor list, right-click menu on tabs (Start/Stop/Restart/Disable/Edit/Remove).
- ✅ **Dashboard:** filter-by-tag dropdown, recently-used empty state with one-click Start.
- ✅ **Env editor:** Paste `.env` blob (parses + auto-flags SECRET/TOKEN/PASSWORD/KEY/PRIVATE), Export merged env to clipboard.
- ✅ **Add app:** detection drawer with confirm before adding; already-registered path focuses existing with a toast.
- ✅ **F16 deep links:** `deepLink:focusApp` event lands the renderer on the right app; `deepLink:unknownPath` opens the Add drawer pre-filled.
- ✅ **F17 auto-update:** `download-progress` event wired; banner shows %.
- ✅ **F18 settings:** all keys wired to runtime; Node detection panel + Danger zone (Export DB, Reset DB).
- ✅ **Real bugs:** `shell.openExternal` URL scheme validation; `settings:set` key validation; restart-on-change errors no longer swallowed.
- ✅ **Tests:** Vitest 2 + 24 passing tests for topo, LogBuffer, PortDetector regex parsing.

### Deferred items (not blocking v1)

- **Drag-to-reorder sidebar apps** — needs a `sort_position` migration. Tasks are already reorderable; apps default to `updated_at DESC` order.
- **Group sidebar by tag** — tag chips shipped; collapsible groups deferred.
- **Autoscroll lock toggle in logs** — shipped as a "Jump to bottom" chip instead, which solves the same problem more cleanly.
- **Per-run log save to disk** — not built; the placeholder `log_disk_persist_default` setting was **removed** before 1.0 (no dead controls ship). Revisit if/when disk persistence lands.
- **Telemetry** — no telemetry pipeline, and the placeholder `telemetry` flag was **removed** before 1.0. (DevHarbor ships with no analytics.)
- **DevTools auto-opens in dev** — intentional, but ungated.
- **Orchestrator can't await readiness on a task the user started manually** — acceptable for v1.

## Recently fixed (carry-list closures)

- **2026-05-22** — Phase 1.5 boot blank-screen / "Maximum update depth exceeded" — `useStore((s) => s.tasksByApp[id] ?? [])` returned a new `[]` per selector call, triggering a `useSyncExternalStore` re-render loop. Fixed with a module-level `EMPTY_TASKS` constant in AppDetail.tsx and TaskEditor.tsx.
- **2026-05-22** — TaskEditor fired `tasks:update` IPC on every keystroke. Now coalesced via a `useDebouncedSave` hook (300ms) with optimistic local store updates so inputs stay snappy.
- **2026-05-22** — Sticky error banners. Added a reusable `ErrorBanner` with a close-X; used in both AppDetail and TaskEditor.
- **2026-05-22** — Phase 2: main-side `LogBuffer` + coalesced IPC, xterm WebGL + Cmd+F search, PTY resize sync, `run_history` per task, History sub-view, CrashPin.
- **2026-05-22** — CrashPin dismissal bug in multi-task case (dismiss A → switch to B → back to A → A stayed hidden). Fixed by resetting dismissal when `taskId` changes via a `useEffect`.
- **2026-05-22** — Phase 3: `PathProbe` (login-shell PATH on startup), `EnvStore` + `EnvBuilder` layering, `EnvFileWatcher` (chokidar) with disk-changed banner, `Settings` service + IPC, `StatsMonitor` (pidusage), `PortDetector` (lsof + stdout parse), Dashboard, EnvEditor, PortChip, Sparkline.
- **2026-05-22** — `apps:update` was re-watching the env folder on every patch; now only re-watches when `path` actually changes.
- **2026-05-22** — Settings UI pane shipped (sidebar gear icon → SettingsDrawer).
- **2026-05-22** — Phase 4: `CommandPalette` (cmdk), `RestartWatcher` + `AppConfigDrawer`, `LogSearchView` (react-window + anser), `DeepLinks` (`devharbor://` protocol), `Updater` (electron-updater) plumbed.
- **2026-05-22** — Cmd+K affordance: kbd-styled button in the sidebar header, clickable to open the palette.
- **2026-05-22** — Phase 5: hardened-runtime entitlements, asarUnpack for native deps, deep-link URL scheme registered in Info.plist, About panel, UpdateBanner UI, GitHub Actions release workflow + `specs/06-release.md` runbook. Unsigned arm64 DMG built and verified locally.
- **2026-05-22** — Phase 6 polish marathon (all audit findings):
  - 6.a Honesty pass + 3 real bug fixes (URL scheme validation, settings key validation, surface restart-on-change errors).
  - 6.b Wired all "dead" settings (kill_grace_ms, log_ring_size, theme).
  - 6.c Open-in menu, ⌘↩, log toolbar (copy/save/font), jump-to-bottom chip.
  - 6.d Sidebar filter + ⌘P, right-click context menu, tag chips, AppConfigDrawer tag editor.
  - 6.e Task drag-to-reorder + right-click menu on tabs.
  - 6.f Dashboard tag filter + recently-used empty state.
  - 6.g EnvEditor: paste `.env` blob + export merged env.
  - 6.h Detection drawer on Add + already-registered path now focuses existing app.
  - 6.i Deep links: `deepLink:focusApp` / `deepLink:unknownPath` wired; renderer selects/adds.
  - 6.j Updater: `download-progress` event wired; UpdateBanner shows %.
  - 6.k Settings: Node-detection panel + Danger zone (Export DB / Reset DB).
  - 6.l Vitest 2 setup + 24 passing tests (topo, LogBuffer, PortDetector regex).
  - 6.m Long-line truncation (>10kB) with `[line truncated]` marker in LogBuffer.
- **2026-05-22** — Dashboard now shows a consistent card grid for every app regardless of running state. **Real bug fix:** `AppOrchestrator.startApp` was not setting `lastStartedAt` (regression from the Phase 1 → 1.5 refactor) — now it does, and the renderer optimistically bumps the cached value on each `proc:status: starting`.
- **2026-05-22** — Dashboard cards no longer jump on Start. Two-region design: a compact "Recent" strip up top (chips sorted by `lastStartedAt` DESC — they can re-order freely because they aren't the click target) + a stable **alphabetical** grid below that NEVER auto-reorders. Surfaces recency without disturbing the interaction surface. Pattern borrowed from Linear / VS Code "Recent" sections.
- **2026-05-22** — Light mode actually works. Replaced hardcoded `bg-neutral-*` / `text-neutral-*` classes across all renderer components with semantic CSS-variable tokens (`bg-base` / `bg-surface` / `bg-elevated` / `border` / `border-strong` / `fg` / `fg-muted` / `fg-subtle` / `accent`). Variable values are set in `.dark` and `.light` blocks; toggling `theme` in Settings flips the whole palette without per-component overrides. (xterm log pane stays on a dark scheme regardless — intentional, matches VS Code.)
- **2026-05-22** — Status colors (Stop buttons, Dashboard running-count badge, ErrorBanner, env-changed banner, CrashPin, etc.) had low light-mode contrast — the dark-red-at-30%-opacity tricks that worked on dark surfaces became invisible on white. Added semantic `danger` / `success` / `warn` token families (`bg`, `bg-hover`, `fg`, `border`, `strong`) with inverted dark/light palettes. Solid-color state dots (`bg-red-500`, `bg-green-500`, `bg-amber-500`) kept as-is since saturated mid-tones read on both backgrounds.
- **2026-05-22** — Kbd shortcut hints now use a space between modifier and key (⌘ K, ⌘ P, ⌘ F, ⌘ ↩) — matches Apple's convention.
- **2026-05-22** — Multi-task apps weren't showing port chips on the dashboard / detail. Three bugs in `PortDetector`:
  1. `collectDescendants` was adding PID `0` to the lsof query set (`Number('')` returns `0`, not `NaN`), which made lsof return nothing.
  2. The merged port set used `observed` exclusively when non-empty, **discarding stdout hints**. Now it's a union — anything either source detected counts.
  3. First port poll fired up to 2s after `track()`. Now an immediate `tick()` runs on track.
  Plus bumped `pgrep` traversal depth from 3 → 5 to cover deeper chains (npm → shell → tsx → user binary), and made the renderer-side hydration populate `taskPorts` / `taskCpu` / `taskMemMB` from `task:list` on bootstrap (the events only fire on change, so post-refresh state was empty).

- **2026-05-30** — Phase 15: sidebar/settings consistency pass.
  - **Folder headers now match app rows** — a hover-revealed ⋮ overflow menu (Rename / Delete) instead of right-click-only, restructured from `<button>` to a draggable `<div>`.
  - **Draggable folder reordering** — folder headers carry a distinct drag MIME (`application/x-appmgr-folder`) so reordering never collides with app-into-folder drops. Order persists to `localStorage["devharbor:folder-order"]`; ordered folders sort first, then alphabetical, "(Ungrouped)" always last. No nested folders.
  - **`TagInput`** (new) — chip editor with autocomplete replaces the comma-separated text field in `AppConfigDrawer`. Suggests tags already used on other apps. Tags now also feed the ⌘P switcher search (typing a tag surfaces matching apps, which display their tags) on top of the existing sidebar search + Dashboard tag filter — giving tags a real cross-folder slicing purpose.
  - **`FolderSelect`** (new) — combobox replacing the plain folder text+datalist: pick "No folder", an existing folder (checkmark on current), or "Create new folder…" with an inline name input.
- **2026-05-30** — Phase 15b: sidebar **Group-by switcher** (Folder ⇄ Tag).
  - Finder-style 2-segment control in the APPS header toggles the list between grouping by `folder` and grouping by `tag`; persisted to `localStorage["devharbor:group-mode"]`.
  - **Tag mode** renders tag groups exactly like folders (collapsible), with an app showing under each of its tags and a pinned "(Untagged)" catch-all. Folder-only affordances (create-folder, ⋮ rename/delete, drag-reorder) are hidden in tag mode; **dragging an app onto a tag group adds that tag** (idempotent; drop on "(Untagged)" is a no-op). No tags anywhere → flat list with a hint.
  - **Removed the per-folder count badge** next to folder names (read as an "order number" after reorder shipped; visual noise).

- **2026-05-31** — Phase 16: stopped-state consistency + binary slimming.
  - **App no longer flickers Idle after a stop.** Root cause: `deriveAppState` never returned `'exited'` (an exited task fell through to the `'idle'` fallback), and once tasks were torn down (~1.5 s) nothing remembered the app had run. Fix in `AppOrchestrator`: (1) `deriveAppState` now returns `'exited'` for a tracked-but-exited task, removing the Idle→Exited→Idle flicker during teardown; (2) a sticky per-app `lastOutcome` map (`exited` / `crashed`, `crashed` wins) keeps the app reading **Stopped/Crashed** after teardown until the next start, which clears it. A freshly-added, never-run app still shows Idle.
  - **Binary slimming — asar 40 MB → 4.3 MB.** Renderer-only libraries (react, react-dom, lucide-react [3,512 files], @xterm/*, cmdk, zustand, react-window, anser, clsx, cva, tailwind-merge) were listed as runtime `dependencies`, so electron-builder shipped them as raw `node_modules` **on top of** the Vite-bundled `out/renderer` — every one shipped twice. Moved all 14 to `devDependencies`; the renderer build bundles them, electron-builder no longer copies them. Verified none are imported by main/preload. arm64 `.app` Resources shrank ~36 MB uncompressed; arm64 DMG 109 MB → 103 MB, universal 189 MB → 183 MB. (The bulk of any Electron binary is the Chromium/V8 framework — ~200 MB arm64 / ~413 MB universal — which is irreducible; the universal target carries both arch slices.)

- **2026-05-31** — Phase 16b: stopped-state persists across restarts + regression tests.
  - The in-session fix (Phase 16) kept `lastOutcome` only in memory, so quitting DevHarbor and reopening reset every app to **Idle**. Now `registerAllIpcHandlers` seeds each app's sticky outcome on boot from its most recent `run_history` row: user-stopped / clean-exit / still-open-at-quit → `exited`; non-zero unexpected exit → `crashed`; never-run apps (no history) stay `idle`. Cleared on next start.
  - Added regression coverage: `AppOrchestrator.state.test.ts` (fast, fake runner — drives the stop sequence + boot seeding) and `AppOrchestrator.e2e.test.ts` (spawns a **real** port-listening process through the real TaskRunner and asserts the emitted `proc:status` sequence stays `…→exited→exited` past the 1.5 s teardown, never `idle`). 47 tests pass.
  - Diagnosis note: the "still Idle after stop" reports were two separate issues — (1) the in-memory `lastOutcome` never persisted, and (2) earlier observations were on a stale running instance (the single-instance lock refocuses an already-running copy instead of launching the rebuilt one). Proven via temporary main+renderer file-logging, since removed.

## How to keep this file honest

- Every PR that ships a feature should flip its row from 📐/🚧 → ✅.
- Every spec change that introduces a new feature should add a row here as 📐.
- Don't leave 🚧 rows undated — note what's left.
- This file lives in `specs/` because it *is* a spec: the spec of "what currently exists."
