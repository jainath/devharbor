# 02 - Data Model

All persistent state lives in one SQLite file at `userData/devharbor.db`. In-memory state (running processes, ring buffers, pidusage samples) is **not** persisted.

## Tables

### `apps`

One row per registered project.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | ULID, generated in main process |
| `name` | TEXT NOT NULL | Defaults to the directory basename, user-editable |
| `path` | TEXT NOT NULL UNIQUE | Absolute path on disk |
| `color` | TEXT | Hex like `#7aa2f7`, for the sidebar dot; auto-assigned, user-editable |
| `icon` | TEXT | Optional emoji or short tag |
| `node_version_pref` | TEXT | One of: `auto` (use `.nvmrc`/`.node-version`/`engines.node`), `system`, or an explicit version like `20.11.0` |
| `package_manager` | TEXT | `npm` \| `yarn` \| `pnpm` \| `bun` - null means "detect each time" |
| `default_script` | TEXT | e.g. `dev` - remembered between sessions |
| `custom_command` | TEXT | If set, used instead of `<pm> run <script>`; raw shell line |
| `working_dir` | TEXT | Defaults to `path`; can be a subdir for monorepos |
| `auto_restart_on_change` | INTEGER | 0/1; off by default |
| `watch_globs` | TEXT | JSON array of globs when `auto_restart_on_change=1` |
| `auto_start` | INTEGER | 0/1; start this app automatically when DevHarbor launches (migration `0007`, 1.1.0) |
| `port_hint` | INTEGER | Last detected port; cached for the dashboard |
| `tags` | TEXT | JSON array of strings |
| `folder` | TEXT | Phase 8: visual grouping in the sidebar. NULL = "(ungrouped)". Single-level (no nesting). Tags are orthogonal facets; folder is each app's one canonical home. |
| `last_started_at` | INTEGER | Unix ms |
| `last_exit_code` | INTEGER | |
| `created_at` | INTEGER NOT NULL | |
| `updated_at` | INTEGER NOT NULL | |

Indices: `idx_apps_updated_at`, `idx_apps_path`.

### `env_vars`

Layered key/value store. **Three scopes** since Phase 7: `global` (`app_id IS NULL AND task_id IS NULL`), per-app (`task_id IS NULL`), and per-task (`task_id` set; `app_id` denormalised for cascade and indexing).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | ULID |
| `app_id` | TEXT FK → apps(id) ON DELETE CASCADE | NULL = global scope |
| `task_id` | TEXT FK → tasks(id) ON DELETE CASCADE | NULL = not task-scoped. Phase 7 addition. |
| `key` | TEXT NOT NULL | |
| `value` | TEXT NOT NULL | Plaintext for non-secrets. Since 1.1.0 (migration `0006` era), rows with `is_secret = 1` are encrypted at rest via Electron `safeStorage` and stored as `enc1:<base64>`; decrypted transparently in `EnvStore`. Falls back to plaintext when OS encryption is unavailable. |
| `enabled` | INTEGER NOT NULL | 0/1, allows toggling without delete |
| `is_secret` | INTEGER NOT NULL | 0/1; masks in UI, triggers at-rest encryption |
| `note` | TEXT | Free-form |
| `created_at` | INTEGER NOT NULL | |
| `updated_at` | INTEGER NOT NULL | |

Indices: `idx_env_vars_scope (app_id, task_id, key)` plus, since migration `0006`, three
**partial unique indexes** that enforce per-scope key uniqueness correctly:

- `uq_env_global` - `UNIQUE(key) WHERE app_id IS NULL AND task_id IS NULL`
- `uq_env_app` - `UNIQUE(app_id, key) WHERE app_id IS NOT NULL AND task_id IS NULL`
- `uq_env_task` - `UNIQUE(task_id, key) WHERE task_id IS NOT NULL`

(0001's table-level `UNIQUE(app_id, key)` was dropped in `0006`: it made a task-scoped
override of an app-scoped key - the whole point of layering - impossible to save, while
being inert for global rows.)

