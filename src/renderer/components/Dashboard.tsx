import { memo, useMemo, useState } from 'react';
import { Play, Square, FileText, Filter, ArrowDownUp, ArrowDownAZ, Clock, Check } from 'lucide-react';
import type { App, AppId, ProcessState } from '@shared/types';
import { useStore } from '../store/store';
import { PortChip } from './PortChip';
import { StatusDot } from './StatusDot';
import { useContextMenu, type MenuItem } from './ContextMenu';
import { sortApps, type AppSortMode } from '../lib/sortApps';
import { cn } from '../lib/cn';

export function Dashboard(): JSX.Element {
  const apps = useStore((s) => s.apps);
  const appState = useStore((s) => s.appState);
  const tasksByApp = useStore((s) => s.tasksByApp);
  const taskCpu = useStore((s) => s.taskCpu);
  const taskMemMB = useStore((s) => s.taskMemMB);
  const taskPorts = useStore((s) => s.taskPorts);
  const taskState = useStore((s) => s.taskState);
  const setSelected = useStore((s) => s.setSelected);
  const sortMode = useStore((s) => s.appSort);
  const setAppSort = useStore((s) => s.setAppSort);
  const { open: openMenu, node: menuNode } = useContextMenu();

  const [tagFilter, setTagFilter] = useState<string>('');

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const a of apps) for (const t of a.tags) s.add(t);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [apps]);

  // Sort shared with the Sidebar (store). Default 'name' is stable — cards don't reorder on
  // state changes, so the click target stays put. 'running'/'recent' are explicit opt-ins.
  const sortedApps = useMemo(() => {
    const isRunning = (id: string): boolean => {
      const st = appState[id];
      return st === 'running' || st === 'starting' || st === 'exiting';
    };
    return sortApps(apps, sortMode, isRunning);
  }, [apps, sortMode, appState]);

  const openSortMenu = (e: React.MouseEvent): void => {
    const opts: { mode: AppSortMode; label: string; icon: JSX.Element }[] = [
      { mode: 'name', label: 'Name (A–Z)', icon: <ArrowDownAZ className="h-3.5 w-3.5" /> },
      { mode: 'recent', label: 'Recently used', icon: <Clock className="h-3.5 w-3.5" /> },
      { mode: 'running', label: 'Running first', icon: <Play className="h-3.5 w-3.5" /> }
    ];
    openMenu(
      e,
      opts.map<MenuItem>((o) => ({
        label: o.label,
        icon: sortMode === o.mode ? <Check className="h-3.5 w-3.5 text-accent" /> : o.icon,
        onSelect: () => setAppSort(o.mode)
      }))
    );
  };

  const visibleApps = useMemo(
    () => (tagFilter ? sortedApps.filter((a) => a.tags.includes(tagFilter)) : sortedApps),
    [sortedApps, tagFilter]
  );

  const running = useMemo(
    () =>
      visibleApps.filter((a) => {
        const st = appState[a.id];
        return st === 'running' || st === 'starting' || st === 'exiting';
      }),
    [visibleApps, appState]
  );

  // Machine-wide aggregate across all running tasks — the dashboard's unique value
  // versus the sidebar (which only navigates). "How much is my machine doing right now."
  const aggregate = useMemo(() => {
    let cpu = 0;
    let mem = 0;
    let ports = 0;
    for (const a of visibleApps) {
      for (const t of tasksByApp[a.id] ?? []) {
        const st = taskState[t.id] ?? 'idle';
        if (st === 'running' || st === 'starting') {
          cpu += taskCpu[t.id] ?? 0;
          mem += taskMemMB[t.id] ?? 0;
          ports += (taskPorts[t.id] ?? []).length;
        }
      }
    }
    return { cpu, mem, ports };
  }, [visibleApps, tasksByApp, taskState, taskCpu, taskMemMB, taskPorts]);

  const stopAll = async (): Promise<void> => {
    await Promise.all(running.map((a) => window.api.invoke('proc:stop', { id: a.id })));
  };

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <div className="titlebar-drag h-10 shrink-0" />
      <header className="titlebar-no-drag flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-base font-medium text-fg">Dashboard</h1>
          <p className="mt-0.5 text-xs text-fg-subtle">
            {apps.length === 0
              ? 'No apps registered yet'
              : `${visibleApps.length} app${visibleApps.length === 1 ? '' : 's'}${
                  tagFilter ? ` · tag: ${tagFilter}` : ''
                }`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {allTags.length > 0 && (
            <div className="flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs">
              <Filter className="h-3 w-3 text-fg-subtle" />
              <select
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                className="bg-transparent py-0.5 text-fg outline-none"
              >
                <option value="">All tags</option>
                {allTags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            onClick={openSortMenu}
            title={`Sort apps — ${
              sortMode === 'name'
                ? 'Name (A–Z)'
                : sortMode === 'recent'
                  ? 'Recently used'
                  : 'Running first'
            }`}
            aria-label="Sort apps"
            className={cn(
              'inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-sm hover:bg-elevated',
              sortMode === 'name' ? 'text-fg-muted' : 'text-accent'
            )}
          >
            <ArrowDownUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => void stopAll()}
            disabled={running.length === 0}
            title="Stop every running app"
            className="inline-flex items-center gap-1.5 rounded-md border border-danger-border bg-danger-bg px-2.5 py-1 text-sm text-danger-fg hover:bg-danger-bg-hover disabled:opacity-40"
          >
            <Square className="h-3.5 w-3.5" /> Stop all
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {apps.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
            No apps registered yet.
          </div>
        ) : visibleApps.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
            No apps match tag "{tagFilter}".
          </div>
        ) : (
          <>
            {/* Aggregate stat strip — the dashboard's "control room" identity: a glance
                at total machine load that the (navigation-only) sidebar can't provide. */}
            <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile
                label="Running"
                value={`${running.length} / ${visibleApps.length}`}
                accent={running.length > 0}
              />
              <StatTile label="CPU" value={`${aggregate.cpu.toFixed(1)}%`} />
              <StatTile label="Memory" value={formatMem(aggregate.mem)} />
              <StatTile
                label="Open ports"
                value={aggregate.ports === 0 ? '—' : String(aggregate.ports)}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleApps.map((app) => {
              const tasks = tasksByApp[app.id] ?? [];
              const state = appState[app.id] ?? 'idle';
              const runningTasks = tasks.filter(
                (t) => (taskState[t.id] ?? 'idle') === 'running' || taskState[t.id] === 'starting'
              );
              const totalCpu = runningTasks.reduce((s, t) => s + (taskCpu[t.id] ?? 0), 0);
              const totalMem = runningTasks.reduce((s, t) => s + (taskMemMB[t.id] ?? 0), 0);
              // One entry per **registered** task (not just running) so the card height
              // is invariant across start/stop. Running tasks show their detected port;
              // idle / not-yet-bound tasks show a muted "—" placeholder. Multi-port
              // tasks fan out into separate chips. Stable order: by task name.
              const taskPortEntries: {
                taskId: string;
                taskName: string;
                port: number | null;
                running: boolean;
              }[] = [];
              const orderedTasks = [...tasks]
                .filter((t) => t.enabled)
                .sort((a, b) => a.name.localeCompare(b.name));
              for (const t of orderedTasks) {
                const isRunning =
                  (taskState[t.id] ?? 'idle') === 'running' ||
                  taskState[t.id] === 'starting';
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
                <AppCard
                  key={app.id}
                  app={app}
                  state={state}
                  tasksCount={tasks.length}
                  runningCount={runningTasks.length}
                  cpu={totalCpu}
                  memMB={totalMem}
                  taskPortEntries={taskPortEntries}
                  onOpen={() => setSelected(app.id as AppId)}
                  onStart={() => void window.api.invoke('proc:start', { id: app.id })}
                  onStop={() => void window.api.invoke('proc:stop', { id: app.id })}
                />
              );
            })}
            </div>
          </>
        )}
      </div>
      {menuNode}
    </main>
  );
}

