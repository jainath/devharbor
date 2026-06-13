import { useEffect, useRef, useState } from 'react';
import { Play, Square, RotateCw, Trash2, KeyRound, RefreshCw, Cog, Copy, Download, ClipboardCopy, Check } from 'lucide-react';
import type { App, DetectionResult, Task, TaskId } from '@shared/types';
import { useStore } from '../store/store';
import { StatusDot } from './StatusDot';
import { LogTerminal, type LogTerminalRef } from './LogTerminal';
import { TaskTabs } from './TaskTabs';
import { TaskEditor } from './TaskEditor';
import { ErrorBanner } from './ErrorBanner';
import { CrashPin } from './CrashPin';
import { EnvEditor } from './EnvEditor';
import { openConfirm } from './PromptModal';
import { PortChip } from './PortChip';
import { AppConfigDrawer } from './AppConfigDrawer';
import { LogSearchView } from './LogSearchView';
import { OpenInMenu } from './OpenInMenu';
import { cn } from '../lib/cn';
import { isLive as isLiveState, isActive, basename } from '../lib/processState';
import { invokeOrToast } from '../lib/invoke';

const EMPTY_TASKS: Task[] = [];

export function AppDetail({ app }: { app: App }): JSX.Element {
  const tasks = useStore((s) => s.tasksByApp[app.id] ?? EMPTY_TASKS);
  const selectedTaskId = useStore((s) => s.selectedTaskByApp[app.id] ?? null);
  const setTasksForApp = useStore((s) => s.setTasksForApp);
  const removeApp = useStore((s) => s.removeApp);
  const running = useStore((s) => s.running[app.id]);
  const appState = useStore((s) => s.appState[app.id]);
  const taskState = useStore((s) => s.taskState);
  const taskExitCode = useStore((s) => s.taskExitCode);
  const taskPorts = useStore((s) => s.taskPorts);
  const envFileChanges = useStore((s) => s.envFileChanges[app.id]);
  const dismissEnvFileChanges = useStore((s) => s.dismissEnvFileChanges);

  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [busy, setBusy] = useState<'start' | 'stop' | 'restart' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uptime, setUptime] = useState<string>('');
  const [editorOpen, setEditorOpen] = useState(false);
  // Logs has two modes: live xterm or virtualized regex filter over the same buffer.
  const [logsMode, setLogsMode] = useState<'live' | 'filter'>('live');
  const [clearToken, setClearToken] = useState(0);
  const [envOpen, setEnvOpen] = useState(false);
  // When Env editor is opened from the task strip's right-click "Edit task env…",
  // we want the editor to land on the Task tab for that task.
  const [envInitial, setEnvInitial] = useState<{ taskId: TaskId | null } | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const termRef = useRef<LogTerminalRef | null>(null);

  const copyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(app.path);
      setPathCopied(true);
      window.setTimeout(() => setPathCopied(false), 1200);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    setDetection(null);
    setError(null);
    void window.api.invoke('apps:detect', { path: app.path }).then(setDetection);
  }, [app.id, app.path]);

  useEffect(() => {
    void window.api.invoke('tasks:list', { appId: app.id }).then((list) => setTasksForApp(app.id, list));
  }, [app.id, setTasksForApp]);

  useEffect(() => {
    if (!running) {
      setUptime('');
      return;
    }
    const tick = (): void => setUptime(formatUptime(Date.now() - running.startedAt));
    tick();
    const handle = window.setInterval(tick, 1000);
    return () => window.clearInterval(handle);
  }, [running]);

  const state = appState ?? 'idle';
  const isLive = isLiveState(state);

  const start = async (): Promise<void> => {
    setBusy('start');
    setError(null);
    try {
      await window.api.invoke('proc:start', { id: app.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const stop = async (): Promise<void> => {
    setBusy('stop');
    setError(null);
    try {
      await window.api.invoke('proc:stop', { id: app.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const restart = async (): Promise<void> => {
    setBusy('restart');
    setError(null);
    try {
      await window.api.invoke('proc:restart', { id: app.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async (): Promise<void> => {
    // If currently running: confirm a stop-then-remove flow in one click. Avoids the
    // old dead-end "stop the app before removing" error message.
    const ok = await openConfirm({
      title: `Remove "${app.name}" from DevHarbor?`,
      description: isLive
        ? 'This app is currently running. Its tasks will be stopped first, then it will be removed. Files on disk are not deleted.'
        : 'This only removes it from DevHarbor. Files on disk are not deleted.',
      confirmLabel: isLive ? 'Stop & remove' : 'Remove',
      danger: true
    });
    if (!ok) return;
    try {
      if (isLive) {
        await window.api.invoke('proc:stop', { id: app.id });
      }
      await window.api.invoke('apps:remove', { id: app.id });
      removeApp(app.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Cmd+Enter starts the app when not running (spec'd in F5).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isLive && !busy) {
        // Don't intercept when typing in inputs.
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        void start();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, busy, app.id]);

  const activeTaskId: TaskId | null =
    selectedTaskId ?? tasks[0]?.id ?? null;

  const onClear = async (): Promise<void> => {
    if (!activeTaskId) return;
    try {
      await window.api.invoke('task:clearBuffer', { id: activeTaskId });
      // Forces LogTerminal to remount with an empty replay.
      setClearToken((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const restartActiveTask = async (): Promise<void> => {
    if (!activeTaskId) return;
    try {
      const rt = await window.api.invoke('task:start', { id: activeTaskId });
      useStore.setState((s) => ({
        runningTasks: { ...s.runningTasks, [rt.taskId]: rt },
        taskState: { ...s.taskState, [rt.taskId]: rt.state }
      }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const activeTask = activeTaskId ? tasks.find((t) => t.id === activeTaskId) : null;
  const activeTaskCrashed = activeTaskId && taskState[activeTaskId] === 'crashed';

  // One entry per **registered** task (not just running) so the header height
  // is invariant across start/stop. Running tasks show their detected port;
  // idle tasks show a muted "-" placeholder. Multi-port tasks fan out.
  const taskPortEntries: {
    taskId: string;
    taskName: string;
    port: number | null;
    running: boolean;
  }[] = [];
  const orderedTasksForPorts = [...tasks]
    .filter((t) => t.enabled)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const t of orderedTasksForPorts) {
    const isRunning = isActive(taskState[t.id]);
    const ports = isRunning ? taskPorts[t.id] ?? [] : [];
    if (ports.length === 0) {
      taskPortEntries.push({
        taskId: t.id,
        taskName: t.name,
        port: null,
        running: isRunning
      });
    } else {
      for (const p of [...ports].sort((a, b) => a - b)) {
        taskPortEntries.push({
          taskId: t.id,
          taskName: t.name,
          port: p,
          running: isRunning
        });
      }
    }
  }

  return (
    <main className="flex flex-1 flex-col">
      <div className="titlebar-drag h-10 shrink-0" />
      <header className="titlebar-no-drag border-b border-border px-6 py-3">
        <div className="flex items-center gap-2.5">
          {/* Single status dot - green+glow when running, muted otherwise (was
              color-identity dot + separate status dot). */}
          <StatusDot state={state} />
          <h1 className="min-w-0 flex-1 truncate text-base font-medium text-fg" title={app.name}>
            {app.name}
          </h1>
          <span className="shrink-0 text-xs text-fg-subtle">
            {labelForState(state)}
            {uptime ? ` · ${uptime}` : ''}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* Script picker dropdown removed Phase 7 round 2 - single-task and multi-task
                apps now share the exact same header. Editing a task's script lives in
                the task tab right-click → Edit (consistent across task counts). */}
            {/* Secondary utilities - uniform icon-only buttons with tooltips. */}
            <OpenInMenu path={app.path} />
            <IconButton
              onClick={() => {
                setEnvInitial(null);
                setEnvOpen(true);
              }}
              title="Environment variables"
              aria-label="Environment variables"
            >
              <KeyRound className="h-4 w-4" />
            </IconButton>
            {/* "Tasks" header button removed Phase 7 - the always-on task strip below
                carries a "Manage tasks" button, which avoids two doors to the same UI. */}
            <IconButton onClick={() => setConfigOpen(true)} title="App settings" aria-label="App settings">
              <Cog className="h-4 w-4" />
            </IconButton>

            <Divider />

            {/* Primary lifecycle - the one filled button (or Restart + Stop when running).
                Shared min-w so the labels don't change the button size between states. */}
            {!isLive ? (
              <Button
                onClick={start}
                disabled={busy != null}
                variant="primary"
                title="Start all tasks in this app (⌘ ↩)"
                className="min-w-[104px] justify-center"
              >
                <Play className="h-3.5 w-3.5" /> Start app
              </Button>
            ) : (
              <>
                <Button
                  onClick={restart}
                  disabled={busy != null}
                  title="Stop, then start this app again"
                  className="min-w-[104px] justify-center"
                >
                  <RotateCw className="h-3.5 w-3.5" /> Restart app
                </Button>
                <Button
                  onClick={stop}
                  disabled={busy != null}
                  variant="danger"
                  title="Stop all running tasks in this app"
                  className="min-w-[104px] justify-center"
                >
                  <Square className="h-3.5 w-3.5" /> Stop app
                </Button>
              </>
            )}

            <Divider />

            {/* Destructive - isolated after a divider; red on hover. */}
            <IconButton
              onClick={onRemove}
              disabled={busy != null}
              title="Remove from DevHarbor"
              aria-label="Remove from DevHarbor"
              danger
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 font-mono text-xs text-fg-subtle">
          <span className="truncate">{app.path}</span>
          <button
            onClick={() => void copyPath()}
            className="inline-flex shrink-0 items-center rounded p-0.5 text-fg-subtle hover:bg-surface hover:text-fg"
            title={pathCopied ? 'Copied' : 'Copy path'}
            aria-label="Copy app path to clipboard"
          >
            {pathCopied ? (
              <Check className="h-3 w-3 text-success-fg" />
            ) : (
              <ClipboardCopy className="h-3 w-3" />
            )}
          </button>
          {detection?.packageManager && (
            <span className="shrink-0">· {detection.packageManager}</span>
          )}
          {detection?.nodeVersionFromProject && (
            <span className="shrink-0">· node {detection.nodeVersionFromProject}</span>
          )}
        </div>
        {/* Port row: always rendered with reserved height so the header doesn't
            reflow when an app starts/stops. Idle tasks render a muted "-" chip. */}
        <div className="mt-2 flex min-h-[26px] flex-wrap items-center gap-1.5">
          {taskPortEntries.map((entry) => (
            <PortChip
              key={`${entry.taskId}:${entry.port ?? 'none'}`}
              port={entry.port}
              label={entry.taskName}
              active={entry.running && entry.port != null}
            />
          ))}
          {taskPortEntries.length === 0 && tasks.length === 0 && (
            <span className="text-[11px] text-fg-subtle">No tasks yet. Add one from the strip below.</span>
          )}
        </div>
        {envFileChanges && envFileChanges.length > 0 && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-warn-border bg-warn-bg px-3 py-1.5 text-xs text-warn-fg">
            <RefreshCw className="h-3 w-3" />
            <span className="flex-1 truncate">
              {envFileChanges.length === 1
                ? `${basename(envFileChanges[0]!.path)} changed on disk.`
                : `${envFileChanges.length} env files changed on disk.`}{' '}
              Restart to apply.
            </span>
            <Button
              onClick={() => {
                // Fire-and-forget: route through invokeOrToast so a restart failure
                // surfaces as a toast instead of a silent unhandled rejection.
                void invokeOrToast('proc:restart', { id: app.id }, { context: 'Restart failed' });
                dismissEnvFileChanges(app.id);
              }}
              title="Restart the app to load the changed env files"
            >
              <RotateCw className="h-3 w-3" /> Restart
            </Button>
            <button
              onClick={() => dismissEnvFileChanges(app.id)}
              className="rounded p-0.5 text-warn-fg/70 hover:bg-warn-bg-hover hover:text-warn-strong"
              title="Dismiss this notice"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {error && (
          <ErrorBanner message={error} onDismiss={() => setError(null)} className="mt-2" />
        )}
      </header>

      {/* Always-on task strip (Phase 7). Single-task apps see one tab + Manage button - 
          gives single-task apps the same right-click affordances as multi-task. Zero-task
          apps get a minimal placeholder strip with an "Add task" entry point so the user
          isn't stranded. */}
      {tasks.length > 0 ? (
        <TaskTabs
          appId={app.id}
          tasks={tasks}
          onManage={() => setEditorOpen(true)}
          onEditTaskEnv={(taskId) => {
            setEnvInitial({ taskId });
            setEnvOpen(true);
          }}
        />
      ) : (
        <div className="flex items-center justify-between border-b border-surface bg-base px-3 py-1.5">
          <span className="text-[11px] text-fg-subtle">No tasks yet for this app.</span>
          <button
            onClick={() => setEditorOpen(true)}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-fg-muted hover:bg-surface hover:text-fg"
          >
            Add task
          </button>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden bg-base">
        <div className="flex items-center justify-between border-b border-surface px-4 py-1.5">
          <div className="flex items-center gap-3">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                Logs
              </span>
              {activeTask && (
                <span className="text-[11px] text-fg-subtle">· {activeTask.name}</span>
              )}
            </div>
            {activeTaskId && (
              <div className="inline-flex rounded-md border border-border bg-surface p-0.5 text-[11px]">
                <ModePill active={logsMode === 'live'} onClick={() => setLogsMode('live')}>
                  Live
                </ModePill>
                <ModePill active={logsMode === 'filter'} onClick={() => setLogsMode('filter')}>
                  Filter
                </ModePill>
              </div>
            )}
          </div>
          {activeTaskId && logsMode === 'live' && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => void termRef.current?.copyAll()}
                className="inline-flex items-center gap-1 text-[11px] text-fg-subtle hover:text-fg"
                title="Copy all logs to clipboard"
              >
                <Copy className="h-3 w-3" /> Copy
              </button>
              <button
                onClick={() => void termRef.current?.saveToFile()}
                className="inline-flex items-center gap-1 text-[11px] text-fg-subtle hover:text-fg"
                title="Save logs to file"
              >
                <Download className="h-3 w-3" /> Save
              </button>
              <button
                onClick={() => void onClear()}
                className="text-[11px] text-fg-subtle hover:text-fg"
              >
                Clear
              </button>
            </div>
          )}
        </div>
        {logsMode === 'live' && activeTaskCrashed && activeTask && (
          <CrashPin
            taskId={activeTask.id}
            taskName={activeTask.name}
            exitCode={taskExitCode[activeTask.id] ?? null}
            onRestart={() => void restartActiveTask()}
          />
        )}
        <div className="flex-1 overflow-hidden p-2">
          {!activeTaskId ? (
            <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
              No tasks yet. Use "Add task" in the strip above.
            </div>
          ) : logsMode === 'filter' ? (
            <LogSearchView taskId={activeTaskId} />
          ) : (
            <LogTerminal
              ref={termRef}
              key={`${activeTaskId}-${clearToken}`}
              taskId={activeTaskId}
            />
          )}
        </div>
      </div>

      {editorOpen && (
        <TaskEditor appId={app.id} appPath={app.path} onClose={() => setEditorOpen(false)} />
      )}
      {envOpen && (
        <EnvEditor
          appId={app.id}
          appName={app.name}
          tasks={tasks}
          initialTaskId={envInitial?.taskId ?? null}
          onClose={() => {
            setEnvOpen(false);
            setEnvInitial(null);
          }}
        />
      )}
      {configOpen && <AppConfigDrawer app={app} onClose={() => setConfigOpen(false)} />}
    </main>
  );
}

function ModePill({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded px-2 py-0.5 transition-colors',
        active ? 'bg-elevated text-fg' : 'text-fg-muted hover:text-fg'
      )}
    >
      {children}
    </button>
  );
}

/**
 * Uniform square icon-only button for the header's secondary utilities (Open in, Env,
 * Settings) and the isolated destructive Delete. Fixed 32px box keeps them aligned and
 * consistent; `danger` swaps the hover to red.
 */
function IconButton({
  children,
  danger = false,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors disabled:pointer-events-none disabled:opacity-50',
        danger ? 'hover:bg-danger-bg hover:text-danger-fg' : 'hover:bg-surface hover:text-fg',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Thin vertical separator between header action groups. */
function Divider(): JSX.Element {
  return <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />;
}

function Button({
  children,
  variant = 'default',
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
}): JSX.Element {
  const base =
    'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors disabled:opacity-50 disabled:pointer-events-none';
  const styles =
    variant === 'primary'
      ? 'bg-accent text-accent-fg hover:bg-accent/90'
      : variant === 'danger'
      ? 'border border-danger-border bg-danger-bg text-danger-fg hover:bg-danger-bg-hover'
      : variant === 'ghost'
      ? 'text-fg-muted hover:bg-surface hover:text-fg'
      : 'border border-border bg-surface text-fg hover:bg-elevated';
  return (
    <button className={cn(base, styles, className)} {...rest}>
      {children}
    </button>
  );
}

function labelForState(state: string): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
