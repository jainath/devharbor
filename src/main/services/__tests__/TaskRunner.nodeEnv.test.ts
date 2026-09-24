import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, Task } from '@shared/types';
import { EnvBuilder } from '../EnvBuilder';
import { LogBuffer } from '../LogBuffer';
import { TaskRunner } from '../TaskRunner';

/**
 * Regression: a Custom Shell task must run with the same Node as a package.json script task.
 *
 * Custom commands used to run via `$SHELL -l -c`. A login shell re-runs the profile, and on
 * macOS /etc/zprofile's `path_helper` moves the /etc/paths entries (/usr/local/bin, …) AHEAD of
 * the PATH EnvBuilder computed - so `pnpm dev` picked up e.g. /usr/local/bin/node (v16) instead
 * of the nvm version selected for the app, while `pnpm run dev` as a script task was fine.
 *
 * Real TaskRunner + EnvBuilder + LogBuffer + node-pty + /bin/zsh; only the DB/FS-touching
 * collaborators are stubbed. The "selected Node" is a fake `node` in a temp bin dir that prints
 * its own path and the PATH it saw; the fake `pnpm` uses the same `#!/usr/bin/env node` shebang
 * as the real one, so it resolves `node` exactly the way pnpm does.
 */

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A realistic login PATH (what PathProbe returns): system dirs that may hold another node.
const PROBED_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

let root: string;
let binDir: string;
let home: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dh-nodeenv-'));
  binDir = join(root, 'node-v99', 'bin');
  home = join(root, 'home');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(home);
  writeFileSync(
    join(binDir, 'node'),
    `#!/bin/sh\nprintf 'DH_NODE=%s\\nDH_PATH=%s\\n' "$0" "$PATH"\n`
  );
  writeFileSync(join(binDir, 'pnpm'), '#!/usr/bin/env node\n');
  chmodSync(join(binDir, 'node'), 0o755);
  chmodSync(join(binDir, 'pnpm'), 0o755);
  // Pin the shell to zsh (the macOS default) and point HOME at an empty dir so the developer's
  // own dotfiles can't affect the result - the system /etc/zprofile still applies.
  vi.stubEnv('SHELL', '/bin/zsh');
  vi.stubEnv('HOME', home);
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function makeApp(): App {
  return {
    id: 'a1' as App['id'],
    name: 'nodeenv',
    path: root,
    color: '#fff',
    icon: undefined,
    nodeVersionPref: { kind: 'explicit', version: '99.0.0' },
    packageManager: 'pnpm',
    defaultScript: null,
    customCommand: null,
    workingDir: root,
    autoRestartOnChange: false,
    autoStart: false,
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

function makeTask(id: string, patch: Pick<Task, 'commandKind' | 'script' | 'customCommand'>): Task {
  return {
    id: id as Task['id'],
    appId: 'a1' as Task['appId'],
    name: id,
    position: 0,
    ...patch,
    workingDirOverride: null,
    packageManagerOverride: null,
    nodeVersionPrefOverride: null,
    dependsOn: [],
    readiness: { kind: 'exit' },
    oneShot: true,
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
  const envStore = { getGlobal: () => [], getApp: () => [], getTask: () => [] };
  const pathProbe = { get: async () => PROBED_PATH };
  const env = new EnvBuilder(envStore as never, pathProbe as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes: any = { resolve: () => ({ binDir, version: '99.0.0', source: 'nvm' }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const history: any = { start: () => 'run1', finish: () => {} };
  class FakeMon extends EventEmitter {
    track(): void {}
    untrack(): void {}
    observeChunk(): void {}
  }
  return new TaskRunner(
    registry,
    env,
    nodes,
    new LogBuffer(),
    history,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new FakeMon() as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new FakeMon() as any,
    null
  );
}

/** Run a one-shot task to completion and return what the fake `node` reported. */
async function runAndReport(
  task: Task
): Promise<{ node: string | undefined; path: string | undefined; output: string }> {
  const runner = makeRunner();
  const { awaitReady } = await runner.start(task);
  await awaitReady;
  // PTY data can trail the exit event slightly - poll the buffer briefly.
  let output = '';
  for (let i = 0; i < 20; i++) {
    output = runner.readBuffer(task.id);
    if (output.includes('DH_PATH=')) break;
    await delay(50);
  }
  return {
    node: /DH_NODE=([^\r\n]+)/.exec(output)?.[1],
    path: /DH_PATH=([^\r\n]+)/.exec(output)?.[1],
    output
  };
}

describe.skipIf(!existsSync('/bin/zsh'))('TaskRunner - Node environment parity', () => {
  it('script task runs node from the selected version bin dir', async () => {
    const r = await runAndReport(
      makeTask('t-script', { commandKind: 'script', script: 'dev', customCommand: null })
    );
    expect(r.node, r.output).toBe(join(binDir, 'node'));
    expect(r.path?.startsWith(`${binDir}:`), r.output).toBe(true);
  }, 15000);

  it('custom shell task gets the same Node + PATH order as the script task', async () => {
    const r = await runAndReport(
      makeTask('t-custom', { commandKind: 'custom', script: null, customCommand: 'pnpm dev' })
    );
    expect(r.node, r.output).toBe(join(binDir, 'node'));
    expect(r.path?.startsWith(`${binDir}:`), r.output).toBe(true);
  }, 15000);
});
