import { BrowserWindow, dialog, ipcMain, Notification } from 'electron';
import type { InvokeChannelName, InvokeChannels, ImportCandidate, GlobalLogMatch } from '@shared/ipc';
import type { AppId, EnvVar, TaskId } from '@shared/types';
import { closeDb, db, dbFile } from '../db/index.js';
import { logger } from '../services/Logger';
import { TrayController, type TrayApp } from '../services/TrayController';
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
import { existsSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { StatsTick } from '../services/StatsMonitor';
import type { PortsEvent } from '../services/PortDetector';

type Handler<C extends InvokeChannelName> = (
  req: InvokeChannels[C]['req']
) => Promise<InvokeChannels[C]['res']> | InvokeChannels[C]['res'];

function register<C extends InvokeChannelName>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, async (_evt, req) => handler(req));
}

export interface IpcRuntime {
  /** Number of tasks currently live - for the quit confirmation. */
  runningTaskCount: () => number;
  /** Gracefully stop every running task (SIGTERM → grace → SIGKILL tree). */
  stopAllRunning: () => Promise<void>;
  /** Reset per-renderer state (log subscriptions) when the window reloads/navigates. */
  onRendererReload: () => void;
}

export function registerAllIpcHandlers(
  win: () => BrowserWindow | null,
  getOrCreateWindow: () => { win: BrowserWindow; created: boolean }
): IpcRuntime {
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

  // Boot maintenance: cap run_history growth and encrypt any plaintext secret env values
  // left over from before encryption-at-rest landed (both are no-ops when already done).
  try {
    runHistory.prune(settings.get('run_history_limit'));
  } catch (e) {
    logger.warn('run_history prune failed', e);
  }
  try {
    envStore.migratePlaintextSecrets();
  } catch (e) {
    logger.warn('secret migration failed', e);
  }

  // Visibility-gated log streaming: the renderer subscribes to the task(s) it's showing. Until
  // it subscribes to anything we forward all task:log events (back-compat); once it subscribes,
  // we only forward subscribed tasks, so background tasks' chatter doesn't flood the renderer.
  const logSubs = new Set<string>();

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
    if (logSubs.size > 0 && !logSubs.has(evt.taskId)) return;
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

  // --- Menubar tray (IMPROVEMENT-PLAN 14.1) ---------------------------------------------------
  const aggregatePorts = (appId: AppId): number[] => {
    const ports = new Set<number>();
    for (const rt of runner.list()) if (rt.appId === appId) for (const p of rt.ports) ports.add(p);
    return [...ports].sort((a, b) => a - b);
  };
  const trayApps = (): TrayApp[] =>
    registry.list().map((a) => ({
      id: a.id,
      name: a.name,
      state: orchestrator.appState(a.id),
      ports: aggregatePorts(a.id)
    }));
  const tray = new TrayController({
    listApps: trayApps,
    start: (id) => void orchestrator.startApp(id).catch((e) => logger.warn('tray start failed', e)),
    stop: (id) => void orchestrator.stopApp(id).catch((e) => logger.warn('tray stop failed', e)),
    stopAll: () => void orchestrator.stopAllRunning(),
    open: () => {
      getOrCreateWindow();
    },
    quit: () => electronApp.quit()
  });
  if (settings.get('tray_enabled')) tray.enable();
  // Port chips in the tray menu update as lsof discovers them.
  runner.on('ports', () => tray.refresh());

  // Reconcile launch-at-login with the OS - the OS wins. If the user removed (or added)
  // DevHarbor under System Settings → Login Items, adopt that into our setting rather than
  // re-asserting a stale stored value over their explicit choice; we only WRITE login-item
  // state from the settings:set handler, i.e. when toggled in-app.
  try {
    const osValue = electronApp.getLoginItemSettings().openAtLogin;
    if (osValue !== settings.get('launch_at_login')) {
      settings.set('launch_at_login', osValue);
    }
  } catch (e) {
    logger.warn('login-item reconcile failed', e);
  }

  // --- Crash / ready desktop notifications (IMPROVEMENT-PLAN 14.2) -----------------------------
  const focusAppInWindow = (appId: AppId): void => {
    const { win: w, created } = getOrCreateWindow();
    const send = (): void => {
      w.webContents.send('deepLink:focusApp', { appId });
    };
    if (created) w.webContents.once('did-finish-load', () => setTimeout(send, 200));
    else send();
  };
  const taskReady = new Map<string, boolean>();
  runner.on('status', (evt: TaskStatusEvent) => {
    tray.refresh();
    if (!Notification.isSupported()) return;
    const appName = registry.get(evt.appId)?.name ?? 'App';
    if (evt.state === 'crashed' && settings.get('notify_on_crash')) {
      const n = new Notification({
        title: `${appName} crashed`,
        body: evt.exitCode != null ? `A task exited with code ${evt.exitCode}.` : 'A task crashed.'
      });
      n.on('click', () => focusAppInWindow(evt.appId));
      n.show();
    }
    if (settings.get('notify_on_ready')) {
      const was = taskReady.get(evt.taskId) ?? false;
      if (evt.ready && !was) {
        const n = new Notification({ title: `${appName} is ready`, body: 'A task reached its readiness signal.' });
        n.on('click', () => focusAppInWindow(evt.appId));
        n.show();
      }
    }
    taskReady.set(evt.taskId, evt.ready);
    if (evt.state === 'exited' || evt.state === 'crashed') taskReady.delete(evt.taskId);
  });

  // --- Auto-start flagged apps on launch (IMPROVEMENT-PLAN 14.6) -------------------------------
  for (const a of registry.list()) {
    if (a.autoStart) {
      void orchestrator.startApp(a.id).catch((e) => logger.warn(`auto-start of ${a.name} failed`, e));
    }
  }

  register('app:ping', (msg) => `pong: ${msg}`);

  register('apps:list', () => registry.list());
  register('apps:add', async ({ path }) => {
    const app = await registry.add(path);
    envFileWatcher.watch(app.id, app.path);
    syncRestartWatcher(app.id);
    tray.refresh();
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
    tray.refresh(); // rename / folder changes show in the tray menu
    return app;
  });
  register('apps:remove', ({ id }) => {
    // Only block removal while the app is actually LIVE. The sticky outcome design means an
    // app that ever ran reports 'exited'/'crashed' forever, so the old `!== 'idle'` guard made
    // every previously-run app permanently unremovable (IMPROVEMENT-PLAN 5.2).
    const st = orchestrator.appState(id as AppId);
    if (st === 'running' || st === 'starting' || st === 'exiting') {
      throw new Error('Stop the app before removing it.');
    }
    envFileWatcher.unwatch(id);
    restartWatcher.unwatch(id);
    orchestrator.clearOutcome(id as AppId);
    registry.remove(id);
    tray.refresh();
  });
  register('apps:detect', ({ path }) => detector.detect(path));

  // Atomic create: app + first task + env vars in ONE main-process handler with rollback, so a
  // partial failure (or a renderer reload mid-flow) can't leave an orphan app row
  // (IMPROVEMENT-PLAN 12.7). FK cascade cleans tasks/env if we roll back.
  register('apps:create', async (input) => {
    const real = realpathSync(input.path);
    if (registry.getByPath(real)) {
      throw new Error('This folder is already registered.');
    }
    const app = await registry.add(input.path);
    try {
      const patched = registry.update(app.id, {
        name: input.name?.trim() || app.name,
        nodeVersionPref: input.nodeVersionPref ?? { kind: 'auto' },
        packageManager: input.packageManager ?? null,
        defaultScript: input.defaultScript ?? null
      });
      const taskSpecs = [...(input.firstTask ? [input.firstTask] : []), ...(input.tasks ?? [])];
      for (const spec of taskSpecs) {
        taskRegistry.add(app.id, {
          name: spec.name,
          commandKind: spec.commandKind,
          script: spec.script ?? null,
          customCommand: spec.customCommand ?? null,
          workingDirOverride: spec.workingDirOverride ?? null,
          enabled: true
        });
      }
      if (input.envVars && input.envVars.length > 0) {
        const vars: EnvVar[] = input.envVars
          .filter((v) => v.key.trim())
          .map((v) => ({
            id: '',
            appId: app.id,
            key: v.key.trim(),
            value: v.value,
            enabled: true,
            isSecret: v.isSecret ?? false
          }));
        envStore.setApp(app.id, vars);
      }
      envFileWatcher.watch(app.id, app.path);
      syncRestartWatcher(app.id);
      tray.refresh();
      return patched;
    } catch (err) {
      try {
        registry.remove(app.id);
      } catch {
        /* best-effort rollback */
      }
      throw err;
    }
  });

  // Shallow-scan a folder for package.json projects (bulk import). One level deep; skips
  // already-registered folders' "alreadyRegistered" flag so the picker can disable them.
  register('apps:scanFolder', async ({ dir }) => {
    const out: ImportCandidate[] = [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      try {
        if (!statSync(full).isDirectory()) continue;
        if (!existsSync(join(full, 'package.json'))) continue;
      } catch {
        continue;
      }
      let real = full;
      try {
        real = realpathSync(full);
      } catch {
        // use raw
      }
      const detection = await detector.detect(full);
      out.push({
        path: full,
        name: basename(real),
        alreadyRegistered: !!registry.getByPath(real),
        packageManager: detection.packageManager,
        suggestedScript: detection.suggestedDefaultScript,
        scripts: Object.keys(detection.scripts)
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  });
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
  register('tasks:listAll', () => taskRegistry.listAll());
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

  register('task:subscribeLogs', ({ id }) => {
    logSubs.add(id);
  });
  register('task:unsubscribeLogs', ({ id }) => {
    logSubs.delete(id);
  });

  // Global log search: fan over every live task's ring buffer in main and return matches.
  register('logs:searchAll', ({ query, flags, limit }) => {
    const out: GlobalLogMatch[] = [];
    if (!query.trim()) return out;
    let re: RegExp;
    try {
      re = new RegExp(query, flags ?? 'i');
    } catch {
      // Fall back to a literal substring match if the regex is invalid.
      re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const cap = limit ?? 500;
    for (const rt of runner.list()) {
      const app = registry.get(rt.appId);
      const tasks = taskRegistry.list(rt.appId);
      const taskName = tasks.find((t) => t.id === rt.taskId)?.name ?? '';
      const buf = runner.readBuffer(rt.taskId);
      for (const line of buf.split('\n')) {
        if (re.test(line)) {
          out.push({
            appId: rt.appId,
            taskId: rt.taskId,
            appName: app?.name ?? '',
            taskName,
            line: line.length > 2000 ? line.slice(0, 2000) : line
          });
          if (out.length >= cap) return out;
        }
      }
    }
    return out;
  });

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
    if (patch.auto_update === false) updater.stop();
    // Apply OS-level + tray side effects immediately.
    if (typeof patch.tray_enabled === 'boolean') {
      if (patch.tray_enabled) tray.enable();
      else tray.disable();
      tray.refresh();
    }
    if (typeof patch.launch_at_login === 'boolean') {
      electronApp.setLoginItemSettings({ openAtLogin: patch.launch_at_login, openAsHidden: true });
    }
    return next;
  });

  register('update:install', () => {
    updater.quitAndInstall();
  });
  register('update:check', () => {
    updater.checkNow();
  });

  register('logs:path', () => logger.path());
  register('logs:openFolder', () => {
    logger.openFolder();
  });

  const openIn = new OpenIn();
  register('openIn:caps', () => openIn.caps());
  register('openIn:open', ({ target, path }) => openIn.open(target, path));

  // Danger-zone DB helpers.
  const dbPath = dbFile();
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
    // Use SQLite's online backup, NOT a raw file copy: in WAL mode most recent writes live in
    // the -wal sidecar, so copyFileSync of just the .db would silently miss them
    // (IMPROVEMENT-PLAN 5.11). backup() produces a fully-consistent single file.
    await db().backup(result.filePath);
    return result.filePath;
  });
  register('db:reset', () => {
    // Close the handle FIRST (checkpoints the WAL into the main file), then move the .db AND
    // its -wal/-shm sidecars aside together so the relaunch can't recover stale WAL into the
    // fresh DB. closeDb() also sets the shutdown guard so nothing re-opens mid-reset.
    closeDb();
    const stamp = Date.now();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${dbPath}${suffix}`;
      if (!existsSync(f)) continue;
      try {
        renameSync(f, `${f}.reset-${stamp}.bak`);
      } catch (e) {
        logger.warn(`db:reset could not move ${f} aside`, e);
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

  return {
    runningTaskCount: () => orchestrator.runningTaskCount(),
    stopAllRunning: () => orchestrator.stopAllRunning(),
    // A renderer reload (⌘R is kept in prod) loses the renderer-side unsubscribe calls; if the
    // stale subscriptions lingered, log forwarding would stay gated to dead taskIds forever.
    onRendererReload: () => logSubs.clear()
  };
}
