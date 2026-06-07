import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppId, ProcessState } from '@shared/types';
import { useStore } from './store/store';
import { Sidebar } from './components/Sidebar';
import { AppDetail } from './components/AppDetail';
import { EmptyState } from './components/EmptyState';
import { PromptModalHost, openConfirm } from './components/PromptModal';
import { Dashboard } from './components/Dashboard';
import { CommandPalette } from './components/CommandPalette';
import { SettingsDrawer } from './components/SettingsDrawer';
import { UpdateBanner } from './components/UpdateBanner';
import { AddAppDrawer } from './components/AddAppDrawer';
import { useTheme } from './hooks/useTheme';

export function App(): JSX.Element {
  const apps = useStore((s) => s.apps);
  const view = useStore((s) => s.view);
  const selectedId = useStore((s) => s.selectedAppId);
  const setApps = useStore((s) => s.setApps);
  const setRunningApps = useStore((s) => s.setRunningApps);
  const setRunningTasks = useStore((s) => s.setRunningTasks);
  const upsertApp = useStore((s) => s.upsertApp);
  const setSelected = useStore((s) => s.setSelected);
  const setView = useStore((s) => s.setView);
  const applyAppStatus = useStore((s) => s.applyAppStatus);
  const applyTaskStatus = useStore((s) => s.applyTaskStatus);
  const applyTaskStats = useStore((s) => s.applyTaskStats);
  const applyTaskPorts = useStore((s) => s.applyTaskPorts);
  const applyEnvFileChange = useStore((s) => s.applyEnvFileChange);

  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [pendingAddPath, setPendingAddPath] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Latest onAddApp without re-subscribing the event effect when it changes.
  const onAddAppRef = useRef<(() => Promise<void>) | null>(null);

  // Apply persisted theme to <html>.
  useTheme();

  useEffect(() => {
    void (async () => {
      const [list, running, runningTasks] = await Promise.all([
        window.api.invoke('apps:list', undefined),
        window.api.invoke('proc:list', undefined),
        window.api.invoke('task:list', undefined)
      ]);
      setApps(list);
      setRunningApps(running);
      setRunningTasks(runningTasks);
      // Pre-load tasks for every registered app so the Dashboard knows their
      // task counts + port chips without waiting for the user to open each
      // AppDetail. (Before this, `tasksByApp` was populated lazily on AppDetail
      // mount, so multi-task apps the user only Started from the Dashboard had
      // empty tasks → no port chips.)
      await Promise.all(
        list.map(async (a) => {
          try {
            const t = await window.api.invoke('tasks:list', { appId: a.id });
            useStore.getState().setTasksForApp(a.id, t);
          } catch {
            // best-effort
          }
        })
      );
      // Always land on Dashboard on cold boot / Cmd+R reload. App detail is
      // reached by clicking an app in the sidebar.
      setView('dashboard');
    })();

    const offTaskStatus = window.api.on(
      'task:status',
      ({ taskId, appId, state, ready, exitCode }) => {
        applyTaskStatus(taskId, appId, state as ProcessState, ready, exitCode ?? null);
      }
    );
    const offAppStatus = window.api.on('proc:status', ({ appId, state, exitCode }) => {
      applyAppStatus(appId, state as ProcessState, exitCode ?? null);
    });
    const offStats = window.api.on('task:stats', ({ taskId, cpu, memMB }) => {
      applyTaskStats(taskId, cpu, memMB);
    });
    const offPorts = window.api.on('task:ports', ({ taskId, ports }) => {
      applyTaskPorts(taskId, ports);
    });
    const offEnvFile = window.api.on('env:fileChanged', (change) => {
      applyEnvFileChange(change);
    });
    const offDeepFocus = window.api.on('deepLink:focusApp', ({ appId }) => {
      setSelected(appId);
    });
    const offDeepUnknown = window.api.on('deepLink:unknownPath', ({ path }) => {
      setPendingAddPath(path);
    });
    // A devharbor://start link asks to run an app's tasks. Confirm first — a link from any
    // web page must not silently execute local shell commands.
    const offDeepConfirmStart = window.api.on('deepLink:confirmStart', ({ appId, appName }) => {
      setSelected(appId);
      void openConfirm({
        title: `Start “${appName}”?`,
        description: 'A devharbor:// link asked to start this app, which runs its tasks (including any custom shell commands).',
        confirmLabel: 'Start app'
      }).then((ok) => {
        if (ok) void window.api.invoke('proc:start', { id: appId });
      });
    });
    // macOS menu actions (Settings ⌘, / Add App ⌘N / Add Folder ⌘⇧N).
    const offMenuSettings = window.api.on('menu:openSettings', () => setSettingsOpen(true));
    const offMenuAddApp = window.api.on('menu:addApp', () => void onAddAppRef.current?.());
    const offMenuNewFolder = window.api.on('menu:newFolder', () =>
      window.dispatchEvent(new CustomEvent('devharbor:new-folder'))
    );
    return () => {
      offTaskStatus();
      offAppStatus();
      offStats();
      offPorts();
      offEnvFile();
      offDeepFocus();
      offDeepUnknown();
      offDeepConfirmStart();
      offMenuSettings();
      offMenuAddApp();
      offMenuNewFolder();
    };
  }, [
    setApps,
    setRunningApps,
    setRunningTasks,
    setView,
    setSelected,
    applyAppStatus,
    applyTaskStatus,
    applyTaskStats,
    applyTaskPorts,
    applyEnvFileChange
  ]);

  const onAddApp = useCallback(async (): Promise<void> => {
    if (adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const path = await window.api.invoke('dialog:browse', undefined);
      if (!path) return;
      // If this path is already registered, focus that app instead of re-adding.
      const existing = await window.api.invoke('apps:findByPath', { path });
      if (existing) {
        setSelected(existing.id as AppId);
        setAddError(`"${existing.name}" is already registered — focused it.`);
        return;
      }
      // Otherwise open the confirm-before-add drawer.
      setPendingAddPath(path);
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setAdding(false);
    }
  }, [adding, setSelected]);

  onAddAppRef.current = onAddApp;

  // Global Cmd+K / Ctrl+K to toggle the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selected = apps.find((a) => a.id === selectedId);

  let main: JSX.Element;
  if (view === 'dashboard') {
    main = <Dashboard />;
  } else if (selected) {
    main = <AppDetail app={selected} />;
  } else {
    main = <EmptyState onAddApp={onAddApp} />;
  }

  return (
    <div className="flex h-full w-full">
      <Sidebar
        onAddApp={onAddApp}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      {main}
      {addError && (
        <div className="pointer-events-none absolute bottom-4 right-4 max-w-md rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-fg shadow-lg">
          {addError}
        </div>
      )}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onAddApp={onAddApp}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
      {pendingAddPath && (
        <AddAppDrawer
          path={pendingAddPath}
          onCancel={() => setPendingAddPath(null)}
          onConfirm={(app) => {
            setPendingAddPath(null);
            upsertApp(app);
            setSelected(app.id as AppId);
          }}
        />
      )}
      <UpdateBanner />
      <PromptModalHost />
    </div>
  );
}
