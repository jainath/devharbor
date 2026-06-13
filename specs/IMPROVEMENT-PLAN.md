# DevHarbor - Comprehensive Review & Improvement Plan

> **Date:** 2026-06-11 · **Reviewed:** v1.0.1 + the uncommitted add-flow redesign (working tree as-is)
> **Method:** a 10-dimension internal audit (security ×2, reliability, data, performance, UX, accessibility, code quality, distribution, product). Every critical/high finding was independently re-verified against the code with the explicit goal of refuting it. **Zero findings were refuted.** Findings marked *(verified)* passed that second check; *(unverified)* items came from a final completeness pass and should be reproduced before fixing - though each cites concrete code.
>
> Severity: how much it hurts users or the project. Effort: **S** < half a day, **M** 1-3 days, **L** larger.

---

## 0. Implementation status (2026-06-11)

This plan was **implemented in the same session** across six waves on branch `fix/improvement-plan`
(see the 2026-06-11 entry in [`PROGRESS.md`](PROGRESS.md) for the full feature list). Gate after the
pass: **typecheck + ESLint (83 files, 0 warnings) + 52 tests + production build all green**; all 7
migrations validated against a real SQLite DB; restart-watcher and double-start-race fixes now have
CI test coverage.

**Done:** all of §4 (urgent), §5 (P1 correctness), §6 (security, except the explicit deferrals below),
§7 (reliability), §8 (data), §9 (performance, except 7.6 below), §10 (UX), §11 (a11y), §12 (hygiene),
§13 (observability/infra, except Homebrew), and §14 product items 1-10 (tray, notifications, quit
confirm, monorepo, bulk import, auto-start/login, folder start-all, port conflicts, global log search,
window bounds).

**Post-implementation review (same day):** a second, equally skeptical review of the change set
itself found 27 regressions/integration gaps in the new code; all were fixed in a follow-up pass.
Highlights: batched-lsof partial-output salvage + zombie filtering in PortDetector (port chips no
longer blank on a stale pid); cancellable starts so Stop/Restart are never queued behind readiness
waits; readiness timeout no longer force-resolves `exit`/`delay` readiness; identity-aware stop
helpers; a dialog STACK in `useDialog` (Escape on a stacked confirm no longer closes the parent
drawer; inner comboboxes keep their Escape via `data-escape-stop`); DialogHost resolves displaced
dialogs instead of hanging their awaits; EmptyState no longer flashes on boot; Sidebar keyboard ⋮
fix + tag-collapse prune fix + case-only-rename fix; ContextMenu no longer steals focus on
outside-click; UpdateBanner surfaces mid-download failures but stays silent on passive offline
checks; log subscriptions reset on renderer reload; tray refreshes on app add/remove/rename;
`Updater.stop()` so disabling auto-update takes effect immediately; login-item state reconciled
FROM the OS instead of clobbering it; quit re-entry during teardown no longer bypasses it;
mid-spawn starts counted/stopped by the quit path; `decMaybe` never destroys undecryptable secrets;
dotenv unterminated-quote degrades to one line (+2 tests); workspace negation globs + flow-style
`packages:` parsing; CrashPin port extraction anchored to the conflict line; pnpm/action-setup → v6
(node24, verified upstream); workflow_dispatch is now a `--publish never` dry-run; `.prettierignore`
added; tooling configs excluded from the asar. Gate after fixes: typecheck + lint + 54 tests +
production build all green.

**Deliberately deferred / partial (honest notes):**
- **13.6 Homebrew cask** - not done (needs an external tap/PR; artifact naming fix landed as the prerequisite).
- **6.8 secrets** - scoped to *encryption at rest* (`safeStorage`); values still decrypt over IPC for the editor (the masking/`env:reveal` UX was judged higher-risk than its marginal benefit on a single-user desktop).
- **Electron fuse `EnableEmbeddedAsarIntegrityValidation`** - left OFF (can fail launch if the integrity header isn't embedded); enable only after a notarized build is confirmed to launch with it. The high-value fuses (RunAsNode/NODE_OPTIONS/inspect, OnlyLoadAppFromAsar) are on.
- **7.6 stats tree-sum** - StatsMonitor still samples the root PTY pid (batched now); summing across the descendant tree is a follow-up.
- **`EnvLayering.test.ts`** still mirrors the *old* `.env`-wins precedence; it's a self-contained pure-function mirror (doesn't exercise the real `EnvBuilder`), so it passes but no longer reflects the shipped precedence - worth rewriting against the real builder.
- **Signed/notarized build** not produced here (no signing identity in this environment): the fuses + entitlement-trim changes need one real signed build to confirm launch + native-module loading before the next release.
- **11.x polish remainder** - the big structural a11y fixes shipped; finer contrast-token tuning and `prefers-reduced-motion` sweeps remain incremental.
- **`pnpm format` over the tree** - `.prettierignore` is in place, but `format:check` still flags ~60 src files (the codebase predates the config). Run `pnpm format` as a dedicated, format-only commit and then add `format:check` to CI; mixing it into this functional diff would have doubled its review surface.

