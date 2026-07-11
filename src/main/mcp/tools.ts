import { z } from 'zod';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  App,
  AppId,
  NodeVersionPref,
  ReadinessSignal,
  Task,
  TaskId,
  WorkspaceCandidate
} from '@shared/types';
import type { CreateAppInput, CreateTaskSpec } from '@shared/ipc';
import { isSecretKey } from '@shared/dotenv';
import {
  allSecretValues,
  resolveApp,
  resolveTask,
  ResolutionError,
  secretValuesForApp,
  type McpToolContext
} from './context.js';
import { isLoopbackHostname } from './gate.js';
import { cleanLogText, redactSecrets } from './hygiene.js';

/** SDK CallToolResult subset we produce. */
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** How long the start/restart tools await readiness before returning "still starting" so
    they never race the MCP client's default 60s request timeout (see spec). */
const START_BUDGET_MS = 45_000;

function jsonResult(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** JSON header block + a raw log-text block (avoids double-escaping many log lines). */
function logResult(header: unknown, logText: string): ToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(header, null, 2) },
      { type: 'text', text: logText || '(no buffered output)' }
    ]
  };
}

function cleanMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function aggregatePorts(ctx: McpToolContext, appId: AppId): number[] {
  const ports = new Set<number>();
  for (const rt of ctx.runner.list()) if (rt.appId === appId) for (const p of rt.ports) ports.add(p);
  return [...ports].sort((a, b) => a - b);
}

/**
 * Port-ownership labels for one task, with known secret values redacted - command lines
 * can carry secrets as CLI args (--api-key=...), the same leak class as log output.
 */
function portOwnersFor(
  ctx: McpToolContext,
  taskId: TaskId,
  secrets: string[]
): Array<{ port: number; pid: number | null; process: string | null }> {
  return ctx.runner.ports.portOwners(taskId).map((o) => ({
    ...o,
    process: o.process ? redactSecrets(o.process, secrets) : o.process
  }));
}

/** Per-port ownership labels across an app's live tasks (which process serves which port). */
function aggregatePortDetails(
  ctx: McpToolContext,
  appId: AppId,
  secrets: string[]
): Array<{ port: number; pid: number | null; process: string | null; task: string }> {
  const out: Array<{ port: number; pid: number | null; process: string | null; task: string }> = [];
  for (const t of ctx.taskRegistry.list(appId)) {
    for (const o of portOwnersFor(ctx, t.id, secrets)) {
      out.push({ ...o, task: t.name });
    }
  }
  return out.sort((a, b) => a.port - b.port);
}

/**
 * Wait for port detection to catch up so a start result includes the ports (discovery is an
 * async lsof/ps tick, ~2s). Two phases:
 *
 *   1. Wait up to FIRST_PORT_MS for the FIRST port. If none appears, the task is probably
 *      portless (a worker/builder) - return rather than stall the whole budget on it.
 *   2. Once a port is seen, keep polling until the port SET stops growing for STABLE_MS
 *      (bounded by HARD_CAP_MS). This catches a sibling whose detection lands within one
 *      stability window of the previous port - e.g. a monorepo web+API where the API binds
 *      a beat behind the web server (the old "first port + fixed settle" missed even that).
 *      It is NOT a guarantee: a sibling that binds more than STABLE_MS after the last
 *      detection (an API stuck several seconds on DB/cache connects) is still missed here
 *      and surfaces in get_app/get_ports on a later detection tick. The reliable fix for
 *      those is a readiness probe (set_readiness): start then waits for readiness first,
 *      so the late port is already bound by the time this wait runs.
 *
 * The port source is injected, NOT hardcoded to the app: for start_task we poll the ONE
 * task's ports, so a sibling task already listening can't satisfy the check before the
 * just-started task's own port is detected.
 */
const FIRST_PORT_MS = 3000;
// Must exceed PortDetector's poll interval (2000ms): a port that binds during the wait is
// only SURFACED on the next detection tick, so a stability window shorter than one tick
// would declare "no more ports" before a late sibling was ever detected.
const STABLE_MS = 2400;
const HARD_CAP_MS = 12_000;

async function waitForPorts(portsFn: () => number[], isLive: () => boolean): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const start = Date.now();

  // Phase 1: first port (or give up - likely portless).
  while (Date.now() - start < FIRST_PORT_MS && portsFn().length === 0) {
    if (!isLive()) return;
    await sleep(250);
  }
  if (portsFn().length === 0) return;

  // Phase 2: wait until the port set stops growing.
  let known = portsFn().length;
  let lastGrowth = Date.now();
  while (Date.now() - start < HARD_CAP_MS) {
    await sleep(300);
    if (!isLive()) return;
    const n = portsFn().length;
    if (n > known) {
      known = n;
      lastGrowth = Date.now();
    } else if (Date.now() - lastGrowth >= STABLE_MS) {
      return;
    }
  }
}

/** Wait for an app's ports (any of its tasks). */
function waitForAppPorts(ctx: McpToolContext, appId: AppId): Promise<void> {
  return waitForPorts(
    () => aggregatePorts(ctx, appId),
    () => ctx.runner.list().some((rt) => rt.appId === appId && (rt.state === 'running' || rt.state === 'starting'))
  );
}

/** Wait for a single task's own ports (not its siblings'). */
function waitForTaskPorts(ctx: McpToolContext, taskId: TaskId): Promise<void> {
  return waitForPorts(
    () => ctx.runner.get(taskId)?.ports ?? [],
    () => {
      const st = ctx.runner.get(taskId)?.state;
      return st === 'running' || st === 'starting';
    }
  );
}

function appBrief(ctx: McpToolContext, app: App): Record<string, unknown> {
  return {
    id: app.id,
    name: app.name,
    path: app.path,
    state: ctx.orchestrator.appState(app.id),
    ports: aggregatePorts(ctx, app.id),
    tags: app.tags,
    folder: app.folder,
    defaultScript: app.defaultScript,
    packageManager: app.packageManager,
    autoStart: app.autoStart,
    lastStartedAt: app.lastStartedAt
  };
}

