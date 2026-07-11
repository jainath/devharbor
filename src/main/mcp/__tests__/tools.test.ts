/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvVar, RunningTask } from '@shared/types';
import { registerTools } from '../tools';
import { captureTools, makeApp, makeContext, makeTask, type CapturedTool } from './fakeContext';

/** Parse the first content block of a tool result as JSON. */
function firstJson(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0]!.text);
}

async function call(tool: CapturedTool, args: Record<string, unknown> = {}) {
  return await tool.handler(args);
}

const secretEnv = (key: string, value: string): EnvVar => ({
  id: key,
  appId: null,
  key,
  value,
  enabled: true,
  isSecret: true
});

const runningTask = (taskId: string, appId: string, over: Partial<RunningTask> = {}): RunningTask => ({
  taskId: taskId as RunningTask['taskId'],
  appId: appId as RunningTask['appId'],
  pid: 100,
  state: 'running',
  ready: true,
  readinessKind: 'none',
  startedAt: 1,
  command: 'npm run dev',
  nodeVersion: '20',
  packageManager: 'npm',
  cpu: 1,
  memMB: 10,
  ports: [3000],
  exitCode: null,
  exitSignal: null,
  ...over
});

function setup(stateOver = {}) {
  const apps = [makeApp({ id: 'id-web', name: 'web', path: '/proj/web' })];
  const tasks = { 'id-web': [makeTask({ id: 'task-dev', appId: 'id-web', name: 'dev' })] };
  const { ctx, state } = makeContext({ apps, tasks, ...stateOver });
  const tools = captureTools(registerTools, ctx);
  return { ctx, state, tools };
}

describe('tool catalog registration', () => {
  it('registers the full 22-tool catalog with read-only hints on reads', () => {
    const { tools } = setup();
    expect(tools.size).toBe(22);
    expect(tools.get('list_apps')!.config.annotations.readOnlyHint).toBe(true);
    expect(tools.get('remove_app')!.config.annotations.destructiveHint).toBe(true);
    expect(tools.get('remove_task')!.config.annotations.destructiveHint).toBe(true);
    // A mutating tool must NOT be flagged read-only.
    expect(tools.get('start_app')!.config.annotations.readOnlyHint).toBeUndefined();
    expect(tools.get('add_task')!.config.annotations.readOnlyHint).toBeUndefined();
  });
});

describe('get_overview / list_apps', () => {
  it('summarises counts and per-app state', async () => {
    const { tools } = setup({ states: { 'id-web': 'running' }, running: [runningTask('task-dev', 'id-web')] });
    const overview = firstJson(await call(tools.get('get_overview')!));
    expect(overview.appCount).toBe(1);
    expect(overview.running).toBe(1);
    expect(overview.activePorts).toEqual([3000]);
    expect(overview.devharborVersion).toBe('9.9.9');
  });

  it('filters list_apps by state', async () => {
    const { tools } = setup({ states: { 'id-web': 'running' } });
    const running = firstJson(await call(tools.get('list_apps')!, { state: 'running' }));
    expect(running.count).toBe(1);
    const idle = firstJson(await call(tools.get('list_apps')!, { state: 'idle' }));
    expect(idle.count).toBe(0);
  });
});

describe('list_env_vars masking', () => {
  it('returns non-secret values but masks secret ones', async () => {
    const appEnv = {
      'id-web': [
        { id: '1', appId: 'id-web', key: 'PORT', value: '3000', enabled: true, isSecret: false } as EnvVar,
        secretEnv('API_KEY', 'super-secret-value')
      ]
    };
    const { tools } = setup({ appEnv });
    const res = firstJson(await call(tools.get('list_env_vars')!, { app: 'web' }));
    const port = res.vars.find((v: any) => v.key === 'PORT');
    const apiKey = res.vars.find((v: any) => v.key === 'API_KEY');
    expect(port.value).toBe('3000');
    expect(apiKey.value).toBeNull();
    expect(apiKey.isSecret).toBe(true);
  });
});

