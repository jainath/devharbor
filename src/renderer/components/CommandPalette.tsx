import { useEffect, useMemo, useRef, useState } from 'react';
import { Command } from 'cmdk';
import {
  Play,
  Square,
  RotateCw,
  Settings,
  Boxes,
  FolderPlus,
  ArrowRight
} from 'lucide-react';
import type { AppId, TaskId } from '@shared/types';
import { useStore } from '../store/store';
import './CommandPalette.css';

export function CommandPalette({
  open,
  onOpenChange,
  onAddApp,
  onOpenSettings
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAddApp: () => void;
  onOpenSettings: () => void;
}): JSX.Element | null {
  const apps = useStore((s) => s.apps);
  const appState = useStore((s) => s.appState);
  const tasksByApp = useStore((s) => s.tasksByApp);
  const taskState = useStore((s) => s.taskState);
  const setSelected = useStore((s) => s.setSelected);
  const setView = useStore((s) => s.setView);

  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      // Focus deferred a tick so cmdk has mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const running = useMemo(
    () =>
      apps.filter((a) => {
        const s = appState[a.id];
        return s === 'running' || s === 'starting' || s === 'exiting';
      }),
    [apps, appState]
  );

  const runningTasks = useMemo(() => {
    const out: { taskId: TaskId; appId: AppId; appName: string; taskName: string }[] = [];
    for (const app of apps) {
      const tasks = tasksByApp[app.id] ?? [];
      for (const t of tasks) {
        const st = taskState[t.id];
        if (st === 'running' || st === 'starting') {
          out.push({ taskId: t.id, appId: app.id, appName: app.name, taskName: t.name });
        }
      }
    }
    return out;
  }, [apps, tasksByApp, taskState]);

  if (!open) return null;

  const close = (): void => onOpenChange(false);

  const openApp = (id: AppId): void => {
    setSelected(id);
    close();
  };

  const startApp = async (id: AppId): Promise<void> => {
    void window.api.invoke('proc:start', { id });
    close();
  };
  const stopApp = async (id: AppId): Promise<void> => {
    void window.api.invoke('proc:stop', { id });
    close();
  };
  const restartApp = async (id: AppId): Promise<void> => {
    void window.api.invoke('proc:restart', { id });
    close();
  };
  const stopTask = async (id: TaskId): Promise<void> => {
    void window.api.invoke('task:stop', { id });
    close();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh]"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-base shadow-2xl"
      >
        <Command shouldFilter loop label="Global command palette" className="cmdk-root">
          <Command.Input
            ref={inputRef}
            value={query}
            onValueChange={setQuery}
            placeholder="Type a command or app name…"
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
            }}
            className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-fg placeholder:text-fg-subtle outline-none"
          />
          <Command.List className="max-h-[60vh] overflow-y-auto px-1 py-2">
            <Command.Empty className="px-3 py-6 text-center text-xs text-fg-subtle">
              No matches.
            </Command.Empty>

            {apps.length > 0 && (
              <Command.Group heading="Apps" className="cmdk-group">
                {apps.map((a) => (
                  <Command.Item
                    key={a.id}
                    value={`open ${a.name} ${a.path} ${a.tags.join(' ')}`}
                    onSelect={() => openApp(a.id as AppId)}
                    className="cmdk-item"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: a.color }}
                    />
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    {a.tags.length > 0 && (
                      <span className="ml-2 hidden truncate text-[10px] text-accent sm:inline">
                        {a.tags.slice(0, 3).join(' · ')}
                      </span>
                    )}
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-fg-subtle">
                      {appState[a.id] ?? 'idle'}
                    </span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-fg-subtle" />
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {running.length > 0 && (
              <Command.Group heading="Stop / Restart" className="cmdk-group">
                {running.map((a) => (
                  <Command.Item
                    key={`stop-${a.id}`}
                    value={`stop ${a.name}`}
                    onSelect={() => void stopApp(a.id as AppId)}
                    className="cmdk-item"
                  >
                    <Square className="h-3.5 w-3.5 text-danger-strong" />
                    <span className="flex-1">
                      Stop <strong className="text-fg">{a.name}</strong>
                    </span>
                  </Command.Item>
                ))}
                {running.map((a) => (
                  <Command.Item
                    key={`restart-${a.id}`}
                    value={`restart ${a.name}`}
                    onSelect={() => void restartApp(a.id as AppId)}
                    className="cmdk-item"
                  >
                    <RotateCw className="h-3.5 w-3.5 text-warn-strong" />
                    <span className="flex-1">
                      Restart <strong className="text-fg">{a.name}</strong>
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {runningTasks.length > 0 && (
              <Command.Group heading="Running tasks" className="cmdk-group">
                {runningTasks.map((t) => (
                  <Command.Item
                    key={`stop-task-${t.taskId}`}
                    value={`stop task ${t.appName} ${t.taskName}`}
                    onSelect={() => void stopTask(t.taskId)}
                    className="cmdk-item"
                  >
                    <Square className="h-3.5 w-3.5 text-danger-strong" />
                    <span className="flex-1">
                      Stop task <strong className="text-fg">{t.taskName}</strong>{' '}
                      <span className="text-fg-subtle">in {t.appName}</span>
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {apps.filter((a) => (appState[a.id] ?? 'idle') === 'idle').length > 0 && (
              <Command.Group heading="Start" className="cmdk-group">
                {apps
                  .filter((a) => (appState[a.id] ?? 'idle') === 'idle')
                  .map((a) => (
                    <Command.Item
                      key={`start-${a.id}`}
                      value={`start ${a.name}`}
                      onSelect={() => void startApp(a.id as AppId)}
                      className="cmdk-item"
                    >
                      <Play className="h-3.5 w-3.5 text-success-strong" />
                      <span className="flex-1">
                        Start <strong className="text-fg">{a.name}</strong>
                      </span>
                    </Command.Item>
                  ))}
              </Command.Group>
            )}

            <Command.Group heading="Actions" className="cmdk-group">
              <Command.Item
                value="dashboard show running apps overview"
                onSelect={() => {
                  setView('dashboard');
                  close();
                }}
                className="cmdk-item"
              >
                <Boxes className="h-3.5 w-3.5 text-fg-muted" />
                <span className="flex-1">Open Dashboard</span>
              </Command.Item>
              <Command.Item
                value="add app register new project folder"
                onSelect={() => {
                  close();
                  onAddApp();
                }}
                className="cmdk-item"
              >
                <FolderPlus className="h-3.5 w-3.5 text-fg-muted" />
                <span className="flex-1">Add app…</span>
              </Command.Item>
              <Command.Item
                value="settings preferences theme refresh"
                onSelect={() => {
                  close();
                  onOpenSettings();
                }}
                className="cmdk-item"
              >
                <Settings className="h-3.5 w-3.5 text-fg-muted" />
                <span className="flex-1">Open Settings</span>
              </Command.Item>
              {running.length > 0 && (
                <Command.Item
                  value="stop all stop everything"
                  onSelect={() => {
                    for (const a of running) void window.api.invoke('proc:stop', { id: a.id });
                    close();
                  }}
                  className="cmdk-item"
                >
                  <Square className="h-3.5 w-3.5 text-danger-strong" />
                  <span className="flex-1">Stop all running apps</span>
                </Command.Item>
              )}
            </Command.Group>
          </Command.List>
          <div className="border-t border-border px-3 py-1.5 text-[10px] text-fg-subtle">
            <kbd className="rounded bg-elevated px-1">↑↓</kbd> navigate ·{' '}
            <kbd className="rounded bg-elevated px-1">⏎</kbd> run ·{' '}
            <kbd className="rounded bg-elevated px-1">esc</kbd> close
          </div>
        </Command>
      </div>
    </div>
  );
}
