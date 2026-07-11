# 07 - MCP server (F22)

DevHarbor exposes a local HTTP MCP (Model Context Protocol) server so coding agents and
LLM-powered tools can manage dev servers through DevHarbor instead of spawning `npm run dev`
in a shell they then lose track of. The agent gets structured tools; the user keeps one
place where every process is visible, logged, port-tracked, and cleanly stoppable.

The contract, stated in the server instructions every client receives on initialize and
reinforced in the lifecycle tool descriptions: **agents never run project dev servers
directly - they register and control them through DevHarbor.**

## Goals

1. A configurable, localhost-only, token-protected HTTP MCP server inside the main process.
2. A complete tool catalog: list/add/inspect/update/remove apps, start/stop/restart apps
   and tasks, read and search logs, ports, env vars, run history, node versions.
3. An honestly stated, tightly gated attack surface: off by default, bearer-token auth on
   by default, Host/Origin validated, stored secret values masked and redacted from log
   output. Stated plainly: the token is an execute-code-as-you credential (register a path,
   start its scripts), so protecting it IS the security model.
4. First-class setup UX: a Settings section with live status, token management, and
   copy-paste client config.

## Non-goals

- Remote (non-loopback) access. The listener binds `127.0.0.1` only, not configurable.
- MCP resources/prompts, notifications, or SSE streaming. Tools only, stateless transport.
  (Streaming log subscriptions are a possible later addition; see Future work.)
- Writing secret values back to agents. Secrets stay write-only through MCP.
- Windows/Linux differences: same code path, macOS is the shipping target as everywhere else.

## Architecture

New module `src/main/mcp/`:

| File | Responsibility |
|---|---|
| `McpService.ts` | Lifecycle: `start()`, `stop()`, `applySettings()`. Owns the `node:http` server bound to `127.0.0.1:<port>`, request gatekeeping (path, Host, Origin, auth), per-request MCP server construction, status snapshot + `onStatus` event for the UI. |
| `tools.ts` | `registerTools(server, ctx)` - the whole tool catalog against the injected service context. |
| `gate.ts` | Pure gatekeeping: exact-loopback Host/Origin checks, bearer parse + sha256/timingSafeEqual compare. No electron/db imports, so it unit-tests under plain node. |
| `hygiene.ts` | Pure log hygiene: ANSI strip (CSI + OSC), secret redaction, tail. Same import discipline. |
| `token.ts` | Bearer-token persistence only: create/load/rotate in the `settings` table under `mcp_token`, encrypted with `safeStorage` using the same `enc1:` prefix convention as EnvStore. Comparison logic lives in gate.ts, deliberately. |
| `tls.ts` | HTTPS material for `mcp_https`: loads or generates a self-signed localhost certificate (SAN: `localhost`, `127.0.0.1`, `::1`, RSA 2048, 10 years) under `userData/mcp-tls/` via the system `openssl`, using a config file rather than `-addext` so older LibreSSL works. Key file chmod 600. Pure fs + child_process - the directory is injected, so it unit-tests under plain node. |

Dependency: `@modelcontextprotocol/sdk` (1.29.x) + `zod` (3.25.x) in `dependencies`
(main-process externalized, shipped in the asar like better-sqlite3 and friends).

### Transport: stateless Streamable HTTP

Per request: McpService buffers the request stream ITSELF, counting actual bytes received
(never trusting Content-Length - chunked encoding can lie); on overflow past 4 MB it
responds 413 and destroys the socket, on JSON parse failure 400. SDK 1.29's own body read
is a bare `req.json()` with no size limit, so the cap only exists if we do this. The
pre-parsed body then goes to a fresh `McpServer` + `StreamableHTTPServerTransport` with
`sessionIdGenerator: undefined` and `enableJsonResponse: true` via
`handleRequest(req, res, body)`. No session table, no cleanup races, and a client that
reconnects after an app restart just keeps working. Tool registration per request is a few
object allocations; the underlying services are singletons.

**Response-time budget.** The SDK client's default request timeout is 60 s, and
`readiness_timeout_ms` defaults to 60 s PER topo level - so awaiting full readiness can
deterministically outlive the client. `start_app`/`restart_app`/`start_task(wait)` therefore
await readiness up to a 45 s budget; if the app is still coming up they return a non-error
"still starting" result with per-task states and ports so far, plus an instruction to poll
`get_app`. The underlying orchestrator operation keeps running - the per-app lock keeps it
coherent. The fast-failure path (crash, compile error) stays well inside the budget and
returns the log tail as designed.

