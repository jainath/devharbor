import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { InvokeChannelName, InvokeChannels } from '@shared/ipc';
import type { AppId, TaskId } from '@shared/types';
import { AppRegistry } from '../services/AppRegistry';
import { DetectionService } from '../services/DetectionService';
import { NodeResolver } from '../services/NodeResolver';
import { TaskRegistry } from '../services/TaskRegistry';
import { TaskRunner, type TaskLogEvent, type TaskStatusEvent } from '../services/TaskRunner';
import { AppOrchestrator } from '../services/AppOrchestrator';
import { RunHistory } from '../services/RunHistory';
import { EnvStore } from '../services/EnvStore';
import { EnvBuilder } from '../services/EnvBuilder';
import { EnvFileWatcher, type EnvFileChange } from '../services/EnvFileWatcher';
import { PathProbe } from '../services/PathProbe';
import { Settings } from '../services/Settings';
import { RestartWatcher } from '../services/RestartWatcher';
import { DeepLinks } from '../services/DeepLinks';
import { Updater } from '../services/Updater';
import { OpenIn } from '../services/OpenIn';
import { app as electronApp, dialog as electronDialog } from 'electron';
import { copyFileSync, existsSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { StatsTick } from '../services/StatsMonitor';
import type { PortsEvent } from '../services/PortDetector';

type Handler<C extends InvokeChannelName> = (
  req: InvokeChannels[C]['req']
) => Promise<InvokeChannels[C]['res']> | InvokeChannels[C]['res'];

function register<C extends InvokeChannelName>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, async (_evt, req) => handler(req));
}

