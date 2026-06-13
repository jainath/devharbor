# 03 - Features

Each feature has: a one-line summary, behaviour, edge cases, and acceptance criteria. Features are grouped by area. Phase tags (P1-P4) match [`05-roadmap.md`](05-roadmap.md).

---

## F1. Register a local app  *(P1)*

**Summary.** Browse to a directory; we register it and run detection.

**Behaviour.**
- "Add App" (sidebar APPS-header `+` icon + Cmd-K) opens a native folder picker (`dialog.showOpenDialog`).
- On selection, validate: directory exists, contains a `package.json` (warn but allow if not - useful for vanilla Node scripts).
- Run `DetectionService.detect(path)` and pre-fill: name (dir basename), package manager (lockfile + `packageManager` field), node version (`.nvmrc` / `.node-version` / `engines.node`), discovered scripts, discovered `.env*` files.
- **Add drawer fields (Phase 10):** the confirmation drawer is fully editable before save:
  - **Name** - defaults to dir basename.
  - **Node version** - `NodeVersionPicker` (Auto / System / explicit installed version). Defaults to `auto`; a hint shows the project's pinned version if `.nvmrc`/`engines.node` was detected ("recommend based on the code").
  - **Package manager** - dropdown pre-selected to the auto-detected PM (from lockfile / `packageManager` field), with an explicit "Auto-detect each run" option and manual npm/yarn/pnpm/bun overrides.
  - **Default script → first task** - the chosen script is **materialised into the app's first Task on save**, so the app is immediately startable. (Pre-Phase-10 bug: the script was only stored on the app row and no task existed until the next app restart, so Start failed with "No enabled tasks." Fixed by creating the task via `tasks:add` during the add flow.) Choosing "don't create a task yet" is allowed for apps with no obvious entry script.
  - **Environment variables (optional, collapsed)** - paste a `.env` blob; applied at the app scope on save (secret keys auto-masked).
- Auto-assign a sidebar color from a fixed palette of 12; user can change later.

**Edge cases.**
- Path already registered → focus that app instead of erroring.
- Symlink → resolve to realpath before storing.
- Path inside a monorepo (has `pnpm-workspace.yaml` or `workspaces`) → offer to register either the root or a chosen workspace package; show a "this is a workspace" badge.
- No `package.json` → register as "scripts only"; the drawer shows "No scripts detected" and the user adds a task (script or custom command) after creating.

**Acceptance.**
- Add an app, see it appear in the sidebar.
- Detected values are right for a vanilla CRA/Vite/Next project without any clicks.
- Adding a path that's already registered jumps to it instead of duplicating.
- **After adding with a default script selected, pressing Start works immediately** - a task exists, no "No enabled tasks" error.
- The package manager dropdown reflects the detected PM by default; overriding to e.g. `bun` persists on the app.

---

## F2. Detect & resolve Node version  *(P1)*

**Summary.** Figure out which Node version to use for each app, and resolve it to an absolute `node` binary path.

**Behaviour.**
- `NodeResolver` scans on app boot and caches:
  - `~/.nvm/versions/node/*`
  - `$NVM_DIR/versions/node/*` (if set)
  - `~/.fnm/node-versions/*/installation`
  - `~/.volta/tools/image/node/*`
  - `~/.asdf/installs/nodejs/*`
  - `which node` for the system Node
- For each registered app, the `nodeVersionPref` is one of:
  - `auto` (default): read `.nvmrc` / `.node-version`; fallback to `engines.node` (use semver minimum match against installations); fallback to highest installed LTS.
  - `system`: whatever `node` resolves to in the user's standard PATH.
  - `explicit`: a version string chosen from the UI dropdown of detected installations.
- Re-run resolution on every start (cheap; filesystem scan is fast).
- If the desired version is not installed, block start and show: "v20.11.0 is required but not installed. Install with: `nvm install 20.11.0`" with a copy button.