function taskInfo(ctx: McpToolContext, task: Task, secrets: string[]): Record<string, unknown> {
  const rt = ctx.runner.get(task.id);
  // `ready` is a verified answer only when the LIVE run has a real probe. Deriving "probed"
  // from rt.readinessKind (captured at spawn), NOT task.readiness.kind (the stored config),
  // is what stops set_readiness on a RUNNING task from flipping ready:null -> true for a
  // probe that has not executed yet (it takes effect on the next start). `listening` is the
  // factual port-derived signal - NOT the same as "serving" (an API opens its port before
  // its DB connects) - so it is reported separately.
  const probed = rt ? rt.readinessKind !== 'none' : task.readiness.kind !== 'none';
  const ports = rt?.ports ?? [];
  return {
    id: task.id,
    name: task.name,
    commandKind: task.commandKind,
    script: task.script,
    customCommand: task.customCommand,
    workingDir: task.workingDirOverride,
    oneShot: task.oneShot,
    dependsOn: task.dependsOn,
    readiness: task.readiness,
    enabled: task.enabled,
    state: rt?.state ?? 'idle',
    ready: rt ? (probed ? rt.ready : null) : null,
    listening: rt ? ports.length > 0 : null,
    ports,
    portDetails: portOwnersFor(ctx, task.id, secrets)
  };
}

/**
 * Let the task state machine settle one macrotask. TaskRunner flips a task from 'starting' to
 * 'running' on a setTimeout(0), while 'none'-readiness resolves on a microtask - so startApp
 * can resolve a tick before the state flips. Without this, start_app would report "starting"
 * for an app that is actually up.
 */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 40));
}

/** Await a readiness promise, but never longer than `budget` ms. */
async function raceReadiness(
  awaitReady: Promise<boolean>,
  budget: number
): Promise<'ready' | 'not-ready' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), budget);
    timer.unref?.();
  });
  const outcome = await Promise.race([
    awaitReady.then((ok): 'ready' | 'not-ready' => (ok ? 'ready' : 'not-ready')),
    timeout
  ]);
  if (timer) clearTimeout(timer);
  return outcome;
}

/** Build the shared start/restart result: final state, per-task info, ports, failure tails. */
function startResultFor(ctx: McpToolContext, app: App, startError: string | null): ToolResult {
  const state = ctx.orchestrator.appState(app.id);
  const tasks = ctx.taskRegistry.list(app.id).filter((t) => t.enabled);
  const secrets = secretValuesForApp(ctx, app.id);
  const infos = tasks.map((t) => taskInfo(ctx, t, secrets));
  const stillStarting = !startError && state === 'starting';

  // Readiness is only "verified" when every running task has a real probe that fired. Uses
  // the LIVE run's readinessKind (not the stored config), so an edited-but-not-restarted
  // probe can't fake a verified answer.
  let readinessVerified: boolean | null = false;
  if (state === 'running') {
    const runningRts = tasks
      .map((t) => ctx.runner.get(t.id))
      .filter((rt): rt is NonNullable<typeof rt> => rt?.state === 'running');
    if (runningRts.some((rt) => rt.readinessKind === 'none')) {
      readinessVerified = null;
    } else {
      readinessVerified = runningRts.every((rt) => rt.ready === true);
    }
  }

  const tails: string[] = [];
  for (const t of tasks) {
    const rt = ctx.runner.get(t.id);
    const probed = rt ? rt.readinessKind !== 'none' : t.readiness.kind !== 'none';
    if (rt?.state === 'running' && rt.ready && probed) continue; // verified ready - no tail needed
    const raw = ctx.runner.tailBuffer(t.id, 30);
    const cleaned = cleanLogText(raw, secrets);
    if (!cleaned.trim()) continue;
    const label =
      rt?.state === 'running' && !probed
        ? `${t.name} (running, no readiness probe - recent output so you can judge readiness yourself)`
        : `${t.name} (${rt?.state ?? 'idle'})`;
    tails.push(`=== ${label} ===\n${cleaned}`);
  }

  const notes: string[] = [];
  if (stillStarting) {
    notes.push(
      'Still starting after 45s; the start continues in the background. Poll get_app to see when it is ready.'
    );
  }
  if (readinessVerified === null) {
    const anyListening = tasks.some((t) => (ctx.runner.get(t.id)?.ports.length ?? 0) > 0);
    notes.push(
      anyListening
        ? 'No readiness probe is configured (readiness kind "none"). The task is listening on a port, which for many dev servers means ready - but DevHarbor has NOT verified it is serving (an API can open its port before its DB/cache connect). Judge from the log tail below, or call set_readiness (e.g. an http probe on a /health or /ready URL) so a future start returns readinessVerified: true and waits until it is actually serving.'
        : 'No readiness probe is configured (readiness kind "none"), so "running" means the processes are up, not that they are serving. Judge from the log tail below, or call set_readiness to configure a port/log/http probe for a verified answer.'
    );
  }

  const header = {
    app: app.name,
    state,
    readinessVerified,
    stillStarting,
    startError,
    ports: aggregatePorts(ctx, app.id),
    portDetails: aggregatePortDetails(ctx, app.id, secrets),
    tasks: infos,
    note: notes.length ? notes.join(' ') : undefined
  };
  return tails.length ? logResult(header, tails.join('\n\n')) : jsonResult(header);
}

/** Canonicalize an absolute path the way app.path is stored (realpath, trailing slash off). */
function canonicalize(p: string): string {
  const trimmed = p.replace(/\/+$/, '') || '/';
  try {
    return realpathSync(trimmed);
  } catch {
    return trimmed;
  }
}

function nodeVersionPrefFrom(value: string): NodeVersionPref {
  if (value === 'auto') return { kind: 'auto' };
  if (value === 'system') return { kind: 'system' };
  return { kind: 'explicit', version: value };
}

const READ_ONLY: Record<string, unknown> = { readOnlyHint: true };

/**
 * Register the full DevHarbor tool catalog on `server` (see specs/07-mcp-server.md). Each
 * handler is wrapped so a thrown ResolutionError (or any error) becomes a clean isError
 * result rather than a transport fault.
 */