- `POST /mcp` - the MCP endpoint.
- `GET /healthz` - unauthenticated `{ ok: true }` liveness probe (leaks nothing but presence).
- `GET|DELETE /mcp` - 405 (stateless mode has no server-push stream to offer).
- Anything else - 404.

### HTTPS mode

`mcp_https` (default off) serves the same endpoint over TLS. On first enable, `tls.ts`
generates a self-signed certificate for `localhost`/`127.0.0.1`/`::1` under
`userData/mcp-tls/` and the listener becomes `https.createServer` with it; the status URL,
Settings UI, and client-config snippet switch to `https://`. Clients must trust the
certificate (the UI shows its path; e.g. `NODE_EXTRA_CA_CERTS` for Node-based clients, or
add it to the login keychain). Certificate setup failure fails CLOSED: the listener does
not fall back to plain HTTP - it stays down with `lastError` explaining why. Honest scope
note: on a single-user loopback the practical gain is wire encryption against local
packet capture and client policies that require `https://` URLs; the bearer token remains
the real access control either way. Toggling `mcp_https` bounces the listener (like a
port change).

### Readiness honesty

A task with `readiness: { kind: 'none' }` has NO probe - the runner's internal `ready`
flag is vacuously true the moment it spawns, which field feedback showed reads as a false
positive (the process was up while its backend reported not-ready for several more
seconds). The MCP surface therefore never presents unprobed readiness as `true`:

- Task-level `ready` is `true`/`false` only when the task has a real probe; it is `null`
  when `readiness.kind === 'none'` (unknown, not verified).
- Separately, task-level `listening` is a factual port-derived signal: `true`/`false`
  whether the task has ≥1 detected listening port, `null` when not running. This is
  deliberately NOT folded into `ready` - a port being open is not the same as the service
  being able to serve (an API opens its port before its DB/cache connect), which is exactly
  the church-portal case that motivated the honesty work. `listening` answers "is anything
  bound"; `ready` answers "did a probe confirm it is serving".
- The start tools' header reports `readinessVerified`: `true` (every running task probed
  and ready), `false` (a probed task failed), or `null` (at least one running task has no
  probe). The `null` note now distinguishes listening-but-unverified from not-listening,
  and points at `set_readiness`.
- For a running-but-unprobed task, the start tools include its recent log tail anyway
  (labeled as such), so the agent can judge readiness from the output in one call instead
  of guessing or curling the service blind.

**Making readiness verifiable.** `set_readiness` configures a task's probe - `port`, `log`,
`http`, `delay`, or `none` - so a subsequent start returns `readinessVerified: true` and
holds until the service actually serves. The `http` kind (new `ReadinessSignal` variant
`{ kind: 'http', url, status? }`) polls a URL until it returns the expected status (default
any 2xx/3xx) and is the correct fit for a service that binds its port before it can serve:
point it at a `/health` or `/ready` endpoint. A `port` probe would call such a service
ready too early; `http` does not. The `http` url is restricted to loopback
(`127.0.0.1`/`localhost`/`[::1]`) - the main process polls it, so a non-loopback host would
be an SSRF/egress primitive - and TLS is skipped only for loopback (self-signed dev certs).

**Config-vs-live honesty.** `set_readiness` edits the STORED config; it takes effect on the
next start, not immediately. So `ready`/`readinessVerified` are derived from the readiness
kind the LIVE run was spawned with (`RunningTask.readinessKind`), NOT the stored config -
otherwise setting an `http` probe on an already-running probe-less task would flip
`ready: null → true` for a probe that never executed, re-introducing the false positive.

### Ports in start results

Port discovery is asynchronous (an lsof/ps tick every ~2s), so a start result would
naturally race it and report `ports: []` for an app that is about to expose three. The
start tools wait for detection in two phases: (1) up to 3s for the FIRST port - if none
appears the task is likely portless (a worker/builder) and the wait ends; (2) once a port
is seen, keep polling until the port set stops GROWING for ~2.4s (deliberately longer than
the ~2s detection tick, so a port that binds during the wait gets at least one tick to
surface before we call it stable), bounded by a ~12s hard cap. Phase 2 is what catches a slow sibling: field feedback showed a turbo monorepo whose
API on `:4000` (tsx watch + Postgres/Redis connect) bound several seconds after web/:3000,
so the old "first port + fixed 700ms settle" returned before `:4000` existed. This remains
best-effort - a service slower than the hard cap still shows up on a later `get_ports` -
and `set_readiness` (e.g. an `http` probe) is the way to make the start actually WAIT until
such a service is serving. Callers that need instant returns use `wait: false` on
start_task.

