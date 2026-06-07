import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach } from 'vitest';
import { AppOrchestrator } from '../AppOrchestrator';
import type { ProcessState } from '@shared/types';

/**
 * Reproduces the exact app-state event flow for a Start → Stop cycle WITHOUT spawning a
 * real process. We feed the orchestrator a fake TaskRegistry + a fake TaskRunner (an
 * EventEmitter we can drive), then assert the sequence of `proc:status` states it emits.
 *
 * This is the deterministic check behind the "app stays Idle after stop" bug report.
 */

type RunState = { taskId: string; appId: string; state: ProcessState; ready: boolean };

function makeFakes() {
  const runner = new EventEmitter() as EventEmitter & { list: () => RunState[] };
  let runList: RunState[] = [];
  runner.list = () => runList;
  const setRunList = (next: RunState[]): void => {
    runList = next;
  };

  const tasks = {
    list: (_appId: string) => [{ id: 't1', appId: 'a1', enabled: true }]
  };

  const apps = {
    update: () => undefined
  };

  return { runner, setRunList, tasks, apps };
}

describe('AppOrchestrator app-state on stop', () => {
  let orch: AppOrchestrator;
  let runner: EventEmitter & { list: () => RunState[] };
  let setRunList: (next: RunState[]) => void;
  let emitted: ProcessState[];

  beforeEach(() => {
    const f = makeFakes();
    runner = f.runner;
    setRunList = f.setRunList;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    orch = new AppOrchestrator(f.apps as any, f.tasks as any, f.runner as any);
    emitted = [];
    orch.on('proc:status', (e: { appId: string; state: ProcessState }) => emitted.push(e.state));
  });

  /** Drive a task:status the way TaskRunner does: update the running list, then emit. */
  const driveTask = (state: ProcessState, ready = false): void => {
    if (state === 'exited' || state === 'crashed') {
      // TaskRunner keeps the exited task tracked briefly, then removes it.
      setRunList([{ taskId: 't1', appId: 'a1', state, ready }]);
    } else {
      setRunList([{ taskId: 't1', appId: 'a1', state, ready }]);
    }
    runner.emit('status', { taskId: 't1', appId: 'a1', state, ready, exitCode: null });
  };

  it('settles on "exited" after a stop — never reverts to "idle"', () => {
    // Running.
    driveTask('running', true);
    expect(orch.appState('a1' as never)).toBe('running');

    // User stops → task goes exiting, then exited (still tracked for ~1.5s).
    driveTask('exiting', true);
    expect(emitted.at(-1)).toBe('exiting');

    driveTask('exited');
    expect(emitted.at(-1)).toBe('exited');

    // Teardown: TaskRunner removes the tracked task. No event fires, but any later
    // recompute (a stray re-derive, a renderer poll) must NOT return 'idle'.
    setRunList([]);
    expect(orch.appState('a1' as never)).toBe('exited');
  });

  it('listApps() includes the stopped app so a renderer reload keeps it Stopped', () => {
    driveTask('running', true);
    driveTask('exited');
    setRunList([]); // torn down

    const summaries = orch.listApps();
    const a1 = summaries.find((s) => s.appId === ('a1' as never));
    expect(a1).toBeDefined();
    expect(a1?.state).toBe('exited');
  });

  it('a crash sticks as "crashed", not "idle"', () => {
    driveTask('running', true);
    driveTask('crashed');
    setRunList([]);
    expect(orch.appState('a1' as never)).toBe('crashed');
  });

  it('never-run app is "idle" (no sticky outcome)', () => {
    setRunList([]);
    expect(orch.appState('a1' as never)).toBe('idle');
  });

  it('primeOutcome() persists a Stopped/Crashed badge across restart (boot seeding)', () => {
    // Simulate a fresh boot: nothing running, but history says it last exited.
    setRunList([]);
    orch.primeOutcome('a1' as never, 'exited');
    expect(orch.appState('a1' as never)).toBe('exited');

    const summary = orch.listApps().find((s) => s.appId === ('a1' as never));
    expect(summary?.state).toBe('exited');

    // Crash outcome seeds as crashed.
    orch.primeOutcome('a1' as never, 'crashed');
    expect(orch.appState('a1' as never)).toBe('crashed');
  });
});
