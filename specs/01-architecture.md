# 01 — Architecture

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron (latest stable) | We need full Node APIs in the main process for spawning, PTYs, FS watching, SQLite. Tauri's Rust backend would fight us here. |
| Build | electron-vite | HMR for renderer + main, first-class TS, clean main/preload/renderer split. The current sweet spot. |
| Packaging | electron-builder | Mature signing/notarization/DMG/auto-update. Pairs cleanly with electron-vite. |
| UI | React 18 + TypeScript | Default. |
| Styling | Tailwind CSS | Dense, dev-tool aesthetic; pairs with shadcn. |
| Components | shadcn/ui (on Radix) | We own the source — easy to make dense + customise. |
| Renderer state | Zustand | Tiny, no Provider gymnastics, scales for this app size. |
| IPC types | Shared `types/ipc.ts` + `electron-trpc` (deferred) | Start hand-rolled with strict types; revisit trpc if churn is high. |
| Process spawn | `@lydell/node-pty` (prebuilt for Electron) | Real TTY → ANSI colors and TUI redraws work. No `electron-rebuild` pain. |
| Process tree kill | `detached: true` + `process.kill(-pid)` | POSIX process-group kill. `tree-kill` as a backup for edge cases. |
| Persistence | better-sqlite3 | Sync API (fits Electron main), trivial for our data shape, future-proof for logs. |
| Logs in UI | @xterm/xterm + addons (fit/webgl/search) | What VS Code uses. Renders TUI redraws correctly. |
| Log history pane | react-window + `anser` (ANSI → React) | Lighter view for search/filter over the ring buffer. |
| Package manager detection | `package-manager-detector` (antfu) | Lockfile + `packageManager` field + `devEngines`. Covers npm/yarn/pnpm/bun. |
| FS watching | chokidar | Standard. Used for `.env` reload and optional restart-on-change. |
| Process stats | pidusage | Cheap CPU/RAM polling per pid. |
| Env parsing | dotenv + dotenv-expand | For pasted `.env` blobs and `${VAR}` references. |
| Auto-update | electron-updater | Built into electron-builder. Set up early; retrofit is painful. |

## Process model

```
┌────────────────────────────────────────────────────────────────┐
│ Electron MAIN process (Node)                                   │
│                                                                │
│   AppRegistry  ──┐                                             │
│   EnvStore      ─┤  better-sqlite3 (single DB file)            │
│   RunHistory   ──┘                                             │
│                                                                │
│   ProcessManager ── PTYs ──► child npm/yarn/pnpm scripts       │
│      │              (detached, own process group)              │
│      ├── ring buffer of log chunks per pid                     │
│      ├── pidusage poll loop (1s)                               │
│      └── port detector (lsof poll on demand)                   │
│                                                                │
│   NodeResolver   reads ~/.nvm, ~/.fnm, ~/.volta, ~/.asdf       │
│   PMDetector     reads package.json + lockfiles                │
│   EnvFileWatcher chokidar on .env, .env.local, .env.<NODE_ENV> │
│                                                                │
│   IPC handler ──── contextBridge ────► renderer                │
└────────────────────────────────────────────────────────────────┘
                              ▲
                              │  ipcRenderer.invoke / .on
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Electron RENDERER (Chromium, sandboxed, no Node)               │
│                                                                │
│   React UI                                                     │
│   Zustand store (mirrors main state via IPC snapshots + push)  │
│   xterm instances per running app                              │
└────────────────────────────────────────────────────────────────┘
```

### Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for the renderer.
- The renderer has no `fs`, `child_process`, or other Node access.
- All capabilities are exposed through a typed `window.api` surface defined in `preload/index.ts`.
- No remote content loaded; the renderer is local `file://` (or `http://localhost` in dev for Vite HMR).

## Source layout

```
devharbor/
├── electron.vite.config.ts
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── tailwind.config.ts
├── postcss.config.js
├── specs/                           ← this folder
├── src/
│   ├── main/                        ← Electron main process
│   │   ├── index.ts                 (BrowserWindow, lifecycle)
│   │   ├── ipc/                     (typed handlers, one file per channel group)
│   │   ├── db/                      (better-sqlite3 + migrations)
│   │   ├── services/
│   │   │   ├── AppRegistry.ts
│   │   │   ├── ProcessManager.ts
│   │   │   ├── NodeResolver.ts
│   │   │   ├── PMDetector.ts
│   │   │   ├── EnvStore.ts
│   │   │   ├── EnvFileWatcher.ts
│   │   │   ├── PortDetector.ts
│   │   │   └── LogBuffer.ts
│   │   └── util/
│   ├── preload/
│   │   └── index.ts                 (contextBridge.exposeInMainWorld)
│   ├── renderer/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── ui/                  (shadcn-generated)
│   │   │   ├── AppSidebar.tsx
│   │   │   ├── AppDetail.tsx
│   │   │   ├── LogTerminal.tsx
│   │   │   ├── EnvEditor.tsx
│   │   │   ├── ScriptPicker.tsx
│   │   │   ├── Dashboard.tsx
│   │   │   └── CommandPalette.tsx
│   │   ├── store/                   (Zustand slices)
│   │   ├── hooks/
│   │   └── styles/
│   └── shared/
│       ├── types.ts                 (App, RunningProcess, EnvVar, etc.)
│       └── ipc.ts                   (channel names + payload types)
├── build/                           ← icons, entitlements.mac.plist
└── dist/                            ← electron-builder output (gitignored)
```