### Port ownership labels

The PortDetector tick already attributes each listening port to a pid (that is how ports
map to tasks); the same single `ps` snapshot now also carries each pid's command line, so
DevHarbor can label WHICH process inside a task owns a port - the answer to "one turbo
task, three anonymous ports". `get_ports` and the task objects in `get_app`/start results
include `portDetails: [{ port, pid, process }]`, where `process` is a shortened command
(absolute path segments reduced to basenames, capped length; processes that retitle
themselves, like `next-server (v15)`, label for free). Command lines can carry secrets as
CLI arguments, so process labels go through the same known-secret redaction as log text.
Log-hinted ports that lsof has not confirmed yet have `pid: null`.

### Request gatekeeping (in order)

1. **Host allowlist**: the `Host` header's hostname (port stripped) must EXACTLY equal
   `127.0.0.1`, `localhost`, or `[::1]` - strict equality, never a suffix/substring test
   (`localhost.evil.com` must fail). Otherwise 403. This blocks DNS-rebinding: a malicious
   page at `evil.com` resolving to 127.0.0.1 sends `Host: evil.com`. Applies to EVERY path
   including `/healthz` (only the auth step is skipped there), so rebinding cannot even
   probe for DevHarbor's presence.
2. **Origin check**: if an `Origin` header is present (a browser context), its hostname must
   also be exactly loopback, else 403. Loopback origins stay allowed so MCP Inspector works.
   No CORS headers are ever emitted, so cross-origin browser reads fail regardless.
3. **Auth**: when `mcp_require_auth` is on (default), `Authorization: Bearer <token>` must
   match the stored token. Both sides are sha256-hashed to equal-length buffers before
   `crypto.timingSafeEqual` - the raw comparison throws on attacker-controlled length
   mismatch, and a length pre-check would leak length. Otherwise 401 with
   `WWW-Authenticate: Bearer`. The token is a 32-byte random hex string, generated on first
   enable, encrypted at rest, shown and copyable in Settings.

**What the token actually protects.** `add_app` on an arbitrary path plus `start_app` runs
that project's package.json scripts as the user; `set_env_var` can set variables like
`NODE_OPTIONS` that the next start executes. Holding the token is therefore equivalent to
running commands as the user. That is inherent to what DevHarbor is (it runs dev servers),
not an implementation flaw - but it is why auth defaults on, why the auth-off warning says
"any local process can run commands as you through DevHarbor", and why scoped tokens are
listed under future work.

**DoS bounds** (loopback-only, but gatekeeping runs after headers arrive): explicit
`headersTimeout` (10s) so dribbled headers can't hold sockets; `requestTimeout` disabled
deliberately because tool calls legitimately block for readiness (up to
`readiness_timeout_ms` per level); `maxConnections` 32; the 4 MB body cap counts bytes as
they stream in and destroys the socket on exceed - never trusts Content-Length, never
buffers past the cap.

Security posture summary: off by default; loopback bind; Host+Origin validated; token by
default; stored secret values masked in env responses and redacted from log output; body
capped while streaming; bounded connections; no state shared between requests. Turning
`mcp_require_auth` off is allowed (some clients cannot send headers) but the UI warns
plainly that any local process can then run commands as the user.

### Lifecycle wiring

`McpService` is constructed in `registerAllIpcHandlers` alongside the other services (it
needs the same singletons), before the auto-start loop. Start is fire-and-forget
(`registerAllIpcHandlers` is synchronous; the Updater precedent). It starts on boot when
`mcp_enabled`. Settings semantics: only `mcp_port` changes and enable/disable bounce the
listener; `mcp_require_auth` and token rotation are evaluated per request and need no
restart, so flipping the auth toggle never kills an agent's in-flight call. A listener
bounce destroys in-flight request sockets - the underlying tool operations run to
completion and the client retries.