**Scope layering** (later wins) when `EnvBuilder` composes a task's effective env:
1. Sanitized OS base (HOME, USER, LANG, SSH_AUTH_SOCK, …)
2. User's resolved PATH (Node bin prepended)
3. Project `.env` files from cwd - `.env`, `.env.development`, `.env.local`,
   `.env.development.local` (dotenv precedence). Process-control keys (`PATH`,
   `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*`, `LD_*`) are stripped from file vars.
4. Global rows (`app_id IS NULL AND task_id IS NULL`, enabled)
5. App rows (`app_id = ? AND task_id IS NULL`, enabled)
6. **Task rows (`task_id = ?`, enabled)** - Phase 7
7. Hard-coded runtime (FORCE_COLOR, TERM)

> Changed in 1.1.0: user-configured rows now sit **above** project `.env` files (the UI is
> the source of truth), and project files can never set process-control variables.

The `tasks.env_overrides` JSON column (legacy) is migrated into `env_vars` rows on first
read and then stamped to `'{}'`, so deleted task vars can never resurrect from the frozen
JSON on a later boot.

The UI surfaces this layering as inheritance indicators.

### `run_history`

One row per process start.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | ULID |
| `app_id` | TEXT NOT NULL FK | |
| `started_at` | INTEGER NOT NULL | |
| `ended_at` | INTEGER | Null while running |
| `script` | TEXT | e.g. `dev` |
| `custom_command` | TEXT | If applicable |
| `node_version` | TEXT | Resolved version actually used |
| `package_manager` | TEXT | Resolved PM actually used |
| `exit_code` | INTEGER | |
| `exit_signal` | TEXT | e.g. `SIGTERM` |
| `was_killed_by_user` | INTEGER | 0/1 |
| `log_file` | TEXT | Path on disk if logs were saved; else NULL |

Used for: "Last run: 2 min ago, exit 0" badges, crash detection ("3 runs ago this exited with code 1"), and a per-app history pane.

### `tasks`  *(introduced in Phase 1.5)*

One row per unit of work inside an App. An App with a single task behaves identically to a "simple" app; an App with multiple tasks gains orchestration (dependency ordering, readiness signals, per-task process control).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | ULID |
| `app_id` | TEXT NOT NULL FK → apps(id) ON DELETE CASCADE | |
| `name` | TEXT NOT NULL | User-visible label: `api`, `web`, `migrate` |
| `position` | INTEGER NOT NULL | Stable display order in the UI tab strip |
| `command_kind` | TEXT NOT NULL | `script` \| `custom` |
| `script` | TEXT | When kind=script, e.g. `dev` |
| `custom_command` | TEXT | When kind=custom, raw shell line e.g. `pnpm -F api db:migrate` |
| `working_dir_override` | TEXT | Absolute or relative-to-app.path; null = use app's `working_dir`. Lets a single App span multiple monorepo workspaces. |
| `package_manager_override` | TEXT | null = use app's |
| `node_version_pref_override` | TEXT | JSON of `NodeVersionPref`; null = use app's |
| `depends_on` | TEXT NOT NULL DEFAULT `'[]'` | JSON array of task IDs that must reach **ready** before this task starts |
| `readiness` | TEXT NOT NULL DEFAULT `'{"kind":"none"}'` | JSON `ReadinessSignal` (see types below) |
| `one_shot` | INTEGER NOT NULL DEFAULT 0 | 1 = task is expected to exit (migrations, builds). Required `readiness.kind = "exit"`. |
| `enabled` | INTEGER NOT NULL DEFAULT 1 | Toggle without delete |
| `env_overrides` | TEXT NOT NULL DEFAULT `'{}'` | Per-task env layer, applied between app env and `.env` files |
| `created_at` | INTEGER NOT NULL | |
| `updated_at` | INTEGER NOT NULL | |

Indices: `idx_tasks_app` on `(app_id, position)`.

