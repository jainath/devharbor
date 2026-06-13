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
import { ImportProjectsDrawer } from './components/ImportProjectsDrawer';
import { GlobalLogSearch } from './components/GlobalLogSearch';
import { ToastHost } from './components/Toast';
import { invokeOrToast } from './lib/invoke';
import { useTheme } from './hooks/useTheme';

export function App(): JSX.Element {
  const apps = useStore((s) => s.apps);
  const loaded = useStore((s) => s.loaded);
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

  const [addOpen, setAddOpen] = useState(false);
  const [addInitialPath, setAddInitialPath] = useState<string | null>(null);
  // Whether the add-drawer should auto-detect its initial path. False when the path arrived
  // from an untrusted devharbor:// deep link - the user must click "Scan this folder" first.
  const [addAutoDetect, setAddAutoDetect] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [logSearchOpen, setLogSearchOpen] = useState(false);

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
      // Pre-load tasks for every registered app so the Dashboard knows their task counts +
      // port chips without waiting for the user to open each AppDetail. One tasks:listAll
      // round-trip instead of the old per-app N+1 loop (IMPROVEMENT-PLAN 9.7).
      try {
        const all = await window.api.invoke('tasks:listAll', undefined);
        for (const a of list) {
          useStore.getState().setTasksForApp(a.id, all[a.id] ?? []);
        }
      } catch {
        // best-effort
      }
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
      // Path came from a web-page-triggerable deep link: prefill but don't auto-read the FS.
      setAddInitialPath(path);
      setAddAutoDetect(false);
      setAddOpen(true);
    });
    // A devharbor://start link asks to run an app's tasks. Confirm first - a link from any
    // web page must not silently execute local shell commands.
    const offDeepConfirmStart = window.api.on('deepLink:confirmStart', ({ appId, appName }) => {
      setSelected(appId);
      void openConfirm({
        title: `Start “${appName}”?`,
        description: 'A devharbor:// link asked to start this app, which runs its tasks (including any custom shell commands).',
        confirmLabel: 'Start app'
      }).then((ok) => {
        if (ok) void invokeOrToast('proc:start', { id: appId }, { context: 'Start failed' });
      });
    });
    // macOS menu actions (Settings ⌘, / Add App ⌘N / Add Folder ⌘⇧N).
    const offMenuSettings = window.api.on('menu:openSettings', () => setSettingsOpen(true));
    const offMenuAddApp = window.api.on('menu:addApp', () => void onAddAppRef.current?.());
    const offMenuNewFolder = window.api.on('menu:newFolder', () =>
      window.dispatchEvent(new CustomEvent('devharbor:new-folder'))
    );
    // Help-menu actions are forwarded here so their result surfaces in the renderer.
    const offMenuCheckUpdates = window.api.on('menu:checkUpdates', () => {
      void window.api.invoke('update:check', undefined);
    });
    const offMenuOpenLogs = window.api.on('menu:openLogs', () => {
      void window.api.invoke('logs:openFolder', undefined);
    });
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
      offMenuCheckUpdates();
      offMenuOpenLogs();
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

  // Open the add-app wizard. Folder browsing + the already-registered check now live
  // inside the wizard's first step.
  const onAddApp = useCallback(async (): Promise<void> => {
    setAddInitialPath(null);
    setAddAutoDetect(true);
    setAddOpen(true);
  }, []);

  onAddAppRef.current = onAddApp;

  // Global Cmd+K (command palette) and Cmd+Shift+F (search all logs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setLogSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selected = apps.find((a) => a.id === selectedId);

  let main: JSX.Element;
  if (!loaded) {
    // apps:list hasn't resolved yet - render a blank pane instead of flashing the
    // first-run welcome screen at every boot/reload for users who DO have apps.
    main = <main className="flex-1" />;
  } else if (apps.length === 0) {
    // Brand-new user: the welcome / teaching screen is the zero-apps experience,
    // regardless of which view is selected.
    main = <EmptyState onAddApp={onAddApp} onImport={() => setImportOpen(true)} />;
  } else if (view === 'dashboard') {
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
        onImportProjects={() => setImportOpen(true)}
      />
      {main}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onAddApp={onAddApp}
        onOpenSettings={() => setSettingsOpen(true)}
        onImportProjects={() => setImportOpen(true)}
        onSearchLogs={() => setLogSearchOpen(true)}
      />
      {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
      {addOpen && (
        <AddAppDrawer
          initialPath={addInitialPath}
          autoDetectInitial={addAutoDetect}
          onCancel={() => setAddOpen(false)}
          onConfirm={(app) => {
            setAddOpen(false);
            upsertApp(app);
            setSelected(app.id as AppId);
          }}
        />
      )}
      {importOpen && (
        <ImportProjectsDrawer
          onClose={() => setImportOpen(false)}
          onImported={(created) => {
            setImportOpen(false);
            for (const app of created) upsertApp(app);
          }}
        />
      )}
      {logSearchOpen && (
        <GlobalLogSearch
          onClose={() => setLogSearchOpen(false)}
          onSelectApp={(id) => {
            setLogSearchOpen(false);
            setSelected(id);
          }}
        />
      )}
      <UpdateBanner />
      <PromptModalHost />
      <ToastHost />
    </div>
  );
}