**Edge cases.**
- `.nvmrc` contains an alias like `lts/iron` → support common aliases (`lts/*`, `node`, `stable`) by consulting `~/.nvm/alias/` files if present; otherwise prompt.
- Multiple version managers installed → list union, deduplicate by `version`, mark each with its source.
- User has none of nvm/fnm/volta/asdf and no system Node → first-run helper card with install instructions.

**Acceptance.**
- An app with `.nvmrc=20.11.0` starts with that exact version on PATH.
- An app with `engines.node=">=18 <21"` and installations `18.20.0`, `19.9.0`, `21.0.0` picks `19.9.0`.
- Removing the installed version and clicking Start surfaces a blocking error with the install command - no silent fallback.

---

## F3. Detect & use package manager  *(P1)*

**Summary.** Pick the right package manager per app.

**Behaviour.**
- Use `package-manager-detector` to inspect lockfiles + `packageManager` field + `devEngines.packageManager`.
- Cache result on the app row; allow override in the app's Config panel.
- For each start, build the actual command:
  - npm: `npm run <script>`
  - yarn: `yarn <script>` (yarn 1 and modern both work with bare script names)
  - pnpm: `pnpm run <script>` or `pnpm <script>`
  - bun: `bun run <script>`
- Bun is supported only if a `bun` binary is on PATH; otherwise show a warning at detection time.
- Custom command override: user can write any shell line (e.g. `npx tsx watch src/server.ts`); we still use the PTY and the layered env.

**Acceptance.**
- pnpm-lock.yaml present → pnpm. yarn.lock → yarn. package-lock.json → npm. None → ask once, remember.
- `packageManager: "pnpm@8.15.0"` in package.json takes precedence over lockfile.

---

## F4. Start / stop / restart  *(P1 for single-task; P1.5 for multi-task)*

**Summary.** Lifecycle controls for a single app or many at once. From Phase 1.5 onwards "start an app" means "run the app's task graph in order."