interface AppCardProps {
  app: App;
  state: ProcessState;
  tasksCount: number;
  runningCount: number;
  cpu: number;
  memMB: number;
  taskPortEntries: { taskId: string; taskName: string; port: number | null; running: boolean }[];
  onOpen: () => void;
  onStart: () => void;
  onStop: () => void;
}

function portsKey(entries: AppCardProps['taskPortEntries']): string {
  return entries.map((e) => `${e.taskId}:${e.port ?? ''}:${e.running ? 1 : 0}`).join('|');
}

/**
 * Memoized so idle cards don't re-render on every ~1Hz stats tick (Dashboard re-runs each
 * tick because it subscribes to taskCpu/taskMemMB/taskPorts). The handlers are recreated
 * each render but are intentionally excluded from the comparison — they only close over the
 * stable app.id, so a card re-renders only when its own data actually changes.
 */
const AppCard = memo(
  AppCardImpl,
  (a, b) =>
    a.app === b.app &&
    a.state === b.state &&
    a.tasksCount === b.tasksCount &&
    a.runningCount === b.runningCount &&
    a.cpu === b.cpu &&
    a.memMB === b.memMB &&
    portsKey(a.taskPortEntries) === portsKey(b.taskPortEntries)
);

function AppCardImpl({
  app,
  state,
  tasksCount,
  runningCount,
  cpu,
  memMB,
  taskPortEntries,
  onOpen,
  onStart,
  onStop
}: AppCardProps): JSX.Element {
  const isLive = state === 'running' || state === 'starting' || state === 'exiting';
  return (
    // Card sizes to content. Port chips always render (one per registered task) so cards
    // with the same task count align. Running apps get an inset teal left edge + lifted
    // surface — emphasis in place, NO reorder (keeps click targets put), NO layout shift
    // (inset box-shadow doesn't affect geometry).
    <div
      className={cn(
        'group flex flex-col rounded-md border p-3 transition-colors',
        isLive
          ? 'border-border-strong bg-surface/60 shadow-[inset_2px_0_0_0_rgb(var(--accent))]'
          : 'border-border bg-base/50 hover:border-border-strong'
      )}
    >
      <div className="flex items-center gap-2">
        {/* Single status dot (green+glow when running, muted otherwise) — replaces the
            old color-identity dot + separate status dot. Matches the UI reference. */}
        <StatusDot state={state} />
        <button
          onClick={onOpen}
          className="text-sm font-medium text-fg hover:underline"
        >
          {app.name}
        </button>
        <span
          className={cn(
            'ml-auto font-mono text-[10px] uppercase tracking-wider',
            state === 'running' ? 'text-success-strong' : 'text-fg-subtle'
          )}
        >
          {state}
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-[11px] text-fg-subtle">
        {tasksCount} task{tasksCount === 1 ? '' : 's'}
        {runningCount > 0 ? ` · ${runningCount} running` : ''}
      </div>
      {/* CPU / MEM line + thin teal CPU progress bar (reference's "cpu progress"). */}
      <div className="mt-3 flex items-center gap-4 font-mono text-[11px] text-fg-muted">
        <span>CPU {cpu.toFixed(1)}%</span>
        <span className="text-fg-subtle">{memMB} MB</span>
      </div>
      <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-elevated">
        <span
          className="block h-full rounded-full bg-accent transition-[width] duration-700 ease-out"
          style={{ width: `${Math.min(100, Math.max(0, cpu))}%` }}
        />
      </div>
      {/* Port row: always rendered with reserved height. Empty (no tasks) still occupies
          space so cards with 0 tasks line up with multi-task cards. */}
      <div className="mt-2 flex min-h-[26px] flex-wrap gap-1 content-start">
        {taskPortEntries.slice(0, 6).map((entry) => (
          <PortChip
            key={`${entry.taskId}:${entry.port ?? 'none'}`}
            port={entry.port}
            label={entry.taskName}
            active={entry.running && entry.port != null}
          />
        ))}
        {taskPortEntries.length > 6 && (
          <span className="text-[11px] text-fg-subtle">+{taskPortEntries.length - 6}</span>
        )}
      </div>
      <div className="mt-3 flex items-center gap-1">
        {!isLive ? (
          <button
            onClick={onStart}
            title="Start all tasks in this app"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] text-fg hover:bg-elevated"
          >
            <Play className="h-3 w-3" /> Start
          </button>
        ) : (
          <button
            onClick={onStop}
            title="Stop all running tasks in this app"
            className="inline-flex items-center gap-1 rounded-md border border-danger-border bg-danger-bg px-2 py-0.5 text-[11px] text-danger-fg hover:bg-danger-bg-hover"
          >
            <Square className="h-3 w-3" /> Stop
          </button>
        )}
        <button
          onClick={onOpen}
          title="Open this app's detail & logs"
          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface hover:text-fg"
        >
          <FileText className="h-3 w-3" /> Logs
        </button>
      </div>
    </div>
  );
}

/** One aggregate stat tile in the dashboard's top strip. */
function StatTile({
  label,
  value,
  accent = false
}: {
  label: string;
  value: string;
  accent?: boolean;
}): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-surface/40 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">{label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-lg font-medium tabular-nums',
          accent ? 'text-accent' : 'text-fg'
        )}
      >
        {value}
      </div>
    </div>
  );
}

function formatMem(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}
