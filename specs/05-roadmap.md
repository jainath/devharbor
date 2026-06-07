# 05 — Roadmap

Phased delivery. Each phase is a coherent slice we could *ship* internally, not a vague time-bucket. Features map to the IDs in [`03-features.md`](03-features.md).

## Phase 0 — Scaffold  *(must finish before P1)*

- Init git repo + `.gitignore` + `.nvmrc` + `LICENSE`.
- electron-vite scaffold with TS + React + Tailwind.
- shadcn/ui init, base components (button, input, dialog, tabs, table, scroll-area, tooltip, dropdown-menu, command, drawer).
- Set up `src/main`, `src/preload`, `src/renderer`, `src/shared`.
- contextBridge surface (`window.api`), one ping channel to prove typing works end-to-end.
- better-sqlite3 wired up with a migrations runner and `0001_init.sql`.
- Single dev script: `pnpm dev` boots Electron with HMR.

**Exit criteria.** `pnpm dev` opens an empty styled window. `window.api.ping()` round-trips. DB file is created on first launch.

## Phase 1 — Register + Detect + Run  *(F1, F2, F3, F4, F5)*

The smallest version that's actually useful.

- App registry CRUD (`apps:list/add/update/remove/detect`).
- `NodeResolver`: scan nvm/fnm/volta/asdf/system; resolve `.nvmrc` / `.node-version` / `engines.node`.
- `PMDetector`: lockfile + `packageManager` field via `package-manager-detector`.
- `ProcessManager`: PTY spawn, layered env (without per-app overrides yet — just sanitized base + `.env` files), detached process group kill.
- Script picker UI.
- App detail view, Logs tab with xterm (no search yet).
- Sidebar with add-app flow and detection drawer.

**Exit criteria.**
- Register 3 typical projects (Next.js / Vite / Express).
- Each starts with the right Node version and PM, streams correct colored logs.
- Stop kills every descendant within 6s.

## Phase 1.5 — Multi-task apps  *(F19, plus F4/F5 task-aware revisions)*

Why now (not later): Phase 2 is logs polish (xterm addons, ring buffer, run history). Per-task log panes change the shape of that UI; landing tasks first means Phase 2 polishes the right shape.

- Schema migration `0002_tasks.sql` (table + index, no data).
- App-side backfill on startup: seed one task per existing app from `default_script` / `custom_command` (see [02-data-model.md](02-data-model.md)).
- Split `ProcessManager` → `TaskRunner` (single-PTY lifecycle, mostly the current code) + `AppOrchestrator` (topo-sorted start, reverse-topo stop, readiness watching).
- Readiness watchers: `none`, `port` (lsof poll), `log` (regex against stream), `exit` (status hook), `delay` (timer).
- New IPC channels: `tasks:list/add/update/remove/reorder`, `task:start/stop`, `task:log` and `task:status` event streams. App-level `proc:start/stop/restart` keep their semantics but now operate via the orchestrator.
- UI: task tab strip in App Detail above the log pane; Tasks editor table in Config tab; per-task right-click menu.
- Backwards compat: an app with one task renders without the tab strip — UI feels identical to Phase 1 for the common case.

**Exit criteria.**

- A real multi-task project (e.g. `migrate` oneShot → `api` port:4000 → `web` port:3000) starts in correct order, stops in reverse, no orphans within 6s.
- Apps that existed before this phase boot with one auto-seeded task and behave exactly as before.
- Adding a dependency cycle in the editor surfaces an error with the cycle path; nothing is saved.
- A monorepo registered as a single App with three workspace tasks (`apps/api`, `apps/web`, `packages/shared`) starts in the right order with `working_dir_override` per task.

## Phase 2 — Logs polish + process hardening  *(F7, F15)*

- xterm addons (search, webgl, fit). Cmd+F works.
- Ring buffer with replay-on-tab-switch.
- Coalesced IPC log push.
- `run_history` table populated **per task** (migration `0003_run_history_tasks.sql` adds `task_id`); History tab in app detail groups rows by run.
- Crash detection: non-zero exit → `crashed` state + pinned last 200 lines.
- "Save logs to disk" toggle per-app.

**Exit criteria.**
- Vite dev banner renders identically to a real terminal.
- A 30s noisy log burst stays at 60fps and loses no lines.
- A crashed app stays visible with exit code and a Restart action.

## Phase 3 — Env, Dashboard, Stats  *(F6, F9, F10, F11, F18)*

- `EnvStore` with global + per-app scopes.
- Env editor (TanStack Table-based) on both Global and App scopes.
- `.env*` discovery + read-only preview pane.
- `EnvFileWatcher` (chokidar) with banners.
- Dashboard view (running cards, sparklines, port chips).
- `PortDetector` (lsof + stdout parsing).
- `pidusage` poll loop + `proc:stats` push.
- Settings pane (theme, ring size, kill grace, dashboard refresh).

**Exit criteria.**
- Layered env vars work end-to-end with a global `DEBUG=app:*` override demonstrated.
- Dashboard updates at 1Hz with 5 running apps and stays under 2% self-CPU.
- Clickable `localhost:<port>` chip appears within 5s of an app being ready.

## Phase 4 — Dev-friendly extras  *(F8, F12, F13, F14, F16, F17)*

- Cmd-K command palette (`cmdk`): apps, actions, recent scripts.
- Virtualized log history pane (`react-window` + `anser`) with regex search.
- Restart-on-file-change (off by default, per-app toggle, debounced).
- `devharbor://` deep links.
- `electron-updater` integration + in-app update banner.

**Exit criteria.**
- Cmd+K → "redis" → Enter starts the redis app with its remembered script.
- Editing a `.env` file in any editor surfaces a Reload banner within 500ms.
- A new release on the feed produces an update banner on next launch.

## Phase 5 — Package & ship  *(macOS only for v1)*

- `electron-builder` config: DMG, hardened runtime, entitlements.
- Code signing (Developer ID) + notarization (`@electron/notarize`).
- Icon set, About dialog, Sparkle-style version string.
- Auto-update feed (GitHub Releases first; document the path to S3/CloudFront).
- DMG installs cleanly on a fresh user account.

**Exit criteria.**
- Download DMG → drag to Applications → first launch passes Gatekeeper with no warnings.
- App auto-updates from v0.1.0 → v0.1.1 with no user intervention beyond a quit & relaunch.

## Stretch — post-v1

Tracked but not in v1 scope:

- Docker Compose integration (`dockerode`, parse compose, treat services as pseudo-apps).
- Per-app keychain-backed secrets (`keytar`).
- Multi-app "scenes" — named bundles of *Apps* (across the registry) to start together. (Within-app multi-process is Phase 1.5.)
- Plugin loader from `userData/plugins/`.
- Windows + Linux validation.
- Built-in API request runner for the detected port.

## Cross-cutting policies that apply from Phase 0

- **Strict TypeScript.** `strict: true`, no `any` without comment, `noUncheckedIndexedAccess`.
- **Lint + format on save.** Biome (or ESLint + Prettier — TBD in scaffold).
- **No global IPC channels** — every call goes through the typed `window.api` surface.
- **No process.env reads in the renderer.** Settings are pulled via IPC.
- **Tests.** Vitest for pure modules (NodeResolver, PMDetector, env layering). Playwright (Electron mode) for one happy-path integration test per phase. No 100% coverage goal — test the gnarly bits.
- **CI.** GitHub Actions for typecheck + tests on PR; release workflow tagged `v*` builds the DMG.