describe('get_logs hygiene', () => {
  it('strips ANSI and redacts known secret values from the log text block', async () => {
    const buffers = { 'task-dev': '\x1b[32mstarting\x1b[0m\nDATABASE_URL=postgres://u:hunter2xyz@h/db' };
    const appEnv = { 'id-web': [secretEnv('DATABASE_URL', 'hunter2xyz')] };
    const running = [runningTask('task-dev', 'id-web')];
    const { tools } = setup({ buffers, appEnv, running });
    const res = await call(tools.get('get_logs')!, { app: 'web' });
    const logText = res.content[1].text as string;
    expect(logText).toContain('starting');
    expect(logText).not.toContain('\x1b[');
    expect(logText).not.toContain('hunter2xyz');
    expect(logText).toContain('[redacted]');
  });
});

describe('search_logs', () => {
  it('reports interpretation mode and redacts matched lines', async () => {
    const searchMatches = [
      { appId: 'id-web' as any, taskId: 'task-dev' as any, appName: 'web', taskName: 'dev', line: 'key=topsecretval' }
    ];
    const appEnv = { 'id-web': [secretEnv('KEY', 'topsecretval')] };
    const { tools } = setup({ searchMatches, appEnv });
    const res = firstJson(await call(tools.get('search_logs')!, { query: 'key', app: 'web' }));
    expect(res.interpretedAs).toBe('literal');
    expect(res.matches[0].line).toContain('[redacted]');
    expect(res.matches[0].line).not.toContain('topsecretval');
  });

  it('errors on an invalid pattern when regex is true (no silent literal downgrade)', async () => {
    const { tools } = setup();
    const res = await call(tools.get('search_logs')!, { query: 'foo(', regex: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/[Ii]nvalid regular expression/);
  });

  it('treats the same invalid string as a fine literal query when regex is false', async () => {
    const { tools } = setup();
    const res = firstJson(await call(tools.get('search_logs')!, { query: 'foo(' }));
    expect(res.interpretedAs).toBe('literal');
    expect(res.count).toBe(0);
  });
});

describe('set_env_var', () => {
  it('applies the name-based secret heuristic and marks the value write-only', async () => {
    const { tools, state } = setup();
    const res = firstJson(await call(tools.get('set_env_var')!, { app: 'web', key: 'API_TOKEN', value: 'abc' }));
    expect(res.isSecret).toBe(true);
    expect(res.note).toMatch(/write-only/);
    expect(state.setAppCalls).toHaveLength(1);
    const saved = state.setAppCalls[0]!.vars.find((v) => v.key === 'API_TOKEN');
    expect(saved!.isSecret).toBe(true);
  });

  it('honours an explicit secret: false override', async () => {
    const { tools } = setup();
    const res = firstJson(await call(tools.get('set_env_var')!, { app: 'web', key: 'API_TOKEN', value: 'abc', secret: false }));
    expect(res.isSecret).toBe(false);
  });
});

describe('remove_app guard', () => {
  it('refuses without confirm: true', async () => {
    const { tools, state } = setup();
    const res = await call(tools.get('remove_app')!, { app: 'web' });
    expect(res.isError).toBe(true);
    expect(state.removed).toHaveLength(0);
  });

  it('refuses while the app is running', async () => {
    const { tools, state } = setup({ states: { 'id-web': 'running' } });
    const res = await call(tools.get('remove_app')!, { app: 'web', confirm: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Stop the app/);
    expect(state.removed).toHaveLength(0);
  });

  it('removes when confirmed and idle', async () => {
    const { tools, state } = setup();
    const res = firstJson(await call(tools.get('remove_app')!, { app: 'web', confirm: true }));
    expect(res.removed).toBe('web');
    expect(state.removed).toEqual(['id-web']);
  });
});

describe('readiness honesty (feedback fix)', () => {
  it('reports ready: null for a running task with no readiness probe', async () => {
    // Default makeTask readiness is { kind: 'none' } - the runner would say ready: true.
    const running = [runningTask('task-dev', 'id-web', { ready: true })];
    const { tools } = setup({ running, states: { 'id-web': 'running' } });
    const res = firstJson(await call(tools.get('get_app')!, { app: 'web' }));
    expect(res.tasks[0].ready).toBeNull();
    const lr = firstJson(await call(tools.get('list_running')!));
    expect(lr.running[0].ready).toBeNull();
  });

  it('start_app reports readinessVerified: null + explanatory note for unprobed tasks', async () => {
    const running = [runningTask('task-dev', 'id-web', { ready: true })];
    const buffers = { 'task-dev': 'listening on 3000' };
    const { ctx, tools, state } = setup({ running, buffers });
    (ctx.orchestrator as any).startApp = async () => {
      state.states['id-web'] = 'running';
    };
    const res = await call(tools.get('start_app')!, { app: 'web' });
    const header = JSON.parse(res.content[0].text);
    expect(header.readinessVerified).toBeNull();
    expect(header.note).toMatch(/no readiness probe/i);
    // The unprobed running task's tail is included so the agent can judge.
    expect(res.content[1].text).toContain('listening on 3000');
  });

  it('reports true ready for a PROBED task that reached readiness', async () => {
    const tasks = {
      'id-web': [makeTask({ id: 'task-dev', appId: 'id-web', name: 'dev', readiness: { kind: 'port', port: 3000 } })]
    };
    // The LIVE run was spawned WITH the port probe (readinessKind reflects that).
    const running = [runningTask('task-dev', 'id-web', { ready: true, readinessKind: 'port' })];
    const { tools } = setup({ tasks, running, states: { 'id-web': 'running' } });
    const res = firstJson(await call(tools.get('get_app')!, { app: 'web' }));
    expect(res.tasks[0].ready).toBe(true);
  });
});

describe('port labels (feedback fix)', () => {
  it('get_ports includes per-port process ownership', async () => {
    const running = [runningTask('task-dev', 'id-web', { ports: [3000, 4000] })];
    const { ctx, tools } = setup({ running });
    (ctx.runner as any).ports.portOwners = () => [
      { port: 3000, pid: 111, process: 'next-server (v15)' },
      { port: 4000, pid: 222, process: 'node index.js' }
    ];
    const all = firstJson(await call(tools.get('get_ports')!));
    expect(all.apps[0].portDetails).toHaveLength(2);
    expect(all.apps[0].portDetails[0]).toMatchObject({ port: 3000, process: 'next-server (v15)', task: 'dev' });
    const one = firstJson(await call(tools.get('get_ports')!, { port: 4000 }));
    expect(one.process).toBe('node index.js');
    expect(one.task).toBe('dev');
  });

  it('get_ports prefers the confirmed (pid set) owner over a log-hinted claim', async () => {
    const apps = [
      makeApp({ id: 'id-a', name: 'appA', path: '/proj/a' }),
      makeApp({ id: 'id-b', name: 'appB', path: '/proj/b' })
    ];
    const tasks = {
      'id-a': [makeTask({ id: 'task-a', appId: 'id-a', name: 'dev' })],
      'id-b': [makeTask({ id: 'task-b', appId: 'id-b', name: 'dev' })]
    };
    // Both apps "have" port 3000, but only appB actually listens (pid set); appA only hinted it.
    const running = [runningTask('task-a', 'id-a', { ports: [3000] }), runningTask('task-b', 'id-b', { ports: [3000] })];
    const { ctx, tools } = setup({ apps, tasks, running });
    (ctx.runner as any).ports.portOwners = (id: string) =>
      id === 'task-b' ? [{ port: 3000, pid: 999, process: 'real-server' }] : [{ port: 3000, pid: null, process: null }];
    const res = firstJson(await call(tools.get('get_ports')!, { port: 3000 }));
    expect(res.owner).toBe('appB');
    expect(res.process).toBe('real-server');
  });
});

describe('listening signal (feedback fix)', () => {
  it('reports listening: true for a running task with ports, ready still null (no probe)', async () => {
    const running = [runningTask('task-dev', 'id-web', { ready: true, ports: [3000] })];
    const { tools } = setup({ running, states: { 'id-web': 'running' } });
    const res = firstJson(await call(tools.get('get_app')!, { app: 'web' }));
    expect(res.tasks[0].listening).toBe(true);
    expect(res.tasks[0].ready).toBeNull();
    const lr = firstJson(await call(tools.get('list_running')!));
    expect(lr.running[0].listening).toBe(true);
  });

  it('reports listening: false when running but no ports yet', async () => {
    const running = [runningTask('task-dev', 'id-web', { ready: true, ports: [] })];
    const { tools } = setup({ running, states: { 'id-web': 'running' } });
    const res = firstJson(await call(tools.get('get_app')!, { app: 'web' }));
    expect(res.tasks[0].listening).toBe(false);
  });
});

describe('set_readiness (feedback fix)', () => {
  it('sets an http readiness probe on the task', async () => {
    const { tools, ctx } = setup();
    const res = firstJson(
      await call(tools.get('set_readiness')!, { app: 'web', task: 'dev', kind: 'http', url: 'http://localhost:4000/ready' })
    );
    expect(res.readiness).toEqual({ kind: 'http', url: 'http://localhost:4000/ready', status: undefined });
    // Persisted on the task.
    expect((ctx.taskRegistry.get('task-dev' as any) as any).readiness.kind).toBe('http');
  });

  it('validates required fields per kind', async () => {
    const { tools } = setup();
    expect((await call(tools.get('set_readiness')!, { app: 'web', task: 'dev', kind: 'port' })).isError).toBe(true);
    expect((await call(tools.get('set_readiness')!, { app: 'web', task: 'dev', kind: 'http', url: 'not a url' })).isError).toBe(true);
    expect((await call(tools.get('set_readiness')!, { app: 'web', task: 'dev', kind: 'log', regex: '(' })).isError).toBe(true);
  });

  it('sets a port probe', async () => {
    const { tools } = setup();
    const res = firstJson(await call(tools.get('set_readiness')!, { app: 'web', task: 'dev', kind: 'port', port: 4000 }));
    expect(res.readiness).toEqual({ kind: 'port', port: 4000 });
  });

  it('rejects a non-loopback http url (SSRF guard)', async () => {
    const { tools } = setup();
    const bad = await call(tools.get('set_readiness')!, {
      app: 'web',
      task: 'dev',
      kind: 'http',
      url: 'http://169.254.169.254/latest/meta-data'
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/localhost|loopback/i);
    const ok = firstJson(
      await call(tools.get('set_readiness')!, { app: 'web', task: 'dev', kind: 'http', url: 'http://localhost:4000/ready' })
    );
    expect(ok.readiness.kind).toBe('http');
  });

  it('does NOT flip a running task ready:null -> true until restart (edited-config honesty)', async () => {
    // A running task whose LIVE watcher is kind none (readinessKind 'none'), ready vacuously true.
    const running = [runningTask('task-dev', 'id-web', { ready: true, readinessKind: 'none' })];
    const { tools } = setup({ running, states: { 'id-web': 'running' } });
    // Configure an http probe - takes effect on next start, not now.
    await call(tools.get('set_readiness')!, { app: 'web', task: 'dev', kind: 'http', url: 'http://localhost:4000/ready' });
    // The stored config is now http, but the live run still has no probe -> ready stays null.
    const res = firstJson(await call(tools.get('get_app')!, { app: 'web' }));
    expect(res.tasks[0].ready).toBeNull();
    const lr = firstJson(await call(tools.get('list_running')!));
    expect(lr.running[0].ready).toBeNull();
  });
});

describe('list_running unresolvable task (feedback fix)', () => {
  it('reports ready: null when the task row is gone (not the vacuous raw flag)', async () => {
    // A running entry whose task is NOT in the registry (tasks: {} => taskRegistry.get null).
    const running = [runningTask('ghost-task', 'id-web', { ready: true })];
    const { ctx, tools } = setup({ running });
    (ctx.taskRegistry as any).get = () => null;
    const lr = firstJson(await call(tools.get('list_running')!));
    expect(lr.running[0].ready).toBeNull();
  });
});

describe('start_app honesty', () => {
  it('re-reads app state after start rather than trusting resolution', async () => {
    // Orchestrator flips the app to crashed; a crash tail should be attached.
    const buffers = { 'task-dev': 'Error: boom\nstack line' };
    const { ctx, tools, state } = setup({ buffers, states: { 'id-web': 'idle' } });
    // make startApp set state to crashed
    (ctx.orchestrator as any).startApp = async () => {
      state.states['id-web'] = 'crashed';
    };
    const res = await call(tools.get('start_app')!, { app: 'web' });
    const header = JSON.parse(res.content[0].text);
    expect(header.state).toBe('crashed');
    expect(header.readinessVerified).toBe(false);
    // failure tail present as a second block
    expect(res.content[1].text).toContain('boom');
  });

  it('reports unknown apps as an actionable error', async () => {
    const { tools } = setup();
    const res = await call(tools.get('start_app')!, { app: 'ghost' });
    expect(res.isError).toBe(true);
  });
});

describe('desktop auto-reflect (notifyChanged)', () => {
  it('a mutating tool calls notifyChanged on success; a read-only tool does not', async () => {
    const { tools, state } = setup();
    await call(tools.get('list_apps')!); // read-only
    expect(state.notifyChangedCalls).toBe(0);
    await call(tools.get('set_env_var')!, { app: 'web', key: 'X', value: '1', secret: false }); // mutating
    expect(state.notifyChangedCalls).toBe(1);
    await call(tools.get('remove_app')!, { app: 'web', confirm: true }); // mutating
    expect(state.notifyChangedCalls).toBe(2);
  });

  it('does NOT notify when a mutating tool returns an error', async () => {
    const { tools, state } = setup();
    await call(tools.get('remove_app')!, { app: 'web' }); // refused (no confirm) -> isError
    expect(state.notifyChangedCalls).toBe(0);
  });
});

describe('add_app dedupe', () => {
  it('returns the existing app when the path is already registered', async () => {
    const { tools } = setup();
    const res = firstJson(await call(tools.get('add_app')!, { path: '/proj/web' }));
    expect(res.note).toMatch(/already registered/);
    expect(res.app.name).toBe('web');
  });
});

describe('add_app workspaceTasks (monorepo)', () => {
  const monoDetection = {
    scripts: { dev: 'turbo dev' },
    suggestedDefaultScript: 'dev',
    workspaces: [
      { name: '@acme/api', relPath: 'apps/api', scripts: ['dev'], suggestedScript: 'dev' },
      { name: '@acme/web', relPath: 'apps/web', scripts: ['dev', 'build'], suggestedScript: 'dev' },
      // No runnable script: must be skipped, like the UI does.
      { name: '@acme/tsconfig', relPath: 'packages/tsconfig', scripts: [], suggestedScript: null }
    ]
  };

  it('creates one task per runnable workspace package, mirroring the UI flow', async () => {
    const { tools, state } = setup({ tasks: {}, detection: monoDetection });
    const res = firstJson(await call(tools.get('add_app')!, { path: '/repo/mono', workspaceTasks: true }));
    const input = state.createAppCalls[0]!;
    expect(input.firstTask).toBeNull();
    expect(input.tasks).toEqual([
      { name: '@acme/api', commandKind: 'script', script: 'dev', workingDirOverride: 'apps/api' },
      { name: '@acme/web', commandKind: 'script', script: 'dev', workingDirOverride: 'apps/web' }
    ]);
    expect(res.tasks).toEqual(['@acme/api', '@acme/web']);
    expect(res.workspaces).toHaveLength(3);
  });

  it('falls back to the default single task with an honest note when nothing is runnable', async () => {
    const { tools, state } = setup({
      tasks: {},
      detection: { scripts: { dev: 'vite' }, suggestedDefaultScript: 'dev', workspaces: [] }
    });
    const res = firstJson(await call(tools.get('add_app')!, { path: '/repo/plain', workspaceTasks: true }));
    expect(state.createAppCalls[0]!.tasks).toBeUndefined();
    expect(state.createAppCalls[0]!.firstTask).toEqual({ name: 'dev', commandKind: 'script', script: 'dev' });
    expect(res.note).toMatch(/no workspace packages with runnable scripts/);
  });

  it('flags a detected monorepo when workspaceTasks was not passed', async () => {
    const { tools, state } = setup({ tasks: {}, detection: monoDetection });
    const res = firstJson(await call(tools.get('add_app')!, { path: '/repo/mono' }));
    expect(state.createAppCalls[0]!.tasks).toBeUndefined();
    expect(res.note).toMatch(/Monorepo detected: 2 workspace package/);
    expect(res.workspaces).toHaveLength(3);
  });

  it('points an already-registered monorepo at add_task instead', async () => {
    const { tools } = setup({ detection: monoDetection });
    const res = firstJson(await call(tools.get('add_app')!, { path: '/proj/web', workspaceTasks: true }));
    expect(res.note).toMatch(/already registered/);
    expect(res.note).toMatch(/add_task/);
  });
});

describe('add_task', () => {
  function monoSetup() {
    const root = mkdtempSync(join(tmpdir(), 'dh-addtask-'));
    mkdirSync(join(root, 'apps', 'api'), { recursive: true });
    const apps = [makeApp({ id: 'id-mono', name: 'mono', path: root })];
    const tasks = { 'id-mono': [makeTask({ id: 'task-migrate', appId: 'id-mono', name: 'migrate' })] };
    const { ctx, state } = makeContext({ apps, tasks });
    return { tools: captureTools(registerTools, ctx), state, root };
  }

  it('creates a script task with workingDir and dependsOn resolved by name', async () => {
    const { tools, state } = monoSetup();
    const res = firstJson(
      await call(tools.get('add_task')!, {
        app: 'mono',
        name: 'api',
        script: 'dev',
        workingDir: 'apps/api',
        dependsOn: ['migrate']
      })
    );
    expect(res.task.name).toBe('api');
    expect(res.task.workingDir).toBe('apps/api');
    expect(res.task.dependsOn).toEqual(['task-migrate']);
    expect(res.task.readiness).toEqual({ kind: 'none' });
    expect(state.tasks['id-mono']!.map((t) => t.name)).toEqual(['migrate', 'api']);
    expect(state.notifyChangedCalls).toBe(1);
  });

  it('defaults a oneShot task to exit-code-0 readiness', async () => {
    const { tools } = monoSetup();
    const res = firstJson(
      await call(tools.get('add_task')!, { app: 'mono', name: 'build', command: 'pnpm build', oneShot: true })
    );
    expect(res.task.oneShot).toBe(true);
    expect(res.task.readiness).toEqual({ kind: 'exit', code: 0 });
  });

  it('requires exactly one of script or command', async () => {
    const { tools } = monoSetup();
    const both = await call(tools.get('add_task')!, { app: 'mono', name: 'x', script: 'dev', command: 'ls' });
    expect(both.isError).toBe(true);
    const neither = await call(tools.get('add_task')!, { app: 'mono', name: 'x' });
    expect(neither.isError).toBe(true);
  });

  it('rejects a duplicate task name (case-insensitive)', async () => {
    const { tools } = monoSetup();
    const res = await call(tools.get('add_task')!, { app: 'mono', name: 'MIGRATE', script: 'dev' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/already exists/);
  });

  it('rejects absolute, escaping, and missing workingDir values', async () => {
    const { tools } = monoSetup();
    for (const workingDir of ['/etc', '../outside', 'apps/nope']) {
      const res = await call(tools.get('add_task')!, { app: 'mono', name: `t-${workingDir}`, script: 'dev', workingDir });
      expect(res.isError).toBe(true);
    }
  });

  it('errors when a dependsOn task cannot be resolved, creating nothing', async () => {
    const { tools, state } = monoSetup();
    const res = await call(tools.get('add_task')!, { app: 'mono', name: 'api', script: 'dev', dependsOn: ['ghost'] });
    expect(res.isError).toBe(true);
    expect(state.tasks['id-mono']!).toHaveLength(1);
    expect(state.notifyChangedCalls).toBe(0);
  });
});

describe('remove_task', () => {
  it('refuses without confirm: true', async () => {
    const { tools, state } = setup();
    const res = await call(tools.get('remove_task')!, { app: 'web', task: 'dev' });
    expect(res.isError).toBe(true);
    expect(state.tasks['id-web']!).toHaveLength(1);
  });

  it('refuses while the task is running', async () => {
    const { tools } = setup({ running: [runningTask('task-dev', 'id-web')] });
    const res = await call(tools.get('remove_task')!, { app: 'web', task: 'dev', confirm: true });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/Stop the task/);
  });

  it('surfaces the dependent-tasks guard as a clear error', async () => {
    const tasks = {
      'id-web': [
        makeTask({ id: 'task-db', appId: 'id-web', name: 'db' }),
        makeTask({ id: 'task-dev', appId: 'id-web', name: 'dev', dependsOn: ['task-db' as any] })
      ]
    };
    const { ctx } = makeContext({ apps: [makeApp({ id: 'id-web', name: 'web', path: '/proj/web' })], tasks });
    const tools = captureTools(registerTools, ctx);
    const res = await call(tools.get('remove_task')!, { app: 'web', task: 'db', confirm: true });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/depend on it/);
  });

  it('removes an idle task when confirmed and notifies the desktop', async () => {
    const { tools, state } = setup();
    const res = firstJson(await call(tools.get('remove_task')!, { app: 'web', task: 'dev', confirm: true }));
    expect(res.removed).toBe('dev');
    expect(state.tasks['id-web']!).toHaveLength(0);
    expect(state.notifyChangedCalls).toBe(1);
  });
});

describe('monorepo review fixes', () => {
  it('workspaceTasks dedupes duplicate package names instead of failing the create', async () => {
    const { tools, state } = setup({
      tasks: {},
      detection: {
        scripts: {},
        suggestedDefaultScript: null,
        workspaces: [
          { name: 'service', relPath: 'packages/a', scripts: ['dev'], suggestedScript: 'dev' },
          { name: 'service', relPath: 'packages/b', scripts: ['dev'], suggestedScript: 'dev' }
        ]
      }
    });
    const res = firstJson(await call(tools.get('add_app')!, { path: '/repo/dup', workspaceTasks: true }));
    expect(state.createAppCalls[0]!.tasks!.map((t) => t.name)).toEqual(['service', 'service (packages/b)']);
    expect(res.tasks).toEqual(['service', 'service (packages/b)']);
  });

  it('workspaceTasks drops a candidate whose relPath escapes the app root', async () => {
    const { state, tools } = setup({
      tasks: {},
      detection: {
        scripts: {},
        suggestedDefaultScript: null,
        workspaces: [
          { name: 'inside', relPath: 'apps/inside', scripts: ['dev'], suggestedScript: 'dev' },
          { name: 'escape', relPath: '../sibling', scripts: ['dev'], suggestedScript: 'dev' }
        ]
      }
    });
    await call(tools.get('add_app')!, { path: '/repo/esc', workspaceTasks: true });
    expect(state.createAppCalls[0]!.tasks!.map((t) => t.name)).toEqual(['inside']);
  });

  it('add_task rejects a workingDir that is a file, not a directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dh-file-'));
    mkdirSync(join(root, 'apps'), { recursive: true });
    writeFileSync(join(root, 'apps', 'notes.txt'), 'x');
    const { ctx } = makeContext({ apps: [makeApp({ id: 'id-f', name: 'f', path: root })], tasks: { 'id-f': [] } });
    const tools = captureTools(registerTools, ctx);
    const res = await call(tools.get('add_task')!, { app: 'f', name: 't', script: 'dev', workingDir: 'apps/notes.txt' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not an existing directory/);
  });

  it('add_task rejects a dependency on a disabled task', async () => {
    const tasks = { 'id-web': [makeTask({ id: 'task-db', appId: 'id-web', name: 'db', enabled: false })] };
    const { ctx } = makeContext({ apps: [makeApp({ id: 'id-web', name: 'web', path: '/proj/web' })], tasks });
    const tools = captureTools(registerTools, ctx);
    const res = await call(tools.get('add_task')!, { app: 'web', name: 'api', script: 'dev', dependsOn: ['db'] });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/disabled/);
  });

  it('remove_task refuses a task id that belongs to a different app', async () => {
    const apps = [
      makeApp({ id: 'id-a', name: 'frontend', path: '/proj/a' }),
      makeApp({ id: 'id-b', name: 'backend', path: '/proj/b' })
    ];
    const tasks = {
      'id-a': [makeTask({ id: 'task-a-dev', appId: 'id-a', name: 'dev' })],
      'id-b': [makeTask({ id: 'task-b-dev', appId: 'id-b', name: 'dev' })]
    };
    const { ctx, state } = makeContext({ apps, tasks });
    const tools = captureTools(registerTools, ctx);
    const res = await call(tools.get('remove_task')!, { app: 'frontend', task: 'task-b-dev', confirm: true });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/different app/);
    expect(state.tasks['id-b']!).toHaveLength(1);
  });

  it('remove_task refuses while the app is starting (in-flight orchestration)', async () => {
    const { tools, state } = setup({ states: { 'id-web': 'starting' } });
    const res = await call(tools.get('remove_task')!, { app: 'web', task: 'dev', confirm: true });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/starting/);
    expect(state.tasks['id-web']!).toHaveLength(1);
  });
});