**Orchestration semantics:**

- App-level Start: topo-sort enabled tasks by `depends_on`; for each task in order, wait for all predecessors to be `ready`, then spawn. Within one topological level, tasks start in `position` order.
- App-level Stop: reverse-topo. SIGTERM each task; after the global `kill_grace_ms`, escalate to SIGKILL on the process group; `tree-kill` fallback.
- App-level Restart: stop + wait + start with the same task set.
- Per-task Start/Stop is also exposed (mainly for debugging - start one task without its dependents). The orchestrator does not auto-start deps when a single task is started manually.
- A non-`one_shot` task that exits is treated as crashed at the app level. The app status reflects the worst task state.
- Cycles in `depends_on` are rejected at save time with a clear error citing the cycle.

**App-level status derivation:**

| Condition (across enabled tasks) | App state |
|---|---|
| All tasks idle | `idle` |
| Any task `starting` or any non-ready task running | `starting` |
| All long-lived tasks ready, all one-shot tasks exited code 0 | `running` |
| Stop in progress | `exiting` |
| All tasks exited cleanly (one-shots code 0; long-lived killed by user) | `exited` |
| Any non-one-shot exited unexpectedly OR any one-shot exited non-zero | `crashed` |

### `settings`

Single-row key/value table for app-wide preferences.

| Key | Default | Purpose |
|---|---|---|
| `log_ring_size` | 10000 | Lines per app held in memory |
| `kill_grace_ms` | 5000 | SIGTERM-to-SIGKILL grace window |
| `auto_update` | 1 | Check for updates on launch |
| `theme` | `system` | `light` / `dark` / `system` |
| `dashboard_refresh_ms` | 1000 | pidusage poll interval |

## Shared TypeScript types

Lives at `src/shared/types.ts` and is imported by both main and renderer.

```ts
export type AppId = string & { readonly __brand: 'AppId' };

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export type NodeVersionPref =
  | { kind: 'auto' }
  | { kind: 'system' }
  | { kind: 'explicit'; version: string };

export interface App {
  id: AppId;
  name: string;
  path: string;
  color: string;
  icon?: string;
  nodeVersionPref: NodeVersionPref;
  packageManager: PackageManager | null;
  defaultScript: string | null;
  customCommand: string | null;
  workingDir: string;
  autoRestartOnChange: boolean;
  watchGlobs: string[];
  portHint: number | null;
  tags: string[];
  lastStartedAt: number | null;
  lastExitCode: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnvVar {
  id: string;
  appId: AppId | null;
  key: string;
  value: string;
  enabled: boolean;
  isSecret: boolean;
  note?: string;
}

export type ProcessState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'exiting'
  | 'exited'
  | 'crashed';

export interface RunningProcess {
  appId: AppId;
  pid: number;
  state: ProcessState;
  startedAt: number;
  script: string | null;
  command: string;
  nodeVersion: string;
  packageManager: PackageManager;
  cpu: number;       // percent
  memMB: number;
  ports: number[];   // detected
  exitCode: number | null;
  exitSignal: string | null;
}

export type TaskId = string & { readonly __brand: 'TaskId' };

export type ReadinessSignal =
  | { kind: 'none' }
  | { kind: 'port'; port: number; host?: string }
  | { kind: 'log'; regex: string; flags?: string }
  | { kind: 'exit'; code?: number }
  | { kind: 'delay'; ms: number };

export type CommandKind = 'script' | 'custom';

export interface Task {
  id: TaskId;
  appId: AppId;
  name: string;
  position: number;
  commandKind: CommandKind;
  script: string | null;
  customCommand: string | null;
  workingDirOverride: string | null;
  packageManagerOverride: PackageManager | null;
  nodeVersionPrefOverride: NodeVersionPref | null;
  dependsOn: TaskId[];
  readiness: ReadinessSignal;
  oneShot: boolean;
  enabled: boolean;
  envOverrides: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/** Per-task runtime state, parallel to RunningProcess. */
export interface RunningTask {
  taskId: TaskId;
  appId: AppId;
  pid: number;
  state: ProcessState;     // task-level state
  ready: boolean;          // has the readiness signal fired?
  startedAt: number;
  command: string;
  nodeVersion: string;
  packageManager: PackageManager;
  cpu: number;
  memMB: number;
  ports: number[];
  exitCode: number | null;
  exitSignal: string | null;
}

export interface DetectionResult {
  packageManager: PackageManager | null;
  nodeVersionFromProject: string | null;     // from .nvmrc, .node-version, engines.node
  scripts: Record<string, string>;
  hasEnvFile: boolean;
  envFiles: string[];                         // discovered .env*
  suggestedDefaultScript: string | null;      // 'dev' > 'start' > first
}

export interface NodeInstallation {
  source: 'nvm' | 'fnm' | 'volta' | 'asdf' | 'system';
  version: string;        // e.g. "20.11.0"
  binDir: string;         // absolute path containing the `node` binary
}
```

