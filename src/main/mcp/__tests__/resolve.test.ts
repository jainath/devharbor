import { describe, expect, it } from 'vitest';
import { resolveApp, resolveTask, ResolutionError } from '../context';
import { makeApp, makeContext, makeTask } from './fakeContext';

describe('resolveApp', () => {
  const apps = [
    makeApp({ id: 'id-web', name: 'web', path: '/proj/web' }),
    makeApp({ id: 'id-api', name: 'api', path: '/proj/api' }),
    makeApp({ id: 'id-dupe1', name: 'dupe', path: '/proj/d1' }),
    makeApp({ id: 'id-dupe2', name: 'dupe', path: '/proj/d2' })
  ];

  it('resolves by id', () => {
    const { ctx } = makeContext({ apps });
    expect(resolveApp(ctx, 'id-api').name).toBe('api');
  });

  it('resolves by exact name, case-insensitively', () => {
    const { ctx } = makeContext({ apps });
    expect(resolveApp(ctx, 'WEB').id).toBe('id-web');
  });

  it('resolves by absolute path', () => {
    const { ctx } = makeContext({ apps });
    expect(resolveApp(ctx, '/proj/web').id).toBe('id-web');
    // trailing slash tolerated
    expect(resolveApp(ctx, '/proj/web/').id).toBe('id-web');
  });

  it('errors on an ambiguous name and lists candidates', () => {
    const { ctx } = makeContext({ apps });
    try {
      resolveApp(ctx, 'dupe');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ResolutionError);
      expect((e as Error).message).toContain('ambiguous');
      expect((e as Error).message).toContain('id-dupe1');
    }
  });

  it('errors on unknown with nearest-match hint', () => {
    const { ctx } = makeContext({ apps });
    expect(() => resolveApp(ctx, 'webby')).toThrow(/No app matches "webby"/);
    // substring hint points at "web"
    try {
      resolveApp(ctx, 'we');
    } catch (e) {
      expect((e as Error).message).toContain('web');
    }
  });

  it('errors clearly for an unregistered absolute path', () => {
    const { ctx } = makeContext({ apps });
    expect(() => resolveApp(ctx, '/nope/here')).toThrow(/No app is registered at path/);
  });
});

describe('resolveTask', () => {
  const apps = [makeApp({ id: 'id-web', name: 'web', path: '/proj/web' })];
  const tasks = {
    'id-web': [
      makeTask({ id: 'task-dev', appId: 'id-web', name: 'dev' }),
      makeTask({ id: 'task-worker', appId: 'id-web', name: 'worker' })
    ]
  };

  it('resolves by task id', () => {
    const { ctx } = makeContext({ apps, tasks });
    expect(resolveTask(ctx, 'task-worker').name).toBe('worker');
  });

  it('resolves a globally-unique task name without app scope', () => {
    const { ctx } = makeContext({ apps, tasks });
    expect(resolveTask(ctx, 'worker').id).toBe('task-worker');
  });

  it('resolves a name scoped by app', () => {
    const { ctx } = makeContext({ apps, tasks });
    expect(resolveTask(ctx, 'dev', 'web').id).toBe('task-dev');
  });

  it('errors when the name is ambiguous across apps', () => {
    const apps2 = [...apps, makeApp({ id: 'id-api', name: 'api', path: '/proj/api' })];
    const tasks2 = {
      ...tasks,
      'id-api': [makeTask({ id: 'task-dev2', appId: 'id-api', name: 'dev' })]
    };
    const { ctx } = makeContext({ apps: apps2, tasks: tasks2 });
    expect(() => resolveTask(ctx, 'dev')).toThrow(/ambiguous/);
  });

  it('errors on an unknown task name', () => {
    const { ctx } = makeContext({ apps, tasks });
    expect(() => resolveTask(ctx, 'nope')).toThrow(/No task named/);
  });
});