export function registerTools(server: McpServer, ctx: McpToolContext): void {
  const tool = (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema?: z.ZodRawShape;
      annotations?: Record<string, unknown>;
      /** When true, a successful (non-error) call nudges the desktop UI to re-sync. */
      mutates?: boolean;
    },
    handler: (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>
  ): void => {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema ?? {},
        annotations: { title: config.title, ...config.annotations }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any) => {
        try {
          const result = await handler(args ?? {});
          // Tell the desktop UI to re-sync after a state change (the renderer only tracks its
          // own actions otherwise). Only on a non-error result.
          if (config.mutates && !result.isError) ctx.notifyChanged();
          return result;
        } catch (e) {
          if (e instanceof ResolutionError) return errorResult(e.message);
          return errorResult(cleanMessage(e));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    );
  };

  // --- Read-only -----------------------------------------------------------------------------

  tool(
    'get_overview',
    {
      title: 'Overview',
      description:
        'Snapshot of everything DevHarbor manages: app count, how many are running or crashed, and which ports are active. Call this first to orient yourself. DevHarbor runs local dev servers on the user\'s behalf - to run a project, register it with add_app and start it with start_app instead of running npm/yarn/pnpm in your own shell.',
      annotations: READ_ONLY
    },
    () => {
      const apps = ctx.registry.list();
      let running = 0;
      let crashed = 0;
      const ports = new Set<number>();
      for (const a of apps) {
        const st = ctx.orchestrator.appState(a.id);
        if (st === 'running' || st === 'starting') running++;
        if (st === 'crashed') crashed++;
        for (const p of aggregatePorts(ctx, a.id)) ports.add(p);
      }
      return jsonResult({
        devharborVersion: ctx.appVersion,
        appCount: apps.length,
        running,
        crashed,
        activePorts: [...ports].sort((a, b) => a - b),
        apps: apps.map((a) => ({ name: a.name, state: ctx.orchestrator.appState(a.id) }))
      });
    }
  );

  tool(
    'list_apps',
    {
      title: 'List apps',
      description:
        'List registered apps with their current state, ports, tags, and folder. Optional `state` filters to just apps in that lifecycle state.',
      inputSchema: {
        state: z
          .enum(['idle', 'starting', 'running', 'exiting', 'exited', 'crashed'])
          .optional()
          .describe('Only return apps currently in this state.')
      },
      annotations: READ_ONLY
    },
    (args) => {
      const filter = args.state as string | undefined;
      const apps = ctx.registry
        .list()
        .map((a) => appBrief(ctx, a))
        .filter((a) => !filter || a.state === filter);
      return jsonResult({ count: apps.length, apps });
    }
  );

  tool(
    'get_app',
    {
      title: 'Get app details',
      description:
        'Full detail for one app: its config, every task (with live state/ready/ports), discovered .env files, and recent run history. `app` is an app id, exact name, or absolute path.',
      inputSchema: {
        app: z.string().describe('App id, exact name, or absolute path.'),
        runs_limit: z.number().int().min(0).max(50).optional().describe('Recent runs to include (default 5).')
      },
      annotations: READ_ONLY
    },
    (args) => {
      const app = resolveApp(ctx, String(args.app));
      const secrets = secretValuesForApp(ctx, app.id);
      const tasks = ctx.taskRegistry.list(app.id).map((t) => taskInfo(ctx, t, secrets));
      const runs = ctx.runHistory.list(app.id, (args.runs_limit as number | undefined) ?? 5);
      return jsonResult({
        ...appBrief(ctx, app),
        nodeVersionPref: app.nodeVersionPref,
        autoRestartOnChange: app.autoRestartOnChange,
        watchGlobs: app.watchGlobs,
        portHint: app.portHint,
        tasks,
        envFiles: ctx.envFiles(app.id).map((f) => f.name),
        recentRuns: runs.map((r) => ({
          task: r.taskName,
          script: r.script,
          customCommand: r.customCommand,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          exitCode: r.exitCode,
          wasKilledByUser: r.wasKilledByUser
        }))
      });
    }
  );

  tool(
    'list_running',
    {
      title: 'List running tasks',
      description: 'Every currently-live task across all apps with pid, uptime, cpu, memory, and ports.',
      annotations: READ_ONLY
    },
    () => {
      const now = Date.now();
      const allSecrets = allSecretValues(ctx);
      const running = ctx.runner
        .list()
        .filter((rt) => rt.state === 'starting' || rt.state === 'running' || rt.state === 'exiting')
        .map((rt) => {
          // Base "probed" on the LIVE run's readinessKind (captured at spawn), so a
          // set_readiness that hasn't been restarted into effect can't fake a verified ready.
          const probed = rt.readinessKind !== 'none';
          return {
            app: ctx.registry.get(rt.appId)?.name ?? rt.appId,
            appId: rt.appId,
            taskId: rt.taskId,
            pid: rt.pid,
            state: rt.state,
            // null = this task has no readiness probe (or is unresolvable); "up" is not "serving".
            ready: probed ? rt.ready : null,
            listening: rt.ports.length > 0,
            uptimeSec: Math.max(0, Math.round((now - rt.startedAt) / 1000)),
            cpu: rt.cpu,
            memMB: rt.memMB,
            ports: rt.ports,
            portDetails: portOwnersFor(ctx, rt.taskId, allSecrets)
          };
        });
      return jsonResult({ count: running.length, running });
    }
  );

  tool(
    'get_logs',
    {
      title: 'Get logs',
      description:
        'Recent log output for an app (or one task of it). Returns a JSON header plus the raw log text. Buffers are in-memory and expire ~10 minutes after a task exits, so recently-stopped tasks may return nothing. Known secret env values are redacted; secrets the dev server prints on its own cannot be.',
      inputSchema: {
        app: z.string().describe('App id, exact name, or absolute path.'),
        task: z.string().optional().describe('Limit to this task (id or name); omit for all of the app\'s tasks.'),
        lines: z.number().int().min(1).max(1000).optional().describe('Lines per task (default 100, max 1000).')
      },
      annotations: READ_ONLY
    },
    (args) => {
      const app = resolveApp(ctx, String(args.app));
      const lines = (args.lines as number | undefined) ?? 100;
      const secrets = secretValuesForApp(ctx, app.id);
      const targetTasks = args.task
        ? [resolveTask(ctx, String(args.task), String(args.app))]
        : ctx.taskRegistry.list(app.id);

      const sections: string[] = [];
      const meta: Array<Record<string, unknown>> = [];
      for (const t of targetTasks) {
        const rt = ctx.runner.get(t.id);
        const raw = ctx.runner.tailBuffer(t.id, lines);
        const cleaned = cleanLogText(raw, secrets);
        meta.push({ task: t.name, live: !!rt, state: rt?.state ?? 'idle', hasOutput: cleaned.trim().length > 0 });
        if (targetTasks.length > 1) {
          sections.push(`=== ${t.name} (${rt?.state ?? 'idle'}) ===\n${cleaned}`);
        } else {
          sections.push(cleaned);
        }
      }
      return logResult(
        { app: app.name, linesPerTask: lines, tasks: meta },
        sections.join('\n\n')
      );
    }
  );

  tool(
    'search_logs',
    {
      title: 'Search logs',
      description:
        'Search buffered log output across tasks, including tasks that exited in the last ~10 minutes. Literal substring by default; set `regex: true` for a pattern. Known secret values are redacted from results.',
      inputSchema: {
        query: z.string().describe('Text to find (literal unless regex is true).'),
        regex: z.boolean().optional().describe('Treat query as a regular expression (default false).'),
        app: z.string().optional().describe('Limit the search to this app.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max matches (default 100).')
      },
      annotations: READ_ONLY
    },
    (args) => {
      const appId = args.app ? resolveApp(ctx, String(args.app)).id : undefined;
      const useRegex = (args.regex as boolean | undefined) ?? false;
      // When the caller asked for regex, an invalid pattern is an error, not a silent
      // downgrade to literal (AppOps keeps that fallback only for the renderer's search).
      if (useRegex) {
        try {
          new RegExp(String(args.query));
        } catch (e) {
          return errorResult(`Invalid regular expression: ${cleanMessage(e)}`);
        }
      }
      const matches = ctx.appOps.searchLogs({
        query: String(args.query),
        regex: useRegex,
        appId,
        limit: (args.limit as number | undefined) ?? 100
      });
      const secrets = appId ? secretValuesForApp(ctx, appId) : allSecretValues(ctx);
      const rows = matches.map((m) => ({
        app: m.appName,
        task: m.taskName,
        line: cleanLogText(m.line, secrets)
      }));
      return jsonResult({
        interpretedAs: useRegex ? 'regex' : 'literal',
        count: rows.length,
        matches: rows
      });
    }
  );

  tool(
    'list_env_vars',
    {
      title: 'List env vars',
      description:
        'Env variables for an app (or one of its tasks). Non-secret values are shown; secret values are masked and never returned through MCP.',
      inputSchema: {
        app: z.string().describe('App id, exact name, or absolute path.'),
        task: z.string().optional().describe('List this task\'s overrides instead of the app scope.')
      },
      annotations: READ_ONLY
    },
    (args) => {
      const app = resolveApp(ctx, String(args.app));
      const vars = args.task
        ? ctx.envStore.getTask(resolveTask(ctx, String(args.task), String(args.app)).id)
        : ctx.envStore.getApp(app.id);
      return jsonResult({
        app: app.name,
        scope: args.task ? 'task' : 'app',
        vars: vars.map((v) => ({
          key: v.key,
          value: v.isSecret ? null : v.value,
          isSecret: v.isSecret,
          enabled: v.enabled
        }))
      });
    }
  );

  tool(
    'get_ports',
    {
      title: 'Get ports',
      description:
        'Listening ports DevHarbor has detected, grouped by app and labeled with the owning process (so in a monorepo task that fans out into several servers you can tell which port is which service). Pass `port` to find who owns a specific port.',
      inputSchema: {
        port: z.number().int().min(1).max(65535).optional().describe('Look up the owner of just this port.')
      },
      annotations: READ_ONLY
    },
    (args) => {
      const wanted = args.port as number | undefined;
      const byApp: Array<{
        app: string;
        ports: number[];
        portDetails: Array<{ port: number; pid: number | null; process: string | null; task: string }>;
      }> = [];
      for (const app of ctx.registry.list()) {
        const ports = aggregatePorts(ctx, app.id);
        if (ports.length === 0) continue;
        if (wanted && !ports.includes(wanted)) continue;
        byApp.push({
          app: app.name,
          ports,
          portDetails: aggregatePortDetails(ctx, app.id, secretValuesForApp(ctx, app.id))
        });
      }
      if (wanted) {
        // Prefer a CONFIRMED owner (pid set) over a log-hinted claim (pid null): a task that
        // printed "Port X in use, trying Y" pins X as a hint for a few seconds, and another
        // app may actually be the one listening on X. Search every matching app, not just
        // byApp[0], and pick the entry with a real pid.
        const claimants = byApp
          .flatMap((a) => a.portDetails.filter((d) => d.port === wanted).map((d) => ({ ...d, app: a.app })))
          .sort((a, b) => (a.pid === null ? 1 : 0) - (b.pid === null ? 1 : 0));
        const best = claimants[0];
        return jsonResult({
          port: wanted,
          owner: best?.app ?? byApp[0]?.app ?? null,
          task: best?.task ?? null,
          process: best?.process ?? null,
          note:
            !byApp.length
              ? 'No task tracked by DevHarbor is listening on that port.'
              : claimants.length > 1
                ? 'Multiple tasks reference this port (one may be a transient log hint); the confirmed owner is reported.'
                : undefined
        });
      }
      return jsonResult({ apps: byApp });
    }
  );

  tool(
    'scan_folder',
    {
      title: 'Scan folder',
      description:
        'Shallow-scan a directory (one level deep) for Node projects to import. Returns each candidate\'s path, package manager, available scripts, and whether it is already registered. Use before add_app to discover projects.',
      inputSchema: {
        dir: z.string().describe('Absolute path of the parent folder to scan.')
      },
      annotations: READ_ONLY
    },
    async (args) => {
      const candidates = await ctx.appOps.scanFolder(String(args.dir));
      return jsonResult({ count: candidates.length, candidates });
    }
  );

  tool(
    'list_node_versions',
    {
      title: 'List Node versions',
      description:
        'Node.js versions installed on this machine and where they came from (nvm/fnm/volta/asdf/system). Set an app\'s version with update_app nodeVersion.',
      annotations: READ_ONLY
    },
    () => jsonResult({ installations: ctx.nodes.list(true) })
  );

  // --- Mutating ------------------------------------------------------------------------------

  tool(
    'add_app',
    {
      title: 'Add app',
      mutates: true,
      description:
        'Register a local Node project so DevHarbor can run it - use this instead of running its dev server yourself. Give the project\'s absolute `path`. For a monorepo, pass `workspaceTasks: true` to create one task per workspace package (pnpm/yarn/npm workspaces), each running its own dev script from its own directory - start_app then runs them all, start_task runs one. Otherwise the default task is chosen in this order: the `script` you name, else a raw `command` you pass, else the project\'s detected default script. Returns the app, its tasks, the detected scripts, and any detected workspace packages.',
      inputSchema: {
        path: z.string().describe('Absolute path of the project directory.'),
        name: z.string().optional().describe('Display name (defaults to the folder name).'),
        script: z.string().optional().describe('package.json script for the default task (e.g. "dev"). Takes precedence over command and detection.'),
        command: z.string().optional().describe('Raw shell command for the default task. Used when you do not pass a script; wins over the auto-detected script.'),
        workspaceTasks: z.boolean().optional().describe('Monorepo: create one task per detected workspace package instead of a single root task. Ignores script/command when packages are found.'),
        autoStart: z.boolean().optional().describe('Start this app automatically when DevHarbor launches.')
      }
    },
    async (args) => {
      const path = String(args.path);
      const wantWorkspaceTasks = args.workspaceTasks === true;
      // Duplicate path → return the existing registration rather than erroring.
      if (isAbsolute(path)) {
        const existing = ctx.registry.getByPath(canonicalize(path));
        if (existing) {
          let existingWs: WorkspaceCandidate[] = [];
          try {
            existingWs = (await ctx.detector.detect(path)).workspaces ?? [];
          } catch {
            // best-effort
          }
          return jsonResult({
            app: appBrief(ctx, existing),
            workspaces: existingWs.length ? existingWs : undefined,
            note:
              'This folder was already registered; returning the existing app.' +
              (wantWorkspaceTasks && existingWs.length
                ? ' workspaceTasks only applies to a new registration - use add_task (one per package, workingDir = its relPath) to add per-workspace tasks to this app.'
                : '')
          });
        }
      }

      const script = args.script as string | undefined;
      const command = args.command as string | undefined;
      let detectedScripts: string[] = [];
      let workspaces: WorkspaceCandidate[] = [];
      let firstTask: CreateTaskSpec | null = null;
      let defaultScript: string | null = null;

      if (script) {
        firstTask = { name: script, commandKind: 'script', script };
        defaultScript = script;
      } else if (command) {
        firstTask = { name: 'start', commandKind: 'custom', customCommand: command };
      }

      // Best-effort detection (also fills the scripts list in the response). Never fatal.
      try {
        const det = await ctx.detector.detect(path);
        detectedScripts = Object.keys(det.scripts);
        workspaces = det.workspaces ?? [];
        if (!firstTask && det.suggestedDefaultScript) {
          firstTask = { name: det.suggestedDefaultScript, commandKind: 'script', script: det.suggestedDefaultScript };
          defaultScript = det.suggestedDefaultScript;
        }
      } catch {
        // path validated by createApp below
      }

      // Monorepo: one task per workspace package, mirroring the UI's "create a task per
      // workspace package" flow (same naming, same script pick, same workingDirOverride).
      // Containment re-checked here (detection already filters) so a candidate can never
      // point a task outside the app root; names deduped because two packages can share a
      // package.json name and TaskRegistry would reject the whole atomic create otherwise.
      const runnable = workspaces.filter(
        (ws) =>
          (ws.suggestedScript ?? ws.scripts[0]) != null &&
          !isAbsolute(ws.relPath) &&
          !ws.relPath.split(/[\\/]/).includes('..')
      );
      let tasks: CreateTaskSpec[] | undefined;
      if (wantWorkspaceTasks && runnable.length > 0) {
        const usedNames = new Set<string>();
        tasks = runnable.map((ws) => {
          let taskName = ws.name || ws.relPath;
          if (usedNames.has(taskName.toLowerCase())) taskName = `${taskName} (${ws.relPath})`;
          usedNames.add(taskName.toLowerCase());
          return {
            name: taskName,
            commandKind: 'script' as const,
            script: ws.suggestedScript ?? ws.scripts[0],
            workingDirOverride: ws.relPath
          };
        });
        firstTask = null;
        defaultScript = null;
      }

      const input: CreateAppInput = {
        path,
        name: args.name as string | undefined,
        defaultScript,
        firstTask,
        tasks
      };
      const app = await ctx.appOps.createApp(input);

      // autoStart is not part of createApp's flow; apply as a follow-up patch.
      let finalApp = app;
      if (args.autoStart === true) finalApp = ctx.appOps.updateApp(app.id, { autoStart: true });

      const createdTasks = ctx.taskRegistry.list(finalApp.id);
      const notes: string[] = [];
      if (createdTasks.length === 0) {
        notes.push('No task was created (no script or command matched). Add one with add_task before starting.');
      }
      if (wantWorkspaceTasks && runnable.length === 0) {
        notes.push('workspaceTasks was requested, but no workspace packages with runnable scripts were detected - fell back to the default single task.');
      }
      if (!wantWorkspaceTasks && runnable.length > 0) {
        notes.push(`Monorepo detected: ${runnable.length} workspace package(s) with runnable scripts (see workspaces). This registration runs from the repo root; for per-service tasks, remove_app and re-add with workspaceTasks: true, or add_task each package with its workingDir.`);
      }
      if (workspaces.length >= 50) {
        notes.push('Workspace detection lists at most 50 packages; some may be missing from workspaces.');
      }
      return jsonResult({
        app: appBrief(ctx, finalApp),
        tasks: createdTasks.map((t) => t.name),
        detectedScripts,
        workspaces: workspaces.length ? workspaces : undefined,
        note: notes.length ? notes.join(' ') : undefined
      });
    }
  );

  tool(
    'update_app',
    {
      title: 'Update app',
      mutates: true,
      description:
        'Change an app\'s configuration. Only the fields you pass are modified. `nodeVersion` accepts "auto", "system", or an explicit version (see list_node_versions).',
      inputSchema: {
        app: z.string().describe('App id, exact name, or absolute path.'),
        name: z.string().optional(),
        defaultScript: z.string().nullable().optional(),
        autoStart: z.boolean().optional(),
        autoRestartOnChange: z.boolean().optional(),
        watchGlobs: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        folder: z.string().nullable().optional(),
        portHint: z.number().int().min(1).max(65535).nullable().optional(),
        nodeVersion: z.string().optional().describe('"auto", "system", or an explicit version like "20.11.0".')
      }
    },
    (args) => {
      const app = resolveApp(ctx, String(args.app));
      const patch: Partial<App> = {};
      if (args.name !== undefined) patch.name = String(args.name);
      if (args.defaultScript !== undefined) patch.defaultScript = args.defaultScript as string | null;
      if (args.autoStart !== undefined) patch.autoStart = Boolean(args.autoStart);
      if (args.autoRestartOnChange !== undefined) patch.autoRestartOnChange = Boolean(args.autoRestartOnChange);
      if (args.watchGlobs !== undefined) patch.watchGlobs = args.watchGlobs as string[];
      if (args.tags !== undefined) patch.tags = args.tags as string[];
      if (args.folder !== undefined) patch.folder = args.folder as string | null;
      if (args.portHint !== undefined) patch.portHint = args.portHint as number | null;
      if (args.nodeVersion !== undefined) patch.nodeVersionPref = nodeVersionPrefFrom(String(args.nodeVersion));
      const updated = ctx.appOps.updateApp(app.id, patch);
      return jsonResult({ app: appBrief(ctx, updated) });
    }
  );

  tool(
    'remove_app',
    {
      title: 'Remove app',
      mutates: true,
      description:
        'Unregister an app from DevHarbor. Does NOT delete any files on disk - only the registration. Requires confirm: true and refuses while the app is running.',
      inputSchema: {
        app: z.string().describe('App id, exact name, or absolute path.'),
        confirm: z.boolean().describe('Must be true to actually remove.')
      },
      annotations: { destructiveHint: true }
    },
    (args) => {
      const app = resolveApp(ctx, String(args.app));
      if (args.confirm !== true) {
        return errorResult(`Refusing to remove "${app.name}" without confirm: true.`);
      }
      ctx.appOps.removeApp(app.id);
      return jsonResult({ removed: app.name, note: 'Registration removed. Files on disk are untouched.' });
    }
  );

  tool(
    'add_task',
    {
      title: 'Add task',
      mutates: true,
      description:
        'Add a task to an app. Tasks are the per-service unit of a monorepo registration: each runs its own script or command, optionally from a subdirectory (`workingDir`, e.g. "apps/api"), and `dependsOn` other tasks so start_app brings services up in order (migrate, then api, then web). Pass exactly one of `script` or `command`. `oneShot` marks a run-to-completion task (migration, build) and defaults its readiness to exit code 0 so dependents wait for it to finish. For long-running services, configure a readiness probe with set_readiness after creating.',
      inputSchema: {
        app: z.string().describe('App id, exact name, or absolute path.'),
        name: z.string().min(1).describe('Task name, unique within the app (e.g. the workspace package name).'),
        script: z.string().optional().describe('package.json script to run (resolved from workingDir if set).'),
        command: z.string().optional().describe('Raw shell command to run instead of a script.'),
        workingDir: z.string().optional().describe('Subdirectory to run from, relative to the app root (e.g. "apps/api").'),
        dependsOn: z.array(z.string()).optional().describe('Tasks (id or name) that must be ready before this one starts.'),
        oneShot: z.boolean().optional().describe('Task runs to completion instead of serving (migrations, builds). Defaults readiness to exit code 0.'),
        enabled: z.boolean().optional().describe('Disabled tasks are skipped by start_app (default true).')
      }
    },
    (args) => {
      const app = resolveApp(ctx, String(args.app));
      const name = String(args.name).trim();
      if (!name) return errorResult('A non-empty task `name` is required.');
      if (ctx.taskRegistry.list(app.id).some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        return errorResult(`A task named "${name}" already exists in "${app.name}". Task names must be unique so they stay addressable.`);
      }

      const script = args.script as string | undefined;
      const command = args.command as string | undefined;
      if (Boolean(script) === Boolean(command)) {
        return errorResult('Pass exactly one of `script` or `command`.');
      }

      let workingDirOverride: string | null = null;
      const rawDir = (args.workingDir as string | undefined)?.trim();
      if (rawDir) {
        if (isAbsolute(rawDir) || rawDir.split(/[\\/]/).includes('..')) {
          return errorResult('workingDir must be a subdirectory relative to the app root (no absolute paths or "..").');
        }
        let isDir = false;
        try {
          isDir = statSync(join(app.path, rawDir)).isDirectory();
        } catch {
          // missing - handled below
        }
        if (!isDir) {
          return errorResult(`workingDir is not an existing directory under the app root: ${rawDir}`);
        }
        workingDirOverride = rawDir;
      }

      const deps: TaskId[] = [];
      for (const ref of (args.dependsOn as string[] | undefined) ?? []) {
        const dep = resolveTask(ctx, String(ref), app.id);
        if (dep.appId !== app.id) {
          return errorResult(`Task "${ref}" belongs to a different app - dependencies must be within "${app.name}".`);
        }
        if (!dep.enabled) {
          return errorResult(`Task "${dep.name}" is disabled - start_app skips it, so the dependency would silently never order anything. Enable it first or depend on an enabled task.`);
        }
        deps.push(dep.id);
      }

      const oneShot = args.oneShot === true;
      // TaskRegistry.add re-runs cycle detection on the new graph and throws with the cycle
      // path; the tool wrapper surfaces that as an isError result.
      const task = ctx.taskRegistry.add(app.id, {
        name,
        commandKind: script ? 'script' : 'custom',
        script: script ?? null,
        customCommand: command ?? null,
        workingDirOverride,
        dependsOn: deps,
        oneShot,
        readiness: oneShot ? { kind: 'exit', code: 0 } : { kind: 'none' },
        enabled: args.enabled === undefined ? true : Boolean(args.enabled)
      });
      return jsonResult({
        app: app.name,
        task: taskInfo(ctx, task, secretValuesForApp(ctx, app.id)),
        note: 'Task created. Start it with start_task, or start_app to run the whole dependency order.'
      });
    }
  );

  tool(
    'remove_task',
    {
      title: 'Remove task',
      mutates: true,
      description:
        'Remove a task from an app. Deletes its task-scoped env vars too; files on disk are untouched. Refuses while the task is running or while other tasks depend on it. Requires confirm: true.',
      inputSchema: {
        app: z.string().describe('App id, exact name, or absolute path.'),
        task: z.string().describe('Task id, or task name (scoped by app).'),
        confirm: z.boolean().describe('Must be true to actually remove.')
      },
      annotations: { destructiveHint: true }
    },
    (args) => {
      const app = resolveApp(ctx, String(args.app));
      const task = resolveTask(ctx, String(args.task), String(args.app));
      // A task id resolves globally before app scoping applies - never delete across apps.
      if (task.appId !== app.id) {
        return errorResult(`Task "${task.name}" belongs to a different app than "${app.name}".`);
      }
      if (args.confirm !== true) {
        return errorResult(`Refusing to remove task "${task.name}" without confirm: true.`);
      }
      // An in-flight start_app spawns later dependency levels from its own snapshot, so a
      // task removed while the app is starting could still be spawned - as a process with
      // no registry row that nothing can stop. Refuse until the app settles.
      const appState = ctx.orchestrator.appState(task.appId);
      if (appState === 'starting' || appState === 'exiting') {
        return errorResult(`"${app.name}" is ${appState} - wait for it to settle before removing tasks.`);
      }
      if (ctx.runner.isRunning(task.id)) {
        return errorResult('Stop the task before removing it.');
      }
      // TaskRegistry.remove refuses while other tasks depend on this one (clear error
      // naming the dependents); task-scoped env rows go with it (FK cascade).
      ctx.taskRegistry.remove(task.id);
      return jsonResult({ removed: task.name, note: 'Task removed. Its task-scoped env vars were deleted; files on disk are untouched.' });
    }
  );

  tool(
    'start_app',
    {
      title: 'Start app',
      mutates: true,
      description:
        'Start an app - runs its tasks in dependency order, waits for readiness, then waits briefly for port detection so the response includes the ports. This is how you run a project\'s dev server through DevHarbor; do not run npm/yarn/pnpm yourself. `readinessVerified` is null when the app has no readiness probe - "running" then means the processes are up, not that they are serving, and the response includes recent output so you can judge. Ports listed are those detected by return time; without a readiness probe, a service that binds well after its siblings can land later - check get_ports/get_app, or configure set_readiness so the start waits for it. If a task crashed or never became ready, its log tail is included so you can diagnose in one call. Long starts return "still starting" after 45s - poll get_app.',
      inputSchema: { app: z.string().describe('App id, exact name, or absolute path.') }
    },
    async (args) => {
      const app = resolveApp(ctx, String(args.app));
      let startError: string | null = null;
      const startP = ctx.orchestrator.startApp(app.id).then(
        () => {},
        (e) => {
          startError = cleanMessage(e);
        }
      );
      await Promise.race([startP, new Promise((r) => setTimeout(r, START_BUDGET_MS))]);
      await settle();
      // Skip the port wait if the 45s readiness budget already elapsed (app still
      // "starting") - stacking a ~12s port wait on top would push the tool past the SDK
      // client's 60s request timeout. The "still starting" result already says to poll.
      if (!startError && ctx.orchestrator.appState(app.id) !== 'starting') {
        await waitForAppPorts(ctx, app.id);
      }
      return startResultFor(ctx, app, startError);
    }
  );

  tool(
    'stop_app',
    {
      title: 'Stop app',
      mutates: true,
      description: 'Gracefully stop a running app (SIGTERM, grace period, then SIGKILL on the tree). Returns the final state.',
      inputSchema: { app: z.string().describe('App id, exact name, or absolute path.') }
    },
    async (args) => {
      const app = resolveApp(ctx, String(args.app));
      await ctx.orchestrator.stopApp(app.id);
      return jsonResult({ app: app.name, state: ctx.orchestrator.appState(app.id) });
    }
  );

  tool(
    'restart_app',
    {
      title: 'Restart app',
      mutates: true,
      description:
        'Stop then start an app under one lock. Idempotent: a stopped app is simply started. Same result shape as start_app, including a failure log tail.',
      inputSchema: { app: z.string().describe('App id, exact name, or absolute path.') }
    },
    async (args) => {
      const app = resolveApp(ctx, String(args.app));
      let startError: string | null = null;
      const p = ctx.orchestrator.restartApp(app.id).then(
        () => {},
        (e) => {
          startError = cleanMessage(e);
        }
      );
      await Promise.race([p, new Promise((r) => setTimeout(r, START_BUDGET_MS))]);
      await settle();
      if (!startError) await waitForAppPorts(ctx, app.id);
      return startResultFor(ctx, app, startError);
    }
  );

  tool(
    'start_task',
    {
      title: 'Start task',
      mutates: true,
      description:
        'Start a single task (bypassing dependency ordering). By default waits for the task\'s readiness and briefly for port detection, then reports like start_app (ready is null when the task has no readiness probe); pass wait: false to return immediately after spawn.',
      inputSchema: {
        task: z.string().describe('Task id, or task name (scope with app).'),
        app: z.string().optional().describe('App to scope the task name to.'),
        wait: z.boolean().optional().describe('Wait for readiness before returning (default true).')
      }
    },
    async (args) => {
      const task = resolveTask(ctx, String(args.task), args.app ? String(args.app) : undefined);
      const app = ctx.registry.get(task.appId);
      const wait = (args.wait as boolean | undefined) ?? true;
      const { snapshot, awaitReady } = await ctx.orchestrator.runner.start(task);
      if (!wait) {
        return jsonResult({
          task: task.name,
          app: app?.name,
          state: snapshot.state,
          ready: task.readiness.kind !== 'none' ? snapshot.ready : null,
          ports: snapshot.ports,
          note: 'Spawned; readiness not awaited (wait: false).'
        });
      }
      const outcome = await raceReadiness(awaitReady, START_BUDGET_MS);
      await settle();
      const probed = (ctx.runner.get(task.id)?.readinessKind ?? task.readiness.kind) !== 'none';
      const rt0 = ctx.runner.get(task.id);
      // Only wait for ports if readiness actually settled (not a budget timeout) and the task
      // is live - otherwise we'd stack the port wait onto an already-45s call.
      if (outcome !== 'timeout' && rt0 && (rt0.state === 'running' || rt0.state === 'starting')) {
        await waitForTaskPorts(ctx, task.id);
      }
      const rt = ctx.runner.get(task.id);
      const secrets = secretValuesForApp(ctx, task.appId);
      const notes: string[] = [];
      if (outcome === 'timeout') notes.push('Still starting after 45s; poll get_app.');
      const listening = (rt?.ports.length ?? 0) > 0;
      if (!probed && rt?.state === 'running') {
        notes.push(
          listening
            ? 'This task has no readiness probe (readiness kind "none") and is listening on a port - which usually means ready, but is not verified (a service can open its port before it can serve). Call set_readiness (e.g. an http probe) for a verified answer.'
            : 'This task has no readiness probe (readiness kind "none") - "running" means the process is up, not that it is serving. Recent output is included so you can judge.'
        );
      }
      const header = {
        task: task.name,
        app: app?.name,
        state: rt?.state ?? 'idle',
        ready: probed ? (rt?.ready ?? false) : null,
        listening: rt ? listening : null,
        ports: rt?.ports ?? [],
        portDetails: portOwnersFor(ctx, task.id, secrets),
        readiness: outcome,
        note: notes.length ? notes.join(' ') : undefined
      };
      if (outcome === 'ready' && probed) return jsonResult(header);
      const tail = cleanLogText(ctx.runner.tailBuffer(task.id, 30), secrets);
      const label = !probed && rt?.state === 'running' ? ' (no readiness probe - judge from output)' : '';
      return tail.trim() ? logResult({ ...header, tailNote: label || undefined }, tail) : jsonResult(header);
    }
  );

  tool(
    'stop_task',
    {
      title: 'Stop task',
      mutates: true,
      description: 'Stop a single running task.',
      inputSchema: {
        task: z.string().describe('Task id, or task name (scope with app).'),
        app: z.string().optional().describe('App to scope the task name to.')
      }
    },
    async (args) => {
      const task = resolveTask(ctx, String(args.task), args.app ? String(args.app) : undefined);
      await ctx.orchestrator.stopTask(task.id);
      return jsonResult({ task: task.name, state: ctx.runner.get(task.id)?.state ?? 'idle' });
    }
  );

  tool(
    'set_env_var',
    {
      title: 'Set env var',
      mutates: true,
      description:
        'Set (or update) an app-scoped environment variable. Takes effect on the next start. `secret` defaults to a name-based heuristic; secret values are write-only through MCP (list_env_vars masks them). Pass secret: false explicitly to keep a value readable.',
      inputSchema: {
        app: z.string().describe('App id, exact name, or absolute path.'),
        key: z.string().describe('Variable name.'),
        value: z.string().describe('Variable value.'),
        secret: z.boolean().optional().describe('Mark as secret (default: heuristic on the key name).'),
        enabled: z.boolean().optional().describe('Whether the variable is active (default true).')
      }
    },
    (args) => {
      const app = resolveApp(ctx, String(args.app));
      const key = String(args.key).trim();
      if (!key) return errorResult('key cannot be empty.');
      const heuristic = isSecretKey(key);
      const isSecret = (args.secret as boolean | undefined) ?? heuristic;
      const enabled = (args.enabled as boolean | undefined) ?? true;

      const current = ctx.envStore.getApp(app.id).filter((v) => v.key !== key);
      current.push({ id: '', appId: app.id, key, value: String(args.value), enabled, isSecret });
      ctx.envStore.setApp(app.id, current);

      return jsonResult({
        app: app.name,
        key,
        isSecret,
        enabled,
        note:
          isSecret && args.secret === undefined
            ? `Marked secret by name heuristic; the value is now write-only. Pass secret: false to keep it readable. Applies on next start.`
            : 'Applies on the next start.'
      });
    }
  );

  tool(
    'set_readiness',
    {
      title: 'Set readiness probe',
      mutates: true,
      description:
        'Configure how DevHarbor decides a task is READY (actually serving), so start/restart wait for it and report readinessVerified: true. This is the fix when a task reports ready: null / readinessVerified: null because it has no probe. kinds: "none" (no probe), "port" (a TCP port is listening - note a port can open before a service can serve), "log" (a log line matches regex), "http" (a GET to url returns success - best for a service that opens its port before its DB/cache connect; point it at /health or /ready), "delay" (fixed wait ms). Takes effect on the next start.',
      inputSchema: {
        app: z.string().describe('App id, exact name, or absolute path.'),
        task: z.string().describe('Task id, or task name (scoped by app).'),
        kind: z.enum(['none', 'port', 'log', 'http', 'delay']).describe('Readiness signal kind.'),
        port: z.number().int().min(1).max(65535).optional().describe('For kind "port": the TCP port to wait for.'),
        regex: z.string().optional().describe('For kind "log": a pattern to match in the task output.'),
        flags: z.string().optional().describe('For kind "log": regex flags (default "i").'),
        url: z.string().optional().describe('For kind "http": the URL to GET (e.g. http://localhost:4000/ready).'),
        status: z.number().int().min(100).max(599).optional().describe('For kind "http": required status (default any 2xx/3xx).'),
        ms: z.number().int().min(0).optional().describe('For kind "delay": milliseconds to wait.')
      }
    },
    (args) => {
      const task = resolveTask(ctx, String(args.task), String(args.app));
      const kind = String(args.kind);
      let readiness: ReadinessSignal;
      switch (kind) {
        case 'none':
          readiness = { kind: 'none' };
          break;
        case 'port': {
          const port = args.port as number | undefined;
          if (port == null) return errorResult('kind "port" requires a `port`.');
          readiness = { kind: 'port', port };
          break;
        }
        case 'log': {
          const regex = args.regex as string | undefined;
          if (!regex) return errorResult('kind "log" requires a `regex`.');
          try {
            new RegExp(regex, (args.flags as string | undefined) ?? 'i');
          } catch (e) {
            return errorResult(`Invalid regex: ${cleanMessage(e)}`);
          }
          readiness = { kind: 'log', regex, flags: (args.flags as string | undefined) ?? 'i' };
          break;
        }
        case 'http': {
          const url = args.url as string | undefined;
          if (!url) return errorResult('kind "http" requires a `url`.');
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            return errorResult(`Invalid url: ${url}`);
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return errorResult('url must be http:// or https://.');
          }
          // Loopback only: DevHarbor's main process polls this URL, so a non-loopback host
          // would turn the readiness probe into an SSRF / egress primitive. A dev server's
          // health endpoint is always local.
          if (!isLoopbackHostname(parsed.hostname)) {
            return errorResult('http readiness url must target localhost / 127.0.0.1 / [::1].');
          }
          readiness = { kind: 'http', url, status: args.status as number | undefined };
          break;
        }
        case 'delay': {
          const ms = args.ms as number | undefined;
          if (ms == null) return errorResult('kind "delay" requires `ms`.');
          readiness = { kind: 'delay', ms };
          break;
        }
        default:
          return errorResult(`Unsupported readiness kind: ${kind}`);
      }

      const updated = ctx.taskRegistry.update(task.id, { readiness });
      return jsonResult({
        app: ctx.registry.get(task.appId)?.name,
        task: updated.name,
        readiness: updated.readiness,
        note: 'Readiness updated. Takes effect on the next start/restart of this task.'
      });
    }
  );
}