---

## 1. What DevHarbor is (context for any new contributor)

DevHarbor is a signed, notarized, auto-updating Electron 33 + React 18 + TypeScript macOS app: a local supervisor for Node.js dev servers. It registers project folders, detects package manager / Node version / scripts, runs multi-task apps in dependency order with readiness probes, and gives live logs (xterm), CPU/mem stats, port detection, layered env vars (global → app → task → `.env` files), folders/tags, a ⌘K palette, deep links (`devharbor://`), and GitHub-Releases auto-update. Main-process services own all process truth; the renderer is a view over typed IPC.

## 2. Where the app stands - strengths worth protecting

The review confirmed a lot of genuinely good engineering (worth stating so fixes don't regress it):

- **Electron hardening is above-average:** `contextIsolation` + `sandbox` + `nodeIntegration:false`, `script-src 'self'` CSP, origin-checked `will-navigate`, `setWindowOpenHandler` that only forwards http(s), webview blocked, channel-whitelisted preload.
- **Main process discipline:** every SQL statement is prepared/bound, FK constraints with cascades and `foreign_keys=ON`, WAL mode, per-migration transactions; all non-user command execution uses `execFile`/argv arrays (no shell interpolation); deep-link `start` is confirm-gated.
- **Real performance engineering in hot paths:** PTY logs coalesced (33 ms / 16 KB) before IPC, memoized dashboard cards, bounded log rings.
- **Strict TypeScript** (`noUncheckedIndexedAccess`, near-zero `any`), typed IPC surface, 47 green tests on the gnarly bits, honest specs.

The dominant theme of what's wrong: **failure paths**. Happy paths are polished; error paths are silent, stuck, or lossy.

---

## 3. Headline issues (the short list)

| # | Issue | Sev | Effort | Status |
|---|-------|-----|--------|--------|
| 1 | GitHub Actions Node 20 → 24 forced cutover **June 16 (5 days)**; release.yml is the only ship path and untested on node24 | high (time) | S | verified |
| 2 | Restart-on-change is **silently dead**: chokidar 5 dropped glob support; watcher never fires | high | M | verified + reproduced |
| 3 | Apps that have **ever run can never be removed** (sticky `exited` state vs `!== 'idle'` guard); sidebar remove fails silently | high | S | verified + reproduced |
| 4 | `TaskRunner.start()` races: double-spawn + stale exit-handler can corrupt a live run's state | high | M | verified |
| 5 | Failed start strands app in permanent "Starting"; start/stop errors invisible everywhere except AppDetail | high | M | verified |
| 6 | Task-scoped env override of an app-scoped key **cannot be saved** (`UNIQUE(app_id,key)` from 0001 survived 0004); breaks env panel permanently for affected tasks | high | M | verified |
| 7 | EnvEditor silently discards unsaved edits (close / task switch / cross-tab save) | high | M | verified |
| 8 | Quit (incl. auto-update install) kills running servers abruptly - bypasses the graceful-stop machinery entirely | high | S-M | verified |
| 9 | `db:export` / `db:reset` ignore the WAL file - backups can miss nearly all recent data; reset leaves an orphaned WAL | high | S | unverified - reproduce first |
| 10 | dotenv parser mangles multiline values, `export` prefix, and `KEY="x" # comment` - and the mangled value *wins* over the framework's own parse | high | S | unverified - reproduce first |

---

## 4. Urgent - do this week

### 4.1 Bump release workflow actions before the June 16 node24 cutover *(S, verified)*
`release.yml` pins `actions/checkout@v4`, `setup-python@v5`, `pnpm/action-setup@v4`, `setup-node@v4`, `upload-artifact@v4` - all run on the Node 20 runtime that GitHub force-migrates to node24 on **2026-06-16**. Because there is no CI, the first run under node24 would be a real signing/notarization release. Bump to node24-native majors (`checkout@v5`, `setup-node@v5`, `setup-python@v6`, `upload-artifact@v5`; verify pnpm/action-setup) and exercise once via `workflow_dispatch` with `--publish never` semantics (see 13.3) before the deadline.
Files: `.github/workflows/release.yml`

---

## 5. P1 - Correctness bugs (suggested scope for v1.0.2)

These are shipped-feature breakages; all *(verified)* unless noted.

### 5.1 Restart-on-change watcher is dead *(high, M)* - reproduced during review
[RestartWatcher.ts:26](../src/main/services/RestartWatcher.ts) passes glob patterns (`src/**/*.{ts,tsx,...}`) straight to `chokidar.watch`, and glob strings to `ignored`. Installed chokidar is **5.0.0**; glob support was removed in v4. The patterns are treated as literal non-existent paths → the watcher never fires. Empirically confirmed: zero events on file changes before the fix.
**Fix:** watch the app directory with a **function** `ignored` (path-segment checks or picomatch for node_modules/.git/dist), filter emitted paths against the configured globs with picomatch. ⚠️ A naive "watch the whole dir" fix without working ignores would recursively watch node_modules - pair the two. Add a real-FS test that touches a temp file and asserts the `restart` event.

### 5.2 Apps can never be removed after they've run *(high, S)* - reproduced during review
[ipc/index.ts:174](../src/main/ipc/index.ts) guards `apps:remove` with `appState(id) !== 'idle'`, but the sticky-outcome design (lastOutcome + boot seeding from run_history) means any app that ever ran reports `'exited'`/`'crashed'` forever. AppDetail shows the misleading "Stop the app before removing it."; the Sidebar ⋮ remove swallows the rejection in `console.error` - the user confirms the danger dialog and *nothing happens*.
**Fix:** block only live states (`running | starting | exiting`); clear `lastOutcome` on remove; surface the rejection in Sidebar (toast/confirm host). Add a vitest for remove-after-run.

### 5.3 `TaskRunner.start()` double-spawn race + exit-handler identity confusion *(high, M)*
The `isRunning` check and `tracked.set` are separated by `await env.build(...)` - two concurrent starts (restart-watcher + user click; `proc:start` + `task:start`) both pass the guard and both spawn PTYs. Also `'exiting'` is not treated as running, so starting during the kill-grace window overwrites a live entry. The orphaned PTY's `onExit` then looks up by task id and mutates the *successor* run - marking a healthy process exited, finalizing the wrong run_history row, untracking live stats/ports.
**Fix:** synchronous in-flight marker set before any `await`; treat `'exiting'` as not-startable (or await the pending stop); in `onData`/`onExit`/cleanup compare `tracked.get(task.id) === tracked` (closure identity) before mutating.
Files: `src/main/services/TaskRunner.ts:131-272`

### 5.4 Failed start strands the app in permanent "Starting" *(high, S)*
`AppOrchestrator.startApp` emits `'starting'` then runs the level loop with no try/catch - if `runner.start` throws (folder moved, Node pin missing, env build failure) the terminal status never fires. UI shows amber "Starting" forever with a Stop button for a process that never spawned.
**Fix:** wrap the level loop; on error emit a terminal `proc:status` (crashed, or a new `'failed'` state with message) before re-throwing - same pattern the RestartWatcher error path already uses.
Files: `src/main/services/AppOrchestrator.ts:119-157`

### 5.5 Start/stop failures invisible outside AppDetail *(high, M)*
Only AppDetail catches lifecycle errors. Dashboard cards, ⌘K palette (which closes immediately), Sidebar ⋮, TaskTabs, and the env-changed banner all `void`-discard rejections. NodeResolver produces *good* error messages ("Node vX is not installed…") that no one ever sees.
**Fix:** one global error surface (toast/banner at App.tsx root, like PromptModalHost) + route all lifecycle calls through a shared store helper instead of raw `void invoke(...)` at 8+ call sites. Pairs with the typed-error envelope (12.3).

### 5.6 Task-level env overrides impossible to save *(high, M)*
Migration 0004 added `task_id` to `env_vars` but left 0001's table-level `UNIQUE(app_id, key)`. A task-scoped var whose key exists at app scope - the whole point of layering, and the documented intent in EnvLayering tests - violates the constraint and rolls back the save. Worse: the lazy `ensureTaskBackfilled` hits the same violation inside `env:getTask`, so the env panel for that task rejects on *every read*. (Bonus: the constraint is inert for global scope since `app_id IS NULL` bypasses UNIQUE.)
**Fix:** migration 0006 rebuilding `env_vars` (SQLite can't drop table constraints): three partial unique indexes - `UNIQUE(key) WHERE app_id IS NULL AND task_id IS NULL`, `UNIQUE(app_id,key) WHERE … task_id IS NULL`, `UNIQUE(task_id,key) WHERE task_id IS NOT NULL`. Add a real-DB integration test running the actual migrations.
Files: `src/main/db/migrations/0001_init.sql:27`, `0004_env_task_scope.sql`, `src/main/services/EnvStore.ts:107,164`

### 5.7 Deleted task env vars resurrect after relaunch *(medium, S, verified)*
`ensureTaskBackfilled` re-runs the legacy `tasks.env_overrides` JSON backfill whenever a task has zero env rows, guarded only by an in-process Set. Delete all task vars → relaunch → frozen JSON re-inserts them (including secrets the user explicitly deleted). The 0004 migration comment specifies the missing persistent marker that was never implemented.
**Fix:** `UPDATE tasks SET env_overrides='{}'` inside the backfill transaction (and on successful `setTask`).
Files: `src/main/services/EnvStore.ts:30,164`

### 5.8 EnvEditor silently discards unsaved edits three ways *(high, M)*
(1) Close (X) has no dirty check - all unsaved rows across all three tabs vanish; (2) switching task in the picker refetches and clobbers unsaved task rows; (3) saving the Global tab refetches and resets unsaved App-tab edits. No success feedback on Save either.
**Fix:** dirty flag per scope vs last-fetched snapshot; gate close/task-switch behind `openConfirm('Discard unsaved changes?')`; scope post-save refresh to the saved tab; transient "Saved ✓".
Files: `src/renderer/components/EnvEditor.tsx:48,101`, `AppDetail.tsx:476`

### 5.9 Graceful teardown on quit *(high product + medium reliability, S-M)*
The only quit hook is `before-quit → closeDb()`. The SIGTERM → grace → SIGKILL → tree-kill machinery is **never invoked on quit** - children die via PTY teardown (or survive as orphans if they ignore SIGHUP), run_history rows are left open, and `quitAndInstall` (auto-update!) force-closes mid-serve. Also: DB closes *first*, and a late PTY exit event can lazily **re-open the DB** and re-run migrations during shutdown.
**Fix:** `before-quit` → `preventDefault()` on first pass; if tasks are running, confirm ("3 servers running - stop and quit?"); reverse-topo stop bounded by `kill_grace_ms`; close DB last; re-entry flag; hook same path before `quitAndInstall`. Guard `db()` against reopening after `closeDb()`.
Files: `src/main/index.ts:150`, `src/main/services/Updater.ts:48`, `src/main/db/index.ts:75`

### 5.10 dotenv parser fidelity *(high, S, unverified - add failing tests first)*
`parseDotEnv` (used at spawn time and for paste-import) diverges from real dotenv: multiline quoted values (PEM keys - common for Firebase/Google) become a mangled first-line fragment; `export KEY=value` lines are silently skipped; `KEY="x" # comment` keeps literal quotes. Because DevHarbor injects parsed values into the spawned env and frameworks don't override pre-existing process env, **the mangled value wins over the framework's own correct parse** - apps behave differently under DevHarbor than in a terminal, with no error.
**Fix:** support multiline quoted values, `export ` prefix, trailing comments after closed quotes (or vendor motdotla/dotenv's `parse()`); extend `src/shared/__tests__/dotenv.test.ts` with all three cases.
Files: `src/shared/dotenv.ts:11-37`

### 5.11 `db:export` / `db:reset` ignore WAL *(high, S, unverified - reproduce first)*
DB runs in WAL mode; `db:export` does `copyFileSync` of only the main file while the handle is open - for a DB this small, essentially *all* data since launch lives in the `-wal` file, so user backups can be near-empty. `db:reset` archives the same stale file, unlinks the live DB with the handle open, leaves `-wal`/`-shm` behind, then `app.exit(0)` - which **skips `before-quit`**, so the WAL is never checkpointed and may be recovered into the fresh DB on relaunch.
**Fix:** export via better-sqlite3's online backup (`db().backup(path)`) or `VACUUM INTO`; reset: `closeDb()` first, move `.db` + `-wal` + `-shm` aside together, then relaunch.
Files: `src/main/ipc/index.ts:274-305`, `src/main/db/index.ts:26`

---

## 6. Security

Posture is strong (see §2). Remaining items are defense-in-depth, roughly in priority order:

1. **Project `.env` outranks user-configured env and the computed PATH** *(medium, S)*. `EnvBuilder` layers on-disk `.env`/`.env.local` **last**, so a malicious (or just weird) repo's `.env` can override `PATH`, `NODE_OPTIONS`, `DYLD_*` - and the spawn resolves `npm`/`node` through that PATH, for *any* task the user runs in that app. It also silently overrides values the user set in the trusted UI. **Fix:** layer project `.env` below user-configured scopes, and/or deny-list process-control keys (PATH, NODE_OPTIONS, NODE_PATH, DYLD_*, LD_*) from file-sourced env; never let `.env` replace the computed PATH. (`EnvBuilder.ts:44,62,71`)
2. **Electron fuses never configured** *(medium, M, verified)*. Shipped binary leaves `RunAsNode`, `NODE_OPTIONS`, `--inspect` enabled - any local process can run arbitrary code under DevHarbor's signed, notarized, entitled identity (`ELECTRON_RUN_AS_NODE=1`). **Fix:** `@electron/fuses` via afterPack: disable RunAsNode / NodeOptions / NodeCliInspect, enable `OnlyLoadAppFromAsar` + asar integrity. (electron-builder afterPack runs pre-sign, so fuses get covered by codesign.)
3. **Trim over-broad entitlements** *(low, M, verified - already flagged in the plist's own comments)*. `disable-library-validation` + `allow-dyld-environment-variables` together permit library injection into the notarized process; `disable-executable-page-protection` is likely unneeded. electron-builder re-signs the native `.node` files with your Team ID, so library validation can probably stay on. **Fix:** remove `disable-executable-page-protection` first, then try removing `disable-library-validation`; verify the notarized build loads better-sqlite3/node-pty. (`build/entitlements.mac.plist`)
4. **Pin Actions to commit SHAs in the signing job** *(medium, S)*. The job that decodes the .p12 and holds notarization secrets runs five third-party actions at floating major tags. Pin to full SHAs.
5. **`apps:update` skips the validation `apps:add` enforces** *(low, S)*. Route patch `path`/`workingDir` through `normalisePath` (realpath + isDirectory) in `AppRegistry.update`. Also pin identity fields - a patch containing `id` currently retargets another row (mirror TaskRegistry's `id: current.id` pattern). (`AppRegistry.ts:99-135`)
6. **Deep-link `open?path` auto-runs detection with no user gesture** *(low, S)*. A web page can pop the Add drawer and trigger `apps:detect` (package.json read + dir enumeration) on an arbitrary path. Require a user click in the drawer before detection runs for deep-link-supplied paths; realpath the path before `getByPath` so registered apps match. (`DeepLinks.ts:75`, `AddAppDrawer.tsx:82`)
7. **CSP tightening** *(low, S)*: add `object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`; narrow `ws:` to localhost. (`index.html:5`)
8. **Secrets stored plaintext in SQLite** *(medium, M, verified)*. `is_secret` only switches the input to `type=password`; values sit unencrypted in `devharbor.db` and round-trip to the renderer on every `env:get*`. **Fix:** `safeStorage.encryptString` for secret values (versioned `enc1:` prefix), decrypt only in main inside `EnvBuilder.build`, masked placeholders over IPC + explicit `env:reveal` channel; migrate existing rows; fall back visibly if encryption unavailable. (`EnvStore.ts:140,202`)
9. **Validate IPC payload shapes at the main boundary** *(low, M)*: the preload whitelist gates channel *names* only; add per-channel guards (zod/valibot or hand-rolled) for the handlers that touch fs/DB/spawn.

## 7. Reliability & process lifecycle

(5.3, 5.4, 5.9 above are the big three.) Also:

1. **SIGTERM only reaches the PTY child** *(medium, S)*: `pty.kill('SIGTERM')` signals the wrapper; npm/shell chains don't forward it, so real servers usually skip graceful shutdown and get tree-SIGKILLed. Also SIGKILL escalation resolves without awaiting the exit event, making `'exiting'` a possible dead-end. **Fix:** `treeKill(pid,'SIGTERM')` (or signal the process group) for the graceful phase; after SIGKILL, bounded wait for exit then force-finalize. (`TaskRunner.ts:319-350`)
2. **Readiness probes have no timeout** *(medium, S)*: port-never-opens or regex-never-matches → `startApp` hangs in "starting" forever (compounds 5.4). Add a per-task readiness timeout (default ~60 s) resolving `ready=false` with a distinguishable status. (`readiness/PortReadiness.ts`, `LogReadiness.ts`)
3. **PTY orphaned if `RunHistory.start` throws post-spawn** *(medium, S)*: wrap post-spawn steps; kill the PTY on failure or make history non-fatal. (`TaskRunner.ts:168-185`)
4. **Restart storms** *(medium, S)*: restart triggers can overlap each other and user actions (no per-app mutex; `restartApp` is stop → 100 ms → start). Keep a per-app in-flight promise; coalesce triggers. (`AppOrchestrator.ts:191`, `ipc/index.ts:106`)
5. **Log-hinted ports never pruned** *(medium, S)*: "Port 3000 in use, trying 3001" pins 3000 to the task forever. Expire hints not confirmed by lsof within ~3 polls. (`PortDetector.ts:57,91`)
6. **Stats only sample the wrapper PID** *(low, S)*: CPU/mem reflect the idle npm/shell wrapper, not the actual server. Reuse PortDetector's descendant walk; `pidusage` accepts pid arrays. (`StatsMonitor.ts:62`)
7. **Concurrency is untested** *(low → fix alongside)*: add tests for double-start, start-during-exiting, SIGTERM-ignoring child escalation, readiness timeout, quit teardown.

## 8. Data integrity & persistence

(5.6, 5.7, 5.11 above.) Also:

1. **DB open/migration failure UX** *(medium, S)*: `_db` is cached before migrations run; a migration throw escapes `whenReady` - dock icon, no window, no dialog, half-migrated cached handle. Assign `_db` only after success; `dialog.showErrorBox` with "quit" vs "move DB aside and start fresh". (`db/index.ts:25-45`)
2. **`run_history` grows unbounded; `log_file` column is dead** *(medium, S)*: no DELETE path exists; restart-on-change (once fixed!) multiplies rows. Prune at boot (age or per-app cap) behind a retention setting. (`RunHistory.ts`)
3. **Corrupt JSON cell breaks all listing** *(medium, S)*: bare `JSON.parse` in `rowToApp`/`rowToTask` - one bad cell rejects `apps:list` and the app renders empty. Add `safeJson(raw, fallback)` + warning log. (`AppRegistry.ts:199`, `TaskRegistry.ts:244`)
4. **localStorage prefs orphan on folder rename** *(low, S)*: folder-keyed keys (collapse/pin/order) aren't migrated on rename and never pruned; validate shapes on read, rewrite keys during rename, prune on mount. (`Sidebar.tsx:36-62`)

## 9. Performance & efficiency

1. **LogSearchView re-reads the whole ring on every log event** *(medium, S, verified)*: filter mode + chatty task = up to ~30 × 5 MB IPC reads/sec + full 10k-line regex pass each time. Throttle to ~250-500 ms or append incrementally (events already arrive batched). (`LogSearchView.tsx:22`)
2. **Process polling fork storm** *(medium, S+M)*: StatsMonitor execs one `ps` per task per tick (pidusage accepts pid arrays - batch to one call), and PortDetector spawns O(process-tree) `pgrep` + one `lsof` per task every 2 s (~25-35 forks/sec with 10 tasks). Snapshot the process table once per tick (`ps -axo pid=,ppid=`), build descendant sets in memory, one `lsof -p <all pids>`. (`StatsMonitor.ts:62`, `PortDetector.ts:87,132`)
3. **Per-task stats IPC → N dashboard re-renders/sec** *(medium, M)*: batch the tick into one event/one store set; hoist per-app sorted-tasks/port-entries into `useMemo` keyed on `tasksByApp`. (`store.ts:309`, `Dashboard.tsx:182`)
4. **LogBuffer: no global cap; buffers survive exit forever** *(medium, S)*: 50 apps × 5 MB rings can pin hundreds of MB in main indefinitely (and `chunk.length` undercounts real bytes ~2×). Global byte budget + LRU eviction of exited-task buffers. (`LogBuffer.ts:8`)
5. **All log streams forwarded regardless of visibility** *(low, M)*: add subscribe/unsubscribe per task; replay-from-buffer already covers tab switches. (`ipc/index.ts:128`)
6. **Full 5 MB replay + WebGL context rebuild per tab switch** *(low, S)*: replay only the tail (`task:tailBuffer` already exists) with "load full history". (`LogTerminal.tsx:117`)
7. **Boot N+1 `tasks:list`** *(low, S)*: add `tasks:listAll` returning everything in one query; skip AppDetail refetch when populated. (`App.tsx:57`)
8. **Env watcher handle count** *(low, S)*: one watcher × 8 paths per registered app, mostly nonexistent files → watch each app dir at depth 0 and filter by filename, or only watch running + open apps. (`EnvFileWatcher.ts:52`)

## 10. UX & error feedback

(5.2, 5.5, 5.8 above are the heart of it.) Also:

1. **TaskEditor deletes tasks instantly, no confirm** *(medium, S)* - inconsistent with the task strip's confirmed flow; deletion also drops task env vars and dependency edges. Reuse the danger dialog. (`TaskEditor.tsx:278`)
2. **Add-app accepts non-Node folders silently** *(medium, S)*: detection returns normally with zero scripts; "Add app" stays enabled. Carry `hasPackageJson` in DetectionResult; inline warning ("you can still add it and run custom commands"). (`DetectionService.ts:38`, `AddAppDrawer.tsx:95`)
3. **Stale copy** *(low, S)*: "Click \"Tasks\" above" (button removed in Phase 7); "Add one in Config" (no Config affordance). Grep for drift. (`AppDetail.tsx:458`, `AppOrchestrator.ts:92`)
4. **Long app names overflow** *(low, S)*: `min-w-0 flex-1 truncate` + `title=` on Dashboard card title and AppDetail h1; length-cap the name inputs. (`Dashboard.tsx:316`, `AppDetail.tsx:231`)

## 11. Accessibility & theming

The app is effectively mouse-only today; this is the largest single UX-quality gap. One shared fix covers most of it:

1. **Dialog semantics + focus management everywhere** *(medium, M, verified)*: AddAppDrawer, SettingsDrawer, AppConfigDrawer, TaskEditor, EnvEditor are plain divs - no `role="dialog"`/`aria-modal`, no Escape, no focus trap/restore; global shortcuts (⌘↩ Start!) still fire underneath open drawers. Build one `useDialog` hook/wrapper and apply it to all five (+ move PromptModal's Escape to window level). 
2. **ContextMenu keyboard support** *(medium, M, verified)*: many actions exist *only* in these menus (task edit/disable/remove, folder rename/delete, sort pickers) and the menu can't be operated by keyboard. Fixing this one component (roles, arrow keys, focus-in/restore, anchor-to-trigger) repairs every menu in the app. (`ContextMenu.tsx`)
3. **Sidebar app rows are unfocusable divs** *(medium, S, verified)*: primary navigation is unreachable by keyboard. Real buttons + `aria-current` + visible focus ring. (`Sidebar.tsx:1050`)
4. **`fg-subtle` fails WCAG AA in both themes** *(medium, S)*: ~3.2-3.7:1 used for 10-11 px functional text. Lift one Radix step per theme. (`styles.css:41,73`)
5. **Status is color-only and silent to AT** *(medium, S)*: `role="img"` + `aria-label` on StatusDot; non-color cue for crashed (ring/✕). (`StatusDot.tsx:29`)
6. **xterm invisible to screen readers; ignores light theme** *(medium, S)*: `screenReaderMode: true`; light LIVE_THEME variant keyed off `useTheme`. (`LogTerminal.tsx:84`)
7. **Icon-only buttons: default `aria-label` from `title`** in IconButton/ToolbarButton so call sites can't regress *(medium, S)*.
8. **TaskTab nests a `role="button"` span inside a `<button>`** *(medium, S)*: invalid nesting; per-task start/stop is mouse-only. Split into sibling buttons + visible ⋮ trigger.
9. **Custom dropdowns (FolderSelect, OpenInMenu, TagInput)** *(medium, M)*: listbox/option roles, Escape, arrow nav.
10. **Folder reorder is drag-only** *(low, S)*: add Move up/down to the folder menu (plumbing exists).

## 12. Engineering hygiene

1. **No CI at all** *(medium, S, verified)*: nothing runs `typecheck`/`test` on push/PR despite CONTRIBUTING.md promising it; first signal of rot is a failed signed release. Add `ci.yml` (pull_request + push-to-main): `pnpm install --frozen-lockfile` → typecheck → test on macos-14 (matches the release runner / native rebuilds). Optional weekly unsigned packaging smoke.
2. **Zero lint/format infra; dead `eslint-disable` comments** *(medium, S, verified)*: 4 production disable-comments suppress nothing - hook-dependency decisions are unverified. ESLint flat config (@typescript-eslint + react-hooks; adoption cost is low - code already conforms) + Prettier check in CI; optional husky/lint-staged.
3. **Typed IPC error envelope** *(medium, M, verified)*: 30+ handlers throw prose `Error`s; renderer shows `"Error invoking remote method 'proc:start': …"` verbatim or drops it. `register()` should classify into `{code, message}`; renderer `invokeOrToast()` helper. Foundation for 5.5.
4. **Sidebar.tsx is a 1,084-line God component** *(medium, M)*: extract `useLocalStorageState`, pure `groupApps()` (instantly unit-testable), menu-builder hooks. Extract along seams that already exist.
5. **Duplicated status predicates** *(medium, S)*: `isLive`/`isActive` hand-written 16+ times across 7 files - add `lib/processState.ts` (precedent: `sortApps.ts`).
6. **Renderer has zero tests; TaskRunner/NodeResolver untested** *(medium, L)*: don't chase UI snapshots - target pure seams: kill-escalation/batching with a fake pty, NodeResolver against fixture trees, extracted `groupApps`, store transitions.
7. **Add-app is a renderer-orchestrated 4-call transaction** *(medium, M)*: replace with one `apps:create` channel inside a single SQLite transaction; the manual-rollback code disappears. (`AddAppDrawer.tsx:97`)
8. **Spec drift** *(medium, S - project convention)*: `specs/04-ui.md` still documents the old add flow and a drag-onto-empty-state that doesn't exist; PROGRESS.md lacks the redesign + 1.0.x milestones. Update before committing the redesign.
9. **Channel list can silently drift** *(low, S)*: derive `INVOKE_CHANNELS` from a `satisfies Record<ChannelName, true>` object so omissions fail compile; remove or annotate dead channels (`runs:list`, `app:ping`).
10. **`x-appmgr-*` drag MIME types survived the rebrand** *(low, S)*: rename to `x-devharbor-*` (single-file change). (`Sidebar.tsx:40`)

## 13. Distribution, updates & observability

1. **Crash observability is zero** *(medium, M, verified)*: no `uncaughtException`/`unhandledRejection` handlers, no `render-process-gone` handler, no persistent app log - when a user reports "it crashed," there is nothing to attach. Add electron-log (or minimal file logger to `app.getPath('logs')`), wire updater + process handlers into it, Help → "Open Logs Folder", reference in the bug template. Stays true to the no-telemetry promise (logs are local).
2. **Renderer crash = permanent blank window** *(medium, S, unverified)*: no React ErrorBoundary; no `render-process-gone` recovery. Boundary with Reload button; auto-reload with retry cap - PTYs live in main and survive it.
3. **Updates: one silent check per launch** *(medium, M)*: long-running Macs never learn about releases; all failure paths invisible; no "Check for Updates…" menu item; release notes dropped from the banner (users decide to quit-and-install blind). Periodic re-check (4-12 h), menu item, `update:error`/`update:none` events, forward `releaseNotes`, show version in Settings footer.
4. **`workflow_dispatch` can publish from any ref** *(medium, S)*: add a guard comparing the tag to package.json version, or `--publish never` for dispatch runs (also gives you the safe node24 test run for §4.1).
5. **dmg/zip naming inconsistency** *(low, S)*: `devharbor-*.dmg` vs `DevHarbor-*.zip`; unify via `${productName}` artifactName + update README. Prerequisite for:
6. **Homebrew cask** *(low, M)*: `brew install --cask devharbor` is the expected channel for this audience and solves the arm64/x64 picking friction.

## 14. Product opportunities (ranked by leverage for a solo maintainer)

1. **Menubar/tray presence** *(M, verified gap)* - the single highest-leverage retention feature. The app already keeps servers running with the window closed, but there's zero ambient surface (this product category lives in the menubar: OrbStack, Docker Desktop). Tray icon reflecting aggregate state; menu = apps with start/stop + ports + "Stop all". All state already flows through main - no renderer dependency.
2. **Crash/ready notifications** *(S, verified gap)* - a crashed server while DevHarbor is backgrounded goes unnoticed until the browser tab errors; the monitoring half of the value prop breaks on blur. Electron `Notification` on `crashed` (click → focus app), settings toggle; optional "ready on :3000" toggle.
3. **Quit confirmation + graceful stop** - already in P1 (5.9); product-critical, not just hygiene.
4. **Monorepo/workspace detection** *(M)* - specs promise it (F1 edge cases); the backend (multi-task + `working_dir_override`) was *designed* for it; only detection (pnpm-workspace.yaml / `workspaces` field) + an add-flow offer ("create a task per workspace package") is missing. The gap that makes DevHarbor feel like it doesn't understand modern repos.
5. **Bulk import** *(M)* - "Import projects from a folder…": shallow-scan for package.json dirs, checklist UI, batch-register via existing IPC. Target user has 3-20 repos; onboarding is currently N full drawer flows.
6. **Per-app auto-start + launch at login** *(S)* - `app.setLoginItemSettings` + an `autoStart` column; "I sit down, my stack is already up." Pairs with the tray.
7. **Start/stop all in folder** *(S)* - folders are display-only; this is 80% of "scenes" for 5% of the effort.
8. **Port-conflict awareness** *(S)* - match EADDRINUSE in crash logs, enrich CrashPin with which registered task holds the port + "Stop X and restart".
9. **Global log search** *(M)* - "which service printed ECONNREFUSED?" currently requires opening every app/tab; LogBuffer already holds everything in main. ⌘⇧F fan-out + minimal run-history resurrection inside it.
10. **Window bounds persistence** *(S, unverified)* - save/restore `getNormalBounds()` with display validation; daily paper cut for a keep-open app.
11. **Polyglot via mise** *(L, post-1.x)* - per the analysis on 2026-06-11: detect-existing-mise first as an additional resolver (provisioning vs orchestration boundary), guided install second, bundling only if proven. Near-term zero-code step: document "any command" tasks (redis-server, docker run …) in onboarding/task placeholder.

## 15. Suggested sequencing

**This week (before June 16):**
- §4.1 Actions bump + dispatch test run · 12.1 CI workflow (small, protects everything else) · 13.4 dispatch guard

**v1.0.2 - correctness patch (≈1-2 weeks of S/M items):**
- 5.1 restart-watcher fix · 5.2 app removal · 5.4 stranded "starting" · 5.7 env resurrection · 5.10 dotenv parser (+tests) · 5.11 WAL-safe export/reset · 10.3 stale copy · 13.5 artifact naming
- Commit the add-flow redesign with 12.8 spec updates

**v1.1.0 - robustness & feedback:**
- 5.3 start races · 5.5 global error surface + 12.3 error envelope · 5.6 env schema migration · 5.8 EnvEditor dirty guards · 5.9 quit teardown · 7.1-7.4 lifecycle hardening · 13.1-13.3 observability + update UX · 6.1/6.2 (.env precedence, fuses)
- 11.1-11.3 dialog/menu/sidebar keyboard support (the three structural a11y fixes)

**v1.2.0 - performance + product:**
- §9 items 1-4 · 14.1 tray · 14.2 notifications · 14.6 auto-start · 14.7 folder start-all · 14.10 window bounds

**v1.3.0+:**
- 14.4 monorepo detection · 14.5 bulk import · 14.8 port conflicts · 14.9 global log search · 6.8 secret encryption · 13.6 Homebrew cask · remaining a11y/perf polish

**Post-1.x:** mise/polyglot (14.11) · Windows/Linux validation

## 16. Notes on method & confidence

- *(verified)* = the finding survived two independent re-checks made with the explicit goal of refuting it (one re-reading the cited code for evidence, one judging real-world impact/mitigations). 22 findings went through this; **none were refuted**, several had severity adjusted.
- The two most consequential bugs (5.1 restart-watcher dead, 5.2 unremovable apps) were additionally reproduced directly: chokidar 5.0.0 confirmed installed with glob patterns passed to `watch()`, and the `!== 'idle'` guard confirmed at `ipc/index.ts:174` against the sticky-outcome design.
- *(unverified)* items (5.10, 5.11, PathProbe rc-noise, SSH_AUTH_SOCK/.env.development fidelity, renderer crash recovery, window bounds) came from the completeness critic; each cites concrete code but write a failing test/repro before fixing.
- Two further critic items not detailed above, worth a look while in EnvBuilder: **PathProbe** captures `$SHELL -l -i -c 'printf %s "$PATH"'` stdout verbatim - rc-file banners/nvm warnings corrupt the PATH base for every spawned task (wrap in sentinels, or drop `-i`); and the sanitized base env drops **SSH_AUTH_SOCK** (git-over-SSH fails under DevHarbor but works in a terminal) and ignores `.env.development`/`.env.*.local` variants that frameworks load.