Quit ordering matters: `IpcRuntime` grows a `disposeServices()` member that index.ts calls
at teardown START - in the zero-tasks fast path before `closeDb()`, and in the confirm path
immediately after the user confirms "Stop & Quit", BEFORE `stopAllRunning()` (not before
the dialog - Cancel must leave the server running). Otherwise an agent could `start_app`
DURING the multi-second teardown and spawn a process that outlives the app as an orphan,
the exact failure DevHarbor exists to prevent. McpService also carries a `disposed` flag
its request handler checks, so anything arriving after stop() gets a fast 503 instead of
running tools against a closing DB. `db:reset` hard-exits without before-quit, so nothing
may depend on graceful stop always running. `EADDRINUSE` and other listen errors do not
crash the app: the service lands in `{ running: false, lastError }`, pushes a status event,
and the Settings UI shows it.

Everything `McpService` needs arrives by constructor injection (settings, token store, the
tool context, a status callback) so vitest can boot it with plain fakes - the test
environment is node and must never transitively import `electron` or better-sqlite3.

### Operations reuse: AppOps

The IPC handlers own non-trivial flows the MCP tools must not duplicate-and-drift from:
atomic create-with-rollback (`apps:create`), remove guards, watcher (re)wiring on
add/update/remove, folder scanning, global log search. These move into
`src/main/services/AppOps.ts`, constructed with the app/task registries, EnvStore
(createApp writes initial env vars), DetectionService (scanFolder + detection-driven
defaults), both watchers, the orchestrator (guards + runner buffer access), and an
`onAppsChanged` callback (tray refresh). IPC handlers and MCP tools both delegate to it,
so there is exactly one implementation of each flow. The extraction is a code move plus
three deliberate behavior fixes (below) - the searchLogs one is renderer-visible (global
search now also finds recently exited tasks) and intentional.

AppOps also fixes three latent issues while extracting:

- `createApp` validates the path exists (directory) before `realpathSync`, so a bad path
  reads "Invalid path", not a raw ENOENT.
- `searchLogs` strips `g`/`y` regex flags (a stateful `RegExp.test` silently skips matches)
  and searches every registered task's buffer via `readBuffer` instead of only live tasks,
  so recently exited tasks (buffers live ~10 minutes past exit) remain searchable.
- The remove/stop guards stay in AppOps, not the IPC layer, so no caller can bypass them.

### Log hygiene

Task buffers contain raw ANSI (CSI and OSC sequences). Every MCP response that carries log
text - `get_logs`, `search_logs`, and the failure tails in the start/restart tools - goes
through one hygiene pass:

1. **ANSI strip** (CSI and OSC sequences both - the readiness watcher's regex misses OSC).
2. **Secret redaction**: dev servers print secrets (`console.log(process.env)`, connection
   strings in stack traces, dotenv debug output). DevHarbor knows the plaintext of every
   stored secret env var, so every occurrence of a known secret value (all scopes, length
   >= 4 to avoid mangling output on trivial values) is replaced with `[redacted]` before
   the text leaves the process. Without this, `get_logs` would quietly bypass the
   list_env_vars masking. Secrets a dev server invents on its own (not stored in DevHarbor)
   cannot be redacted - the spec and README say so rather than overclaiming.

Buffers are memory-only: they expire ~10 minutes after task exit and never survive an app
relaunch, and tools say so when they come back empty.

## Settings

New keys (settings table, `Settings.ts` + `SettingsState`):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mcp_enabled` | boolean | `false` | Run the MCP server. |
| `mcp_port` | number | `6872` | Listen port (1024-65535, loopback only). |
| `mcp_require_auth` | boolean | `true` | Require the bearer token. |
| `mcp_https` | boolean | `false` | Serve over TLS with the self-signed localhost certificate. |

`mcp_token` also lives in the settings table but not in `SettingsState`: it is not a
renderer-editable setting and must not ride along every `settings:get`. It is reachable
only through the dedicated IPC below.

## IPC additions

| Channel | Shape | Notes |
|---|---|---|
| `mcp:status` (invoke) | `void → McpStatus` | `{ enabled, running, port, url, requireAuth, https, certPath, lastError, tokenStoredPlaintext }` |
| `mcp:token` (invoke) | `void → string \| null` | Plaintext token for display/copy. Null when auth off or never generated. |
| `mcp:regenerateToken` (invoke) | `void → string` | Rotates the token; takes effect on the next request. |
| `mcp:status` (event) | `McpStatus` | Pushed on start/stop/error/settings change. |

`settings:set` gains a side effect: any `mcp_*` key change calls
`mcpService.applySettings()` (start/stop/restart as needed), which pushes the status event.

## Tool catalog

Naming: `snake_case`, verb-first. Server identity: name `devharbor`, version = app version.
Server `instructions` (sent to every client on initialize) state the contract:

> DevHarbor manages local dev servers. Never start project dev servers, watchers, or build
> daemons by running shell commands yourself - register the project as a DevHarbor app and
> use these tools to start, stop, and inspect it. Processes started through DevHarbor keep
> running after your session, stay visible to the user, and get logs, port tracking, and
> clean shutdown for free. Apps are addressed by id, exact name, or absolute path.
> Monorepos: register the repo once with add_app({ path, workspaceTasks: true }) - one task
> per workspace package; add_task/remove_task adjust the set, set_readiness probes each
> service. Do not register workspace subdirectories as separate apps.

Most tool results are a single JSON text block (`JSON.stringify(..., null, 2)`). The
exception is log-bearing output - `get_logs`, `search_logs`, and the failure tails in the
start/restart tools - which would otherwise double-escape hundreds of newline/quote-heavy
lines inside a JSON string. Those return TWO text blocks: a small JSON header (app, task,
liveness, line count, expiry note) followed by the raw log text. Failures an agent can act
on (unknown app, ambiguous name, app already running, port conflict) return
`isError: true` with a one-line reason plus, where useful, the candidate list.

The never-run-servers-yourself contract lives in the server `instructions` (with a concrete
substitution recipe: instead of `npm run dev`, call `add_app` then `start_app`) and in the
descriptions of the three entry-point tools (`get_overview`, `add_app`, `start_app`) only.
Repeating it in all tool descriptions would burn ~600 tokens of every agent context for no
compliance gain.

### Addressing

- `app` parameter accepts an app id, exact name (case-insensitive), or absolute path.
  Inbound paths are trailing-slash-stripped and realpath'd before comparison (symlinks,
  `/var` vs `/private/var`); relative paths return an error saying the path must be
  absolute. Ambiguous names return an error listing the matching ids. Unknown returns an
  error naming the nearest matches.
- `task` parameter accepts a task id, or a task name scoped by the `app` parameter. A task
  name without `app` resolves only if globally unique, otherwise errors with the
  app/task candidates.

### Read-only tools (`annotations.readOnlyHint: true`)

| Tool | Input | Output (JSON) |
|---|---|---|
| `get_overview` | - | App count, running/crashed counts, active ports, DevHarbor version. The cheap first call. |
| `list_apps` | `state?` filter | Per app: id, name, path, state, ports, tags, folder, defaultScript, packageManager, autoStart, lastStartedAt. |
| `get_app` | `app`, `runs_limit? (default 5)` | Full app record + tasks (command, dependsOn, readiness, enabled, plus live state/ready/ports/cpu/memMB) + env file names + recent runs. Subsumes what separate list_tasks / run-history tools would return - fewer schemas in every agent context. |
| `list_running` | - | Every live task: app, task, pid, state, ready, uptime, cpu, memMB, ports. |
| `get_logs` | `app`, `task?`, `lines? (default 100, max 1000)` | Ring-buffer tail. Without `task`: every buffered task of the app, labeled. Notes whether the task is live. |
| `search_logs` | `query`, `regex? (default false)`, `app?`, `limit? (default 100)` | Literal substring by default; `regex: true` for patterns (invalid patterns error rather than silently degrading). The header states how the query was interpreted. Searches all buffered task output, including tasks that exited in the last ~10 minutes. |
| `list_env_vars` | `app`, `task?` | Keys with scope + enabled + isSecret. Values shown for non-secret vars only; secret values are masked, always. |
| `get_ports` | `port?` | All listening ports grouped by app; with `port`, who owns it (or that nothing tracked does). |
| `scan_folder` | `dir` | Import candidates one level deep: path, name, packageManager, scripts, alreadyRegistered. |
| `list_node_versions` | - | Installed Node versions and their source (nvm/fnm/volta/asdf/system). Its actuator is `update_app.nodeVersion`. |

### Mutating tools

| Tool | Input | Behavior |
|---|---|---|
| `add_app` | `path`, `name?`, `script?`, `command?`, `workspaceTasks?`, `autoStart?` | Detection-driven create, same atomic flow as the UI (AppOps). Default task chosen as `script` (explicit) -> `command` (explicit raw command) -> the detected default script - so an agent's explicit input always wins over detection, and script-less projects are not a dead end. **Monorepos**: `workspaceTasks: true` creates one task per detected workspace package (same detection and mapping as the UI's "create a task per workspace package" - name, suggested script, `workingDirOverride` = package dir); packages without runnable scripts are skipped, and if nothing is runnable it falls back to the single default task with a note. The response includes the detected scripts, the created task names, and any detected workspace candidates; when a monorepo is registered WITHOUT the flag, a note points at the per-service options. Duplicate path returns the existing app with a note (plus add_task guidance if it is a monorepo and workspaceTasks was requested). |
| `update_app` | `app` + any of `name`, `defaultScript`, `autoStart`, `autoRestartOnChange`, `watchGlobs`, `tags`, `folder`, `portHint`, `nodeVersion` | Patches via AppOps so watchers resync. `nodeVersion` accepts `"auto"`, `"system"`, or an explicit version - the actuator for `list_node_versions`. |
| `remove_app` | `app`, `confirm` | `destructiveHint`. Refuses unless `confirm: true`. Refuses while live (same guard as UI). Does not touch files on disk - only the registration. |
| `start_app` | `app` | Awaits the full topo start including readiness. `startApp` resolving does NOT mean success (readiness failure resolves too), so the tool re-reads `appState` and reports the real final state, per-task states, and ports. Includes the last 30 log lines of every task that did not reach ready - crashed OR alive-but-not-ready (a dev server that printed a compile error and kept running is the common agent-caused failure) - so the agent can diagnose without a second call. Unknown apps are pre-validated against the registry (the orchestrator's own error for that case is misleading). |
| `stop_app` | `app` | Reverse-topo graceful stop (SIGTERM, grace, SIGKILL tree). Returns final state. |
| `restart_app` | `app` | Stop + start under one lock. Idempotent on a stopped app (just starts). Same result shape as `start_app`. |
| `start_task` | `task` (+ `app`), `wait? (default true)` | Starts one task. With `wait`, awaits the readiness outcome and reports like `start_app` (including the not-ready tail); `wait: false` returns the spawn snapshot immediately. |
| `stop_task` | `task` (+ `app`) | Stops one task. |
| `set_env_var` | `app`, `key`, `value`, `secret?`, `enabled?` | Upserts an app-scoped var. `secret` defaults to the shared `isSecretKey` heuristic; the response reports the resolved flag and notes that explicit `secret: false` overrides the heuristic. Secret values are write-only through MCP - stated in the description. Takes effect on next start; the response says so. |
| `set_readiness` | `app`, `task`, `kind` (`none`/`port`/`log`/`http`/`delay`) + kind fields | Configures how DevHarbor decides the task is READY, so a later start returns `readinessVerified: true` and waits until it is serving. Validates the required field per kind (port/regex/url/ms) and the url/regex themselves. Takes effect on next start. This is the answer to a `ready: null` task. |
| `add_task` | `app`, `name`, `script` XOR `command`, `workingDir?`, `dependsOn?`, `oneShot?`, `enabled?` | Adds a per-service task - the building block for monorepo structure an agent shapes itself. `workingDir` is validated as an existing subdirectory relative to the app root (no absolute paths, no `..`). `dependsOn` accepts task ids or names within the app; cycle detection is TaskRegistry's (throws with the cycle path, surfaced as the tool error). Task names must be unique within the app so they stay addressable. `oneShot: true` (migrations, builds) defaults readiness to `exit: 0` so dependents wait for completion; long-running tasks default to `none` with set_readiness as the follow-up. |
| `remove_task` | `app`, `task`, `confirm` | `destructiveHint`. Refuses unless `confirm: true`, while the task is running, and while other tasks depend on it (TaskRegistry's guard names the dependents). Task-scoped env vars are deleted with it (FK cascade); files on disk untouched. |

22 tools. Task lifecycle, per-service task structure (monorepos), and the readiness/env
config an agent needs to make a project actually verifiable. Task reordering/rename,
folder CRUD, and settings stay UI-only on purpose: the MCP surface is for operating apps,
not administering DevHarbor.

## Settings UI (SettingsDrawer)

New "MCP server" section, after the existing sections and before the danger zone:

- Enable toggle with a one-line explanation ("Let coding agents manage your dev servers
  through DevHarbor").
- Status row: dot + "Running at `http://127.0.0.1:6872/mcp`" / "Stopped" / error text
  (e.g. port in use), live via the `mcp:status` event.
- Port input (numeric, 1024-65535), applied on commit, server restarts in place.
- "Require auth token" toggle; when off, an inline warning that any local process can
  control DevHarbor.
- Token row (only when auth on): masked value, Copy, Regenerate (confirm modal - old token
  stops working immediately).
- "Client setup" block: copyable JSON config for MCP clients
  (`{"mcpServers":{"devharbor":{"type":"http","url":...,"headers":{"Authorization":"Bearer ..."}}}}`).

Renderer state follows the house rules: zustand selectors return stable refs, IPC via
`invokeOrToast`, dialogs via the `useDialog` stack.

## Failure modes

| Failure | Behavior |
|---|---|
| Port in use | Server not running, `lastError` set, status event, Settings shows the error. App unaffected. |
| Invalid token from client | 401 per request. Never crashes, never logs the attempted token. |
| Tool throws (unknown app, task registry error) | Caught per call, returned as `isError` result with the message. Transport stays healthy. |
| `safeStorage` unavailable (rare: no Keychain) | Unlike EnvStore's silent plaintext fallback, the token is a security credential: it is still persisted (clients must survive restarts) but the status reports `tokenStoredPlaintext: true` and Settings shows a warning that file permissions are the only protection. Auth still enforced. |
| HTTPS certificate generation/read fails | Listener stays DOWN with `lastError` (never a silent fallback to plain HTTP); disable `mcp_https` to serve over HTTP again. |
| Body over 4 MB / invalid JSON | 413 (socket destroyed, cap counted while streaming) / 400 before any MCP processing. |
| Slow tool call vs client timeout | SDK clients default to a 60 s request timeout; the start tools return a "still starting" result at 45 s instead of racing it. |
| App quit | `disposeServices()` closes the listener and in-flight sockets BEFORE `stopAllRunning()`, so no tool can spawn a process mid-teardown; late requests get 503 via the `disposed` flag. |
| db:export backup | Contains `mcp_token` (ciphertext under Keychain; plaintext in the fallback case - regenerate the token after sharing an export). |

## Testing

- **Unit (vitest, node env, no native deps)**: `gate.ts` (host/origin allow list, bearer
  parse + sha256/timingSafeEqual compare incl. wrong-length input) and `hygiene.ts` (ANSI
  strip, secret redaction, tail) - both dependency-free by design. Plus the app/task
  resolver (id, name, ambiguous, path) and tool result shapes against a scripted fake
  context. Nothing in the unit suite imports electron or better-sqlite3.
- **Catalog (vitest)**: `registerTools` against a fake `McpServer` + in-memory context - all
  22 tools registered with correct read-only/destructive hints, and per-tool behavior
  (overview counts, list filtering, env masking, log ANSI-strip + secret redaction, the
  remove confirm/running guards, start_app state re-read + crash tail, add_app dedupe). No
  electron import, so it runs in the node env.
- **Live HTTP (Electron E2E harness)**: `McpService` transitively imports electron (Logger,
  safeStorage), so the real listener + transport + gatekeeping are driven from the packaged
  app under Electron, not vitest - see the E2E step below. It uses the real SDK `Client` +
  `StreamableHTTPClientTransport`: initialize, tools/list, representative calls, 401 without
  token, 403 with a bad Host, 405 on GET.
- **E2E (manual harness, packaged app)**: dir-build via electron-builder, launch with a
  throwaway profile, enable via seeded settings, then run the full client script against a
  real sample project: add, start, status, ports, logs, search, env, restart, stop,
  history, remove, plus the auth/Host negative cases.

## Future work

- Log streaming to agents (stateful sessions + `notifications/resources/updated` or SSE).
- `update_task` (rename, re-point dependsOn, toggle enabled) if agent demand shows up -
  add_task/remove_task shipped with the monorepo round; set_readiness already covers the
  most-edited field.
- Scoped tokens (read-only token vs control token).
- An MCP resource exposing the app list for clients that prefer resources over tools.