export function registerAllIpcHandlers(win: () => BrowserWindow | null): void {
  const settings = new Settings();
  const pathProbe = new PathProbe();
  const detector = new DetectionService();
  const registry = new AppRegistry(detector);
  const nodes = new NodeResolver();
  const taskRegistry = new TaskRegistry();
  const envStore = new EnvStore();
  const envBuilder = new EnvBuilder(envStore, pathProbe);
  const runHistory = new RunHistory();
  const envFileWatcher = new EnvFileWatcher();
  const restartWatcher = new RestartWatcher();
  const runner = new TaskRunner(
    registry,
    envBuilder,
    nodes,
    undefined,           // logs (default LogBuffer)
    runHistory,
    undefined,           // stats (default StatsMonitor)
    undefined,           // ports (default PortDetector)
    settings             // for live kill_grace_ms
  );
  const orchestrator = new AppOrchestrator(registry, taskRegistry, runner);

  // Persist the "last known" badge across restarts: seed each app's sticky outcome from its
  // most recent run in history, so a previously run-and-stopped app shows Stopped/Crashed on
  // relaunch instead of resetting to Idle. Never-run apps have no history → stay Idle.
  for (const a of registry.list()) {
    const last = runHistory.list(a.id, 1)[0];
    if (!last) continue;
    const outcome: 'exited' | 'crashed' =
      last.exitCode == null
        ? 'exited' // run was still open at last quit (app closed while running) → now stopped
        : last.wasKilledByUser
          ? 'exited' // user stopped it
          : last.exitCode === 0
            ? 'exited' // clean exit
            : 'crashed'; // non-zero exit, not user-initiated
    orchestrator.primeOutcome(a.id, outcome);
  }

  // Apply current log_ring_size to the LogBuffer.
  runner.logs.setLimits({ maxLines: settings.get('log_ring_size') });

  const updater = new Updater(win);
  if (settings.get('auto_update')) updater.start();
  const deepLinks = new DeepLinks(
    registry,
    orchestrator,
    () => {
      const w = win();
      if (w) {
        if (w.isMinimized()) w.restore();
        w.focus();
      }
    },
    win
  );
  void deepLinks;

  // Wire restart-on-change watchers for every app that has it enabled.
  const syncRestartWatcher = (appId: AppId): void => {
    const a = registry.get(appId);
    if (!a) return;
    if (a.autoRestartOnChange) {
      restartWatcher.watch(a.id, a.path, a.watchGlobs);
    } else {
      restartWatcher.unwatch(a.id);
    }
  };
  for (const a of registry.list()) syncRestartWatcher(a.id);

  restartWatcher.on('restart', ({ appId }: { appId: AppId }) => {
    // Only restart if the app is currently running.
    if (orchestrator.appState(appId) === 'running' || orchestrator.appState(appId) === 'starting') {
      void orchestrator.restartApp(appId).catch((err: Error) => {
        // Surface to the renderer rather than swallowing.
        win()?.webContents.send('proc:status', {
          appId,
          state: 'crashed',
          exitCode: null,
          exitSignal: `restart-on-change failed: ${err.message}`
        });
      });
    }
  });

  // Apply dashboard refresh setting to the stats monitor.
  runner.stats.setInterval(settings.get('dashboard_refresh_ms'));

  // Start env watchers for every existing app on boot.
  for (const a of registry.list()) envFileWatcher.watch(a.id, a.path);

  // Forward task events to the renderer.
  runner.on('log', (evt: TaskLogEvent) => {
    win()?.webContents.send('task:log', evt);
  });
  runner.on('status', (evt: TaskStatusEvent) => {
    win()?.webContents.send('task:status', evt);
  });
  runner.on('stats', (evt: StatsTick) => {
    win()?.webContents.send('task:stats', evt);
  });
  runner.on('ports', (evt: PortsEvent) => {
    win()?.webContents.send('task:ports', evt);
  });
  orchestrator.on('proc:status', (evt) => {
    win()?.webContents.send('proc:status', evt);
  });
  envFileWatcher.on('change', (evt: EnvFileChange) => {
    win()?.webContents.send('env:fileChanged', evt);
  });

  register('app:ping', (msg) => `pong: ${msg}`);

  register('apps:list', () => registry.list());
  register('apps:add', async ({ path }) => {
    const app = await registry.add(path);
    envFileWatcher.watch(app.id, app.path);
    syncRestartWatcher(app.id);
    return app;
  });
  register('apps:update', ({ id, patch }) => {
    const before = registry.get(id);
    const app = registry.update(id, patch);
    if (!before || before.path !== app.path) {
      envFileWatcher.watch(app.id, app.path);
    }
    // Resync restart watcher if its config changed (or path changed).
    if (
      !before ||
      before.autoRestartOnChange !== app.autoRestartOnChange ||
      before.path !== app.path ||
      JSON.stringify(before.watchGlobs) !== JSON.stringify(app.watchGlobs)
    ) {
      syncRestartWatcher(app.id);
    }
    return app;
  });
  register('apps:remove', ({ id }) => {
    if (orchestrator.appState(id as AppId) !== 'idle') {
      throw new Error('Stop the app before removing it.');
    }
    envFileWatcher.unwatch(id);
    restartWatcher.unwatch(id);
    registry.remove(id);
  });
  register('apps:detect', ({ path }) => detector.detect(path));
  register('apps:findByPath', ({ path }) => {
    try {
      const real = realpathSync(path);
      return registry.getByPath(real);
    } catch {
      return null;
    }
  });

  register('proc:start', async ({ id }) => {
    await orchestrator.startApp(id);
  });
  register('proc:stop', async ({ id }) => {
    await orchestrator.stopApp(id);
  });
  register('proc:restart', async ({ id }) => {
    await orchestrator.restartApp(id);
  });
  register('proc:list', () => orchestrator.listApps());

  register('tasks:list', ({ appId }) => taskRegistry.list(appId));
  register('tasks:add', ({ appId, patch }) => taskRegistry.add(appId, patch));
  register('tasks:update', ({ id, patch }) => taskRegistry.update(id, patch));
  register('tasks:remove', ({ id }) => {
    if (runner.isRunning(id as TaskId)) {
      throw new Error('Stop the task before removing it.');
    }
    taskRegistry.remove(id);
  });
  register('tasks:reorder', ({ appId, taskIds }) => taskRegistry.reorder(appId, taskIds));

  register('task:start', ({ id }) => orchestrator.startTask(id));
  register('task:stop', ({ id }) => orchestrator.stopTask(id));
  register('task:list', () => runner.list());

  register('task:readBuffer', ({ id }) => runner.readBuffer(id));
  register('task:tailBuffer', ({ id, maxLines }) => runner.tailBuffer(id, maxLines));
  register('task:clearBuffer', ({ id }) => runner.clearBuffer(id));
  register('task:resize', ({ id, cols, rows }) => runner.resize(id, cols, rows));

  register('runs:list', ({ appId, limit }) => runHistory.list(appId, limit));

  register('env:getGlobal', () => envStore.getGlobal());
  register('env:setGlobal', ({ vars }) => {
    envStore.setGlobal(vars);
  });
  register('env:getApp', ({ id }) => envStore.getApp(id));
  register('env:setApp', ({ id, vars }) => {
    envStore.setApp(id, vars);
  });
  register('env:getTask', ({ id }) => envStore.getTask(id));
  register('env:setTask', ({ id, vars }) => {
    envStore.setTask(id, vars);
  });

  register('folders:list', () => registry.listFolders());
  register('folders:rename', ({ from, to }) => {
    registry.renameFolder(from, to);
  });
  register('folders:clear', ({ name }) => {
    registry.clearFolder(name);
  });
  register('env:files', ({ id }) => {
    const app = registry.get(id);
    if (!app) return [];
    return envFileWatcher.list(app.path);
  });

  register('settings:get', () => settings.getAll());
  register('settings:set', ({ patch }) => {
    const next = settings.setMany(patch);
    if (typeof patch.dashboard_refresh_ms === 'number') {
      runner.stats.setInterval(patch.dashboard_refresh_ms);
    }
    if (typeof patch.log_ring_size === 'number') {
      runner.logs.setLimits({ maxLines: patch.log_ring_size });
    }
    if (patch.auto_update === true) updater.start();
    return next;
  });

  register('update:install', () => {
    updater.quitAndInstall();
  });

  const openIn = new OpenIn();
  register('openIn:caps', () => openIn.caps());
  register('openIn:open', ({ target, path }) => openIn.open(target, path));

  // Danger-zone DB helpers.
  const dbPath = join(electronApp.getPath('userData'), 'devharbor.db');
  register('db:path', () => dbPath);
  register('db:export', async () => {
    const w = win();
    if (!w) return null;
    const result = await electronDialog.showSaveDialog(w, {
      title: 'Export DevHarbor database',
      defaultPath: `devharbor-${Date.now()}.db`,
      filters: [{ name: 'SQLite DB', extensions: ['db'] }]
    });
    if (result.canceled || !result.filePath) return null;
    copyFileSync(dbPath, result.filePath);
    return result.filePath;
  });
  register('db:reset', () => {
    // Best-effort wipe — the next launch creates a fresh DB via migrations.
    // We DON'T delete in-place; we move the existing file aside in case of regret.
    if (existsSync(dbPath)) {
      const archive = `${dbPath}.reset-${Date.now()}.bak`;
      try {
        copyFileSync(dbPath, archive);
      } catch {
        // ignore
      }
      try {
        unlinkSync(dbPath);
      } catch {
        // ignore
      }
    }
    // Force a restart so migrations + handlers run against the empty DB.
    electronApp.relaunch();
    electronApp.exit(0);
  });

  register('node:list', () => nodes.list(true));
  register('node:resolve', ({ id }) => {
    const app = registry.get(id);
    if (!app) throw new Error(`Unknown app: ${id}`);
    return nodes.resolve(app.nodeVersionPref, app.path);
  });

  register('dialog:browse', async () => {
    const w = win();
    if (!w) return null;
    const result = await dialog.showOpenDialog(w, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a project folder'
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });
}