## Security note on secrets

Since 1.1.0, env var values with `is_secret = 1` are **encrypted at rest** using Electron's
`safeStorage` (macOS Keychain-backed). Encrypted values are stored as `enc1:<base64>` and
decrypted transparently inside `EnvStore`, so the editor and `EnvBuilder` always see
plaintext. A one-shot boot migration re-encrypts any pre-1.1.0 plaintext secret rows.
Non-secret values remain plaintext. When OS encryption is unavailable, saves fall back to
plaintext rather than failing; an undecryptable value is returned raw, never destroyed.

Residual exposure: decrypted values flow over typed IPC to the env editor on demand (a
single-user desktop trade-off), and any process running as the same user can use the same
Keychain entry. The DB lives in the user's `Application Support` directory.

## Migrations

`src/main/db/migrations/` contains numbered `.sql` files. A `_schema_migrations` table tracks applied versions. Migrations are forward-only and idempotent where possible.

| File | Purpose |
|---|---|
| `0001_init.sql` | `apps`, `env_vars`, `run_history`, `settings` + indices, seed default settings |
| `0002_tasks.sql` | `tasks` table + index. Schema-only - no data backfill. |
| `0003_run_history_tasks.sql` | `run_history.task_id` + `task_name` for per-task run rows. |
| `0004_env_task_scope.sql` | `env_vars.task_id` for the third (task) scope. |
| `0005_app_folders.sql` | `apps.folder` for sidebar grouping. |
| `0006_env_scope_unique.sql` | Rebuilds `env_vars` without 0001's table-level `UNIQUE(app_id,key)`; adds the three per-scope partial unique indexes (see `env_vars` above); de-dupes any pre-existing violations keeping the most recently updated row. |
| `0007_app_autostart.sql` | `apps.auto_start` - start the app automatically when DevHarbor launches. |

### Backfill for existing apps (Phase 1.5)

Pure-SQL backfill is awkward (ULID gen, JSON shape), so seeding initial tasks runs in TypeScript on startup:

```
For each app where (apps:tasks count) == 0:
  if app.custom_command:    seed one task { name: 'main', kind: 'custom', custom_command: ... }
  elif app.default_script:  seed one task { name: app.default_script, kind: 'script', script: ... }
  else:                     do nothing (the app will require explicit task creation)
```

`apps.default_script` and `apps.custom_command` are retained for now as a convenience - when a user has just one task, the App-level header still shows "Script: dev" by reflecting that single task's value. A future migration can drop those columns once the UI stops referencing them directly.

### `run_history` + tasks

`run_history` is extended to carry an optional `task_id` (nullable for backwards compat). A "run" of an App with multiple tasks produces one history row **per task**, all tagged with the same `started_at` group. The History tab presents them grouped by run.

```sql
ALTER TABLE run_history ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
```

This goes in `0003_run_history_tasks.sql` and is Phase 2 work - included here for completeness.