## IPC contract

A single shared file (`src/shared/ipc.ts`) defines all channels and their request/response shapes. The preload script proves these are honoured.

Two patterns:

- **`invoke`** for request/response (CRUD on apps, env vars, scripts).
- **`on`** for server-pushed streams (log chunks, status changes, pidusage ticks).

Channel naming: `<domain>:<action>`. Examples:

| Channel | Direction | Purpose |
|---|---|---|
| `apps:list` | invoke | Return all registered apps |
| `apps:add` | invoke | Register a directory as an app |
| `apps:update` | invoke | Patch an app's config |
| `apps:remove` | invoke | Deregister (does not delete files) |
| `apps:detect` | invoke | Re-run detection on a directory |
| `proc:start` | invoke | Spawn the chosen script |
| `proc:stop` | invoke | Kill the process tree |
| `proc:restart` | invoke | Stop then start with the same config |
| `proc:list` | invoke | List currently running processes |
| `proc:log` | on | Stream of `{appId, chunk, ts}` |
| `proc:status` | on | `{appId, state: 'starting'\|'running'\|'exiting'\|'exited', exitCode?}` |
| `proc:stats` | on | `{appId, cpu, mem, ports[]}` |
| `env:getGlobal` | invoke | Read global env defaults |
| `env:setGlobal` | invoke | Write global env defaults |
| `env:getApp` | invoke | Read per-app env |
| `env:setApp` | invoke | Write per-app env |
| `node:list` | invoke | List discovered Node versions across nvm/fnm/volta/asdf |
| `node:resolve` | invoke | Resolve a project's Node version preference to an absolute binary path |
| `dialog:browse` | invoke | Open native folder picker |

Every IPC handler is typed in `src/shared/ipc.ts`:

```ts
export type IpcChannels = {
  'apps:list': { req: void; res: App[] };
  'apps:add':  { req: { path: string }; res: App };
  // ...
};
```

The preload re-exports an `api` object whose methods are 1:1 with these channel keys.

## Concurrency rules

- Only the main process spawns and owns child processes.
- A single in-memory `Map<appId, RunningProcess>` is the canonical "what's running" state.
- The renderer's Zustand store is hydrated by `proc:list` on startup and kept fresh via `proc:status` push events.
- Log chunks fan out: PTY → ring buffer (in memory, capped per app) → IPC push to renderer → xterm.write.
- The ring buffer is bounded (default 10k lines / 5MB per app, configurable). When full, oldest lines drop. The full historic log can optionally be persisted to disk per app.

## Persistence

A single SQLite file at `~/Library/Application Support/devharbor/devharbor.db` (resolved via `app.getPath('userData')`). Schema in [`02-data-model.md`](02-data-model.md). Migrations live in `src/main/db/migrations/` and run in order on startup.

Logs are **not** persisted to SQLite by default — they live in the ring buffer. Optional per-app "save logs to disk" writes a rotating file to `userData/logs/<appId>/<runId>.log`.

## How we run a child process (the canonical sequence)

1. User clicks "Start" on an app with a chosen script (e.g. `npm run dev`).
2. `ProcessManager.start(appId)`:
   1. Look up `App` row, including resolved Node version, package manager, working dir, script.
   2. `NodeResolver.resolveBinPath(app.nodeVersion)` → absolute path like `/Users/.../.nvm/versions/node/v20.11.0/bin`.
   3. Build the env:
      - Start from a clean object (NOT inheriting full `process.env` — too leaky).
      - Inject a sanitized base: `HOME`, `USER`, `LANG`, `TMPDIR`, `SHELL`, `TERM=xterm-256color`.
      - Prepend the resolved Node bin dir to `PATH`, then the user's standard `PATH` from a one-time login-shell probe.
      - Layer in global env vars from `EnvStore`.
      - Layer in app-specific env vars (these override global).
      - Layer in parsed `.env` / `.env.local` / `.env.${NODE_ENV}` from the project dir, in dotenv-cli order.
      - Force `FORCE_COLOR=1`.
   4. Spawn via `@lydell/node-pty.spawn(packageManagerBin, ['run', scriptName], { cwd, env, name: 'xterm-256color', cols, rows })`.
   5. Mark process detached / new process group (PTY already gives us a session).
   6. Wire PTY `onData` → ring buffer → IPC push.
   7. Wire PTY `onExit` → status push + cleanup.
   8. Start a `pidusage` poll loop (1s) and a port-detector tick.
3. `ProcessManager.stop(appId)`:
   1. Send SIGTERM to the process group.
   2. Wait up to 5s (configurable) for clean exit.
   3. Escalate to SIGKILL on the group.
   4. As a safety net, run `tree-kill(pid, 'SIGKILL')`.
   5. Emit final status, drain ring buffer.

## Failure & recovery

- App quits while children are running → on next boot, scan the DB for "was running" flags; we can't reattach to PTYs but we can show the user "these apps were running last time — restart?"
- PTY native module fails to load → fall back to plain `child_process.spawn` with `FORCE_COLOR=1`. UI shows a warning banner.
- SQLite corruption → on open failure, back up the file to `*.corrupt.<ts>` and create a fresh DB. Surface a one-time toast.
- Node version requested but not installed → block start; show "Install v20.11.0 with nvm" with a copy-to-clipboard command. Do not auto-install.

## Auto-update

`electron-updater` configured against a GitHub releases feed (or S3 later). Code signing + notarization wired from day one — see `04-ui.md` for the in-app update banner.