**Behaviour.**
- Per-app Start button:
  - If the App has exactly one task, runs it immediately.
  - If multiple tasks, the orchestrator topo-sorts by `depends_on` and starts in order; within a topological level, by `position`. Each task must hit its readiness signal (see [F19](#f19-multi-task-orchestration-p15)) before dependents start.
  - If no enabled tasks, opens the script picker to create one inline.
- Per-task Start button (in the task tab strip): starts that one task only. Does not auto-start dependencies; surfaces a warning if deps aren't ready.
- Stop button:
  - App-level: reverse-topo over running tasks. For each task: SIGTERM the PTY's process group → after `kill_grace_ms` SIGKILL the group → `tree-kill` fallback by root PID.
  - Per-task: same kill sequence for just that task.
- Restart = stop + wait for `exited` + start with the same task set.
- Header bar shows the **app-level** state pill (derived from task states per [02-data-model.md](02-data-model.md)) + uptime since first task started.
- "Start all" / "Stop all" actions in the dashboard, also via Cmd-K.

**Edge cases.**
- Start while already running → no-op with a toast "already running."
- Start while *some* tasks running, others idle → orchestrator picks up where it left off (starts only the idle tasks whose deps are ready).
- Kill failure (process won't die after SIGKILL) → expose the PID with a "show in Activity Monitor" action.
- Long-lived task exits unexpectedly while dependents are still starting → cancel the start, mark app `crashed`, surface which task failed and its last 200 lines.
- A one-shot task exits non-zero → block dependents; mark app `crashed`.
- User stops while orchestration in progress → cancel pending starts, kill what's already up in reverse-topo.

**Acceptance.**
- Killing `npm run dev` reliably stops the underlying node server and any nodemon/concurrent workers - `lsof -i :3000` is empty within 6s.
- A multi-task app: `migrate` (one-shot) → `api` (port:4000) → `web` (port:3000). Start it. `migrate` runs to exit 0, then `api` spawns, listens on 4000, then `web` spawns. Stopping the app stops `web` first, then `api`. No orphans.
- Crashed apps stay visible (don't disappear) until acknowledged or restarted.

---

## F5. Script picker  *(P1)*

**Summary.** Choose what to run when creating a task - from `package.json` scripts or a custom command.

**Behaviour.**
- Surfaces in two places: (a) the App header for a single-task app (changes that task's script in place), (b) the task editor when adding/editing a task.
- Lists every entry from the task's resolved `package.json` scripts (using `working_dir_override` if set, else `app.path`), showing key + command preview.
- Filter by typing.
- Pin a default per task; for single-task apps this is also the App's "remembered" choice.
- "Custom…" entry opens a text input for a raw command (becomes a `commandKind=custom` task).
- Recently-run scripts appear pinned at the top.

**Acceptance.**
- Picker opens in <100ms even with 50 scripts.
- Picking "dev" on a single-task app then pressing Cmd+Enter runs `dev` without re-opening the picker.

---

## F6. Env vars (global + per-app + per-task)  *(P3; per-task added Phase 7)*

**Summary.** Three-tier layered env editor - global defaults, per-app overrides, per-task overrides - with `.env` file integration.

**Why three tiers (and not two).** App-level env is still essential: shared values like `DATABASE_URL`, `AUTH_SECRET`, `STRIPE_KEY` belong to the whole app, not any single task. Task-level is for values that differ between the tasks of one app (most commonly `PORT`, but also `SERVICE_URL` pointing one task at another, or per-task feature flags). Without a task tier users were forced to either (a) duplicate vars across `customCommand` env prefixes, or (b) ship `.env.local` files with mixed concerns.

**Behaviour.**
- **Three-tab editor**: **Global**, **App · {name}**, **Task · {name}**. The Task tab only appears when the editor was opened with a task context (from the task tab's right-click menu, from TaskEditor's "Env" affordance, or by clicking the task strip in the EnvEditor itself). Single-task apps may still open the Task tab - useful if you want to keep app-level shared vars separate from one task's `PORT`.
- Same table shape on all three: `[enabled] KEY = VALUE [is_secret] [note] [⋯]`.
- Per-row toggle for `enabled`. Secret rows render value as `••••••` until "show" is clicked.
- **Inheritance hints**: the App tab shows `⤴ overrides global` next to keys also defined globally. The Task tab shows `⤴ overrides app` *and* `⤴ overrides global` chips next to overridden keys. Effective-merged preview pane lists all three layers stacked.
- Bulk paste: paste a `.env` blob → parsed → merged into the active scope's rows. Secret-detection regex auto-flags `SECRET|TOKEN|PASSWORD|KEY|PRIVATE`.
- Export: copy the effective merged env (process + global + app + task + .env) as a `.env` blob, with `#!override-app` / `#!override-task` comments noting where each value came from.
- Side panel: read-only list of `.env*` files found in the project, with last-modified.
- "Save .env file changes to disk" mode (off by default) lets edits write back to `.env.local`.

**Data model.** Phase 7 added a `task_id` column on `env_vars`. Three scopes: `(app_id IS NULL AND task_id IS NULL)` global, `(app_id = ? AND task_id IS NULL)` app, `(task_id = ?)` task. See `02-data-model.md`. The legacy `tasks.env_overrides` JSON column was migrated once and is now ignored at runtime.

**Edge cases.**
- Variable references like `BASE=${HOME}/foo` resolve via shell at spawn time (we don't run `dotenv-expand`); leave references unresolved in storage so they update with their referent.
- Conflicting keys across scopes: later wins (task > app > global > process). Effective preview always reflects this.
- Deleting an app cascades both its app-scoped and all its task-scoped env rows. Deleting a task cascades only task-scoped rows.

**Acceptance.**
- Set `PORT=4000` on the `api` task and `PORT=5173` on the `web` task → starting the app sees each task get its own port without touching app- or global-level env.
- Set `DEBUG=app:*` globally, `DEBUG=app:auth` on the app, `DEBUG=app:auth:trace` on one task → that one task sees `app:auth:trace`; other tasks of the same app see `app:auth`; other apps see `app:*`.
- Touching `.env.local` in Finder triggers a banner: "`.env.local` changed on disk - reload?"

---

## F7. Live logs (per app)  *(P2)*

**Summary.** Each running app has a real terminal pane with its full output.

**Behaviour.**
- Backed by `@xterm/xterm` with `fit`, `webgl`, `search` addons.
- Ring buffer in main (10k lines default); on tab switch, the buffer is replayed into xterm in one batched `write`.
- Scrollback grows up to `log_ring_size` then evicts oldest.
- Toolbar: search (Cmd+F), clear, copy all, save to file, autoscroll toggle, font-size +/-, "follow new output" sticky toggle.
- ANSI color, cursor moves, and TUI redraws (Vite, Next, nodemon banners) all render correctly.

**Edge cases.**
- Output bursts (>1MB/s, e.g. a noisy logger) → coalesce IPC chunks at the main side (max 30Hz / batch by size) so the renderer never blocks.
- Long lines (>10kB) → truncate in the ring buffer for memory safety; show "[line truncated]" indicator.

**Acceptance.**
- Vite's "ready in 432ms" banner renders identically to a real terminal.
- A 30-second burst of dense log output keeps the UI at 60fps and never drops a line.

---

## F8. Searchable log history  *(P4)*

**Summary.** A virtualized, searchable, ANSI-styled view of the same task ring buffer that powers the Live xterm. Accessed via the `[Filter]` pill inside the Logs view (not a separate top-level tab - collapsed in the post-v1 polish).

**Behaviour.**
- Backed by `react-window` + `anser`.
- Plain-text or regex search; case-sensitive toggle; match count.
- Switches the Logs pane content; the `[Live]` pill returns to xterm.
- Optional "save to disk" per app (writes `<userData>/logs/<appId>/<runId>.log`) - feature toggle in Settings is wired but the actual disk-write code is deferred.

**Acceptance.**
- Searching for `ECONNREFUSED` across a 10 k-line buffer returns matches in <50 ms.
- Switching `[Live] → [Filter] → [Live]` preserves the underlying buffer (xterm replays on return).

---

## F9. Dashboard / home screen  *(P3; redesigned Phase 7 / Phase 13)*

**Summary.** The **control room** - an aggregate "machine load" stat strip plus a stable card grid for every registered app. Deliberately distinct from the sidebar (the navigation *switcher*). **Card height is invariant across state transitions** - clicking Start never makes anything below jump.

**Behaviour.**

- **Aggregate stat strip (Phase 13)** - four tiles summing across all running tasks: Running (`N / M`, teal when > 0), CPU %, Memory (MB, rolls to GB past 1024), Open ports. This is the dashboard's unique value vs the sidebar.
- ~~**Recent strip**~~ - **removed Phase 13.** It re-listed apps the sidebar and grid already show; recency quick-access is covered by the sidebar + ⌘K. `RecentStrip.tsx` deleted.
- **All-apps grid** - stable **alphabetical** order. Cards never auto-reorder on state changes; the user's click target stays put. **Running apps are emphasised in place** - teal inset left edge + lifted surface - never reordered, no layout shift.
- One card per app: status dot, name, state pill (RUNNING / EXITED / IDLE / CRASHED), task count, running count, CPU%, memory MB, thin CPU progress bar, port chips.
- **Layout-stable port row (Phase 7)** - every card reserves a fixed-height port-chip row even when the app is stopped (renders an `IDLE` em-dash placeholder chip per task, or just "no ports yet" placeholder text at the same height). Reserved space prevents the card from growing/shrinking when ports come and go. The whole card has a stable min-height so cards in the same row align.
- Click a card name → open that app's detail view.
- **Toolbar**: `[Filter by tag ▾]  [Stop all]`. Start-all removed by request - too easy to misfire across many apps.
- **⌘ R / cold boot always lands on Dashboard**.
- **Sidebar Dashboard entry** shows a green badge with the running-apps count.

**Acceptance.**
- With 5 running apps, the dashboard updates CPU/RAM at 1Hz with <2% CPU overhead of its own.
- Starting an app from the dashboard does not visually shuffle cards in the grid **and does not change the card's height**. A pixel-level diff of card bounding boxes across `IDLE → starting → running → exited` shows zero vertical motion (modulo the port-chip text content swapping in place).
- Toggling theme in Settings flips the dashboard immediately (status colors and surfaces both adapt).

---

## F10. Port detection + clickable links  *(P3)*

**Summary.** Detect which TCP port each task is listening on; expose as clickable chips labeled by task name.

**Behaviour.**

- **Two-pronged detection** (results unioned, not exclusive):
  - **Stdout parsing** - `localhost:<port>` / `http(s)://[host]:<port>` / `listening on [port] N` patterns. Adds to a per-task `hinted` set.
  - **lsof poll** every 2 s - `lsof -nP -iTCP -sTCP:LISTEN -a -Fpn -p <pids>` over the task's process tree (walked via `pgrep -P` to depth 5: covers `npm → cross-spawn shell → tsx/nodemon → user binary`).
  - **Immediate first tick on `track()`** - no 2 s lag for quickly-listening processes like Vite.
- **One chip per task** (running OR registered), always with task-name prefix (`<taskName> :<port>`). Tasks with no detected port show a muted `<taskName> - ` placeholder. **Phase 7**: the chip row is always rendered with reserved height, so the surrounding card/header doesn't reflow when an app starts. When the app is fully idle (no task running), the row shows one placeholder chip per registered task at the same height as the running version.
- Chips render in **two places**: Dashboard cards, and the App Detail header (on their own row below the path, for breathing room with multi-port apps).
- Click opens `http://localhost:<port>` externally via `shell.openExternal` (URL scheme allowlist: `http:` / `https:` only).

**Edge cases.**

- Task listens on multiple ports → all chips render (Dashboard caps at 6 with `+N` overflow; App Detail wraps).
- Port closes (server crashed mid-run) → chip drops on next renderer state-change tick (`taskState === 'running'` filter).
- Task that hints a port but never binds (e.g. crashes after printing "starting on 4000…") → chip shows (union of hinted), drops when the task transitions out of `running`.

**Acceptance.**

- Single-task app (Astro): within 5 s of `npm run dev` printing "Local: http://localhost:4321/", a `dev :4321` chip appears.
- Multi-task app: each running task gets its own chip with its name. A task that fails to bind shows `<taskName> - ` (not blank).

---

## F11. CPU & memory per process  *(P3)*

**Summary.** Per-app CPU% and resident memory.

**Behaviour.**
- `pidusage` polls each running process group every `dashboard_refresh_ms` (default 1s).
- Pushed to renderer via `proc:stats`.
- 60-second sparkline retained in renderer for the dashboard card.

**Acceptance.**
- Numbers match `top`/`Activity Monitor` within ~1%.

---

## F12. Command palette (Cmd-K)  *(P4)*

**Summary.** Keyboard-driven access to every action.

**Behaviour.**
- Built on `cmdk`.
- Sections: Apps (jump to), Actions (start/stop/restart), Recent scripts, Settings.
- Fuzzy match across all sections.
- Global shortcut: Cmd+K (Cmd+Shift+K reserved for "advanced" / settings deep links).

**Acceptance.**
- Cmd+K → type "redis" → Enter starts the app whose name contains "redis," whichever was the last script.

---

## F13. .env file watching + reload prompt  *(P4)*

**Summary.** Detect filesystem changes to `.env*` files in registered project dirs.

**Behaviour.**
- One `chokidar` watcher per registered app, restricted to `.env`, `.env.local`, `.env.development`, `.env.${NODE_ENV}` and equivalents.
- On change while app is running: non-modal banner "Env file changed. Restart to apply." with a "Restart" button.
- On change while app is idle: just refresh the env preview pane.

**Acceptance.**
- Editing `.env` in any editor produces a banner within 500ms.

---

## F14. Restart-on-file-change  *(P4, off by default)*

**Summary.** Opt-in nodemon-style restart for apps that don't have their own watcher.

**Behaviour.**
- Per-app toggle + glob list (default `src/**/*.{ts,tsx,js,mjs}`).
- Debounced 500ms; consecutive saves coalesce.
- Logs a `--- restarting due to file change ---` marker into the terminal.

**Acceptance.**
- Saving `src/index.ts` triggers exactly one restart within 1s; saving 5 files in a row triggers exactly one restart.

---

## F15. Crash handling + run history  *(P3 - partial in v1)*

**Summary.** Surface non-zero exits prominently. Run-history data is persisted to the DB for future tooling but **not surfaced in the UI** in v1.

**Behaviour.**
- On crash: state goes `crashed`, exit code shown, last 200 lines of log pinned above the live terminal via `CrashPin` (Restart + Dismiss inline).
- `run_history` table populated on every task start/stop (one row per task per run). Includes started_at, ended_at, exit_code, exit_signal, was_killed_by_user, node_version, package_manager, command, script.
- ~~Per-app "History" tab~~ - **dropped from the UI**. The previous tab was a glorified audit log that didn't earn its real estate; CrashPin covers the "why did this just crash" workflow, and "rerun" lives on the task tab strip. The `HistoryView.tsx` component was **deleted in the Phase 11 dead-code cleanup**; run data is still recorded and remains readable via the `runs:list` IPC for a future log-explorer feature.

**Acceptance.**
- Killing the underlying process from outside (`kill -9`) shows up as `crashed` with no signal misattribution.
- CrashPin auto-resets on task switch and on the next crash of the same task (no sticky dismissal across re-runs).

---

## F16. Deep links (`devharbor://...`)  *(P4)*

**Summary.** Other tools can register apps or trigger actions via URL.

**Behaviour.**
- Register custom protocol on macOS.
- Supported actions:
  - `devharbor://open?path=/abs/path` - focus the app for that path (or offer to register if unknown).
  - `devharbor://start?id=<appId>` - start the named app.

**Acceptance.**
- Pasting `devharbor://open?path=$PWD` from a terminal opens the matching app.

---

## F17. Auto-update  *(P4)*

**Summary.** Self-update via electron-updater.

**Behaviour.**
- On launch, check GitHub Releases (or configured feed).
- If newer: download in background, show a non-blocking banner "Update ready - quit & install."
- Setting to disable.

**Acceptance.**
- A new release on the feed leads to a banner within the next launch.

---

## F18. Settings  *(P3)*

**Summary.** Per-app overrides live on the app; global settings live in their own pane.

**Sections.**
- General: theme, auto-update, dashboard refresh rate.
- Logs: ring size.
- Processes: kill grace ms, default SIGTERM-then-SIGKILL.
- Node detection: which directories to scan; manual add of a custom Node binary.
- Danger zone: export DB (zip), import DB, reset.

---

## F19. Multi-task orchestration  *(P1.5)*

**Summary.** An App is a collection of one or more ordered Tasks. Each Task has its own process, command, working dir, env overrides, and readiness signal. Tasks declare dependencies; the orchestrator starts them in topological order and stops in reverse.

This is the foundation for: monorepos (one task per workspace), single-repo multi-process apps (e.g. `migrate` → `api` → `web`), and any "X must be up before Y" workflow.

**Concepts.**

- **Task** - a unit of work, see [02-data-model.md](02-data-model.md). Has `commandKind` (`script` or `custom`), optional working dir / package manager / Node version override (for monorepo workspaces), `dependsOn`, `readiness`, `oneShot` flag.
- **Readiness signal** - when has this task "completed startup"?
  - `none` - proceed immediately after spawn (default, current Phase 1 behaviour).
  - `port:N` - wait until the task's process group is listening on port `N`. Implementation: `lsof -iTCP -sTCP:LISTEN -P -n` filtered by PID group, polled every 500ms.
  - `log:/regex/` - wait until a stdout chunk matches. Useful for "ready in Xms" banners or anything not bound to a port.
  - `exit:0` - task is `oneShot`; ready means it exited with the expected code. Required for any `oneShot` task.
  - `delay:N ms` - fixed timer, last-resort fallback.
- **Dependency graph** - `dependsOn` is a DAG. Cycles rejected at save time with a clear error citing the cycle. Tasks at the same topological level start in parallel, in `position` order for UI determinism.

**Behaviour.**

- **App start** - topo-sort enabled tasks. For each task in order: wait for all deps' `ready` events, then spawn. Per-task PTY, per-task log stream, per-task status events.
- **App stop** - reverse-topo over running tasks. SIGTERM → grace → SIGKILL on the process group; `tree-kill` safety net.
- **Per-task Start/Stop** - exposed in the task tab strip. Manual single-task start does NOT auto-resolve dependencies; surfaces a warning if deps aren't ready.
- **App-level state** - derived from task states per the table in [02-data-model.md](02-data-model.md). The worst task wins.
- **Crash blast radius** - if a non-one-shot task crashes mid-orchestration, cancel pending starts but leave already-started tasks alone (so you can inspect their logs). User decides whether to restart or stop the partial set.

**Edge cases.**

- A `oneShot` task that hangs without exiting → user can manually stop it; orchestrator does not auto-time-out (use `readiness.delay` for that).
- Dependency on a `oneShot` that already ran in a previous start → on restart, the orchestrator re-runs it; we don't persist "ready" across restarts (predictable beats clever).
- Workspaces in a monorepo: set `working_dir_override` per task to point at `apps/api`, `apps/web`, etc. Detection happens against that subdir.
- Disabled tasks are ignored by the orchestrator but stay visible in the tab strip with a greyed-out state.

**Acceptance.**

- An App with `migrate` (oneShot, `exit:0`) → `api` (`port:4000`) → `web` (`port:3000`, depends on api). Start. `migrate` runs first to exit 0. `api` spawns, hits :4000. Only then `web` spawns. Stop reverses the order. No port left listening within 6s of stop.
- A monorepo App with three tasks pointing at `apps/api`, `apps/web`, `packages/shared` (the latter `oneShot build`). `shared` runs first; `api` and `web` start in parallel after.
- Adding a cycle (`api dependsOn web`, `web dependsOn api`) at save time produces an error with the cycle path, no save.
- One task crashing during orchestration cancels pending starts; logs from started tasks are preserved.

---

## F20. Per-app and per-task Node version selection  *(post-Phase-6 UI; data model existed since Phase 1)*

**Summary.** Pick which installed Node version each app (and optionally each task) uses, without leaving the UI.

**Behaviour.**

- **App default** lives in `App.nodeVersionPref`, set via `AppConfigDrawer`'s **Node version** field.
- **Task override** lives in `Task.nodeVersionPrefOverride`, set via `TaskEditor`'s Node version field. Has an extra "Inherit from app" choice (stored as `null`).
- **Three preference kinds**:
  - `auto` - `NodeResolver` reads `.nvmrc` → `.node-version` → `engines.node` from the task's working dir at start time. Standard nvm workflow.
  - `system` - `which node` resolved on the user's PATH.
  - `explicit { version }` - a specific installed version chosen from the dropdown.
- **NodeVersionPicker component** queries `node:list` IPC, which scans `~/.nvm`, `~/.fnm` (3 known paths), `~/.volta`, `~/.asdf`, plus system Node. Versions are deduped across managers; sources displayed (`v20.11.0 · nvm, fnm`).
- **At task start**, `NodeResolver.resolve(pref, workingDir)` returns a `NodeInstallation { source, version, binDir }`. The bin dir is prepended to the spawned task's `PATH`, so the child sees the right `node` / `npm` / `npx` first.
- **No `nvm use` shell magic** - we bypass the shell function entirely by picking the binary off the filesystem.

**Edge cases.**

- Chosen version not installed → start blocked with a clear error: *"Node v20.11.0 is not installed. Install it (e.g. `nvm install 20.11.0`) and retry."* No silent fallback.
- `.nvmrc` alias like `lts/iron` → currently errors with "version not installed" (no lts alias resolution yet). Carry-list.
- Major-only version in `.nvmrc` (e.g. `20`) → resolves to highest installed 20.x.

**Acceptance.**

- App with `.nvmrc=20.11.0` and that version installed → starts with v20.11.0 on PATH.
- App default = v20, task override = v18 → that task spawns under v18, others under v20.
- Removing the desired version then clicking Start → blocking error, no silent fallback.

---

## F21. Folders in the sidebar  *(Phase 8)*

**Summary.** Optional one-level visual grouping of apps in the sidebar. Each app belongs to zero or one folder. Tags remain orthogonal - folders are hierarchy, tags are facets.

**Why not nesting / why not "use tags".**
- *Nesting:* 95% of dev-tool sidebars (VS Code workspaces, Postman, TablePlus) get away with one level. Schema today is `folder TEXT`; if we later want nesting we change one column to `folder_path TEXT` and split on `/`. Don't pay the complexity now.
- *Tags-as-folders:* an app belongs in one folder but can have many tags. Forcing "primary tag = folder" makes both concepts worse. Distinct fields, distinct UX.

**Behaviour.**

- **Data**: `apps.folder TEXT` (NULL = ungrouped). Migration `0005_app_folders.sql` adds the column; existing apps default to NULL and surface in the "(Ungrouped)" section.
- **Sidebar render** - apps grouped by folder, folders sorted alphabetically (case-insensitive), "(Ungrouped)" pinned to the bottom. Each section has a `▾ Name (N)` header that toggles collapse on click. Folder collapse state stored in `localStorage["devharbor:folder-collapse"]` as a JSON object `{ [folderName]: true }` - per-machine, not synced.
- **Move an app** - right-click an app in the sidebar → **Move to folder ▸** submenu with: existing folders, "New folder…" (prompts for name), and "Remove from folder" (if currently foldered). Or set the folder field in `AppConfigDrawer`.
- **Rename a folder** - right-click folder header → **Rename folder…** → prompt. Implemented as one UPDATE across all apps with that folder name; the renamed folder picks up its new alphabetical slot.
- **Delete a folder** - right-click folder header → **Delete folder** → confirm → apps fall back to NULL (move to "(Ungrouped)"). Files on disk are untouched, app rows remain.
- **AppConfigDrawer Folder field** - text input with a datalist autocomplete of existing folder names. Empty value clears the folder.
- **Empty state** - if no app has a folder, the sidebar renders the flat list it always did. The first time any app gets a folder, the grouped layout kicks in (with "(Ungrouped)" holding the rest).

**Edge cases.**

- Two apps with the same folder name but different case (`Work` vs `work`) → coalesced into one group by case-insensitive key, displayed using the most recently-modified app's casing. Rename via right-click to enforce consistency.
- Folder name is trimmed and capped at 60 chars. Whitespace-only → treated as NULL.
- Filter input (⌘P) filters across folders; matching apps render under their folder, other folders auto-collapse (visual: section header shows `▸ Work (0)` if no matches).
- "(Ungrouped)" is a reserved display label; users can't create a folder named that.

**Acceptance.**

- Three apps with folders `Work`, `Work`, `Personal`, one with no folder → sidebar shows `▾ Personal (1)`, `▾ Work (2)`, `▾ (Ungrouped) (1)` in that order.
- Collapsing `Work` and reloading the app preserves the collapsed state.
- Right-click → Move to folder → "New folder…" → type "Side projects" → app appears under a new `▾ Side projects (1)` section, sorted into place.
- Right-click `Work` header → Rename → "Clients" → both apps move to `▾ Clients (2)`.
- Filter input "auth" with two `Work` apps (one matches) → `▾ Work (1)` shows the match, `▸ Personal (0)` and other folders auto-collapse with zero count.

---

## Stretch (post-v1, not in this spec set)

- Docker Compose integration (treat services as pseudo-apps).
- Multi-app "scenes" - named bundles of *Apps* (across the registry) to start together. (Cross-app orchestration; within-app multi-process is handled by [F19](#f19-multi-task-orchestration-p15).)
- HTTP request runner for the app's exposed port (would step on Postman's toes; deliberately deferred).
- Plugins (let a user drop a JS file in `userData/plugins/` to add commands).
- Per-app keychain-backed secrets.
- Windows + Linux validation pass.
