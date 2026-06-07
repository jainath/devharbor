import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { AppOrchestrator } from '../AppOrchestrator';
import { TaskRunner } from '../TaskRunner';
import type { App, ProcessState, Task } from '@shared/types';

/**
 * REAL end-to-end check: spawns an actual short-lived process via TaskRunner, runs the true
 * Start → Stop cycle through AppOrchestrator, and records every `proc:status` the renderer
 * WOULD receive — INCLUDING after the ~1.5s post-exit teardown. Only the DB/FS-touching
 * collaborators are stubbed; the pty, event wiring, and state derivation are the real code.
 *
 * This is the definitive reproduction for the "app reverts to Idle after stop" report.
 */

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeApp(): App {
  return {
    id: 'a1' as App['id'],
    name: 'e2e',
    path: process.cwd(),
    color: '#fff',
    icon: undefined,
    nodeVersionPref: { kind: 'system' },
    packageManager: 'npm',
    defaultScript: null,
    customCommand: null,
    workingDir: process.cwd(),
    autoRestartOnChange: false,
    watchGlobs: [],
    portHint: null,
    tags: [],
    folder: null,
    lastStartedAt: null,
    lastExitCode: null,
    createdAt: 0,
    updatedAt: 0
  } as App;
}

function makeTask(): Task {
  return {
    id: 't1' as Task['id'],
    appId: 'a1' as Task['appId'],
    name: 'dev',
    position: 0,
    commandKind: 'custom',
    script: null,
    // Realistic dev server: opens a port (so PORT readiness resolves), then idles.
    customCommand:
      "node -e \"require('net').createServer(()=>{}).listen(59871, ()=>process.stdout.write('up\\n')); setInterval(()=>{}, 1000)\"",
    workingDirOverride: null,
    packageManagerOverride: null,
    nodeVersionPrefOverride: null,
    dependsOn: [],
    readiness: { kind: 'port', port: 59871 },
    oneShot: false,
    enabled: true,
    envOverrides: {},
    createdAt: 0,
    updatedAt: 0
  };
}

function makeRunner(): TaskRunner {
  const app = makeApp();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry: any = { get: (_id: string) => app };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env: any = { build: async () => ({ ...process.env }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes: any = { resolve: () => ({ binDir: '', version: 'system', source: 'system' }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logs: any = { append: () => {}, read: () => '', tail: () => '', clear: () => {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const history: any = { start: () => 'run1', finish: () => {} };
  class FakeMon extends EventEmitter {
    track(): void {}
    untrack(): void {}
    observeChunk(): void {}
    setInterval(): void {}
  }
  return new TaskRunner(
    registry,
    env,
    nodes,
    logs,
    history,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new FakeMon() as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new FakeMon() as any,
    null
  );
}

describe('AppOrchestrator REAL start→stop (spawns a process)', () => {
  it('stays "exited" after stop — including past the 1.5s teardown', async () => {
    const runner = makeRunner();
    const task = makeTask();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apps: any = { update: () => {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tasks: any = { list: () => [task], get: () => task };
    const orch = new AppOrchestrator(apps, tasks, runner);

    const log: { t: number; state: ProcessState }[] = [];
    const t0 = Date.now();
    orch.on('proc:status', (e: { state: ProcessState }) =>
      log.push({ t: Date.now() - t0, state: e.state })
    );

    await orch.startApp('a1' as never);
    await delay(150);
    expect(orch.appState('a1' as never)).toBe('running');

    await orch.stopApp('a1' as never);
    const afterStop = orch.appState('a1' as never);

    // Wait WELL past the 1500ms tracked-task teardown.
    await delay(2000);
    const afterTeardown = orch.appState('a1' as never);

    expect(afterStop).toBe('exited');
    expect(afterTeardown).toBe('exited');
    // The renderer must never have been told 'idle' at any point.
    expect(log.map((l) => l.state)).not.toContain('idle');
  }, 15000);
});
