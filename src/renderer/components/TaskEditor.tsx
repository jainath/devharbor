import { useEffect, useMemo, useRef, useState } from 'react';
import { GripVertical, Plus, Trash2, X } from 'lucide-react';
import { NodeVersionPicker } from './NodeVersionPicker';
import type {
  AppId,
  CommandKind,
  DetectionResult,
  ReadinessSignal,
  Task,
  TaskId
} from '@shared/types';
import { useStore } from '../store/store';
import { cn } from '../lib/cn';
import { useDebouncedSave } from '../lib/useDebouncedSave';
import { ErrorBanner } from './ErrorBanner';

const EMPTY_TASKS: Task[] = [];

export function TaskEditor({
  appId,
  appPath,
  onClose
}: {
  appId: AppId;
  appPath: string;
  onClose: () => void;
}): JSX.Element {
  const tasks = useStore((s) => s.tasksByApp[appId] ?? EMPTY_TASKS);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const [editingId, setEditingId] = useState<TaskId | null>(tasks[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const dragIdRef = useRef<TaskId | null>(null);
  const [dragOverId, setDragOverId] = useState<TaskId | null>(null);

  useEffect(() => {
    void window.api.invoke('apps:detect', { path: appPath }).then(setDetection);
  }, [appPath]);

  const editing = tasks.find((t) => t.id === editingId) ?? null;

  const addTask = async (): Promise<void> => {
    setError(null);
    try {
      const t = await window.api.invoke('tasks:add', {
        appId,
        patch: {
          name: `task-${tasks.length + 1}`,
          commandKind: 'script' as CommandKind,
          script: detection?.suggestedDefaultScript ?? null
        }
      });
      upsertTask(t);
      setEditingId(t.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Debounced save: typing in a text field coalesces into one IPC round-trip per pause.
  // The local store updates optimistically below so inputs feel instant.
  const { queue: queueSave, flush: flushSave } = useDebouncedSave<{
    id: TaskId;
    patch: Partial<Task>;
  }>(async ({ id, patch }) => {
    setError(null);
    try {
      const t = await window.api.invoke('tasks:update', { id, patch });
      upsertTask(t);
    } catch (e) {
      setError((e as Error).message);
    }
  }, 300);

  // If the user switches the edited task before pending changes flush, save them first.
  useEffect(() => {
    return () => flushSave();
  }, [editingId, flushSave]);

  const applyPatch = (patch: Partial<Task>): void => {
    if (!editing) return;
    // Optimistic local update — input echoes immediately.
    upsertTask({ ...editing, ...patch, updatedAt: Date.now() } as Task);
    queueSave({ id: editing.id, patch });
  };

  const onRemove = async (id: TaskId): Promise<void> => {
    setError(null);
    flushSave();
    try {
      await window.api.invoke('tasks:remove', { id });
      removeTask(id);
      if (editingId === id) setEditingId(tasks.find((t) => t.id !== id)?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
      <div className="flex h-full max-h-[680px] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-base shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-medium text-fg">Tasks</h2>
            <p className="mt-0.5 text-[11px] text-fg-subtle">
              Define what this app runs. Multiple tasks start in dependency order.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-fg-subtle hover:bg-surface hover:text-fg"
            title="Close task editor"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {error && (
          <ErrorBanner
            message={error}
            onDismiss={() => setError(null)}
            className="m-3 rounded-md"
          />
        )}
        <div className="flex flex-1 overflow-hidden">
          {/* Task list */}
          <div className="flex w-60 shrink-0 flex-col border-r border-border">
            <div className="flex-1 overflow-y-auto py-1">
              {tasks.length === 0 ? (
                <div className="px-3 py-2 text-xs text-fg-subtle">No tasks yet</div>
              ) : (
                tasks.map((t) => (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={(e) => {
                      dragIdRef.current = t.id;
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragIdRef.current && dragIdRef.current !== t.id) {
                        setDragOverId(t.id);
                      }
                    }}
                    onDragLeave={() => {
                      if (dragOverId === t.id) setDragOverId(null);
                    }}
                    onDrop={async (e) => {
                      e.preventDefault();
                      const draggedId = dragIdRef.current;
                      dragIdRef.current = null;
                      setDragOverId(null);
                      if (!draggedId || draggedId === t.id) return;
                      const ordered = tasks.map((x) => x.id);
                      const from = ordered.indexOf(draggedId);
                      const to = ordered.indexOf(t.id);
                      if (from < 0 || to < 0) return;
                      const [removed] = ordered.splice(from, 1);
                      if (removed) ordered.splice(to, 0, removed);
                      try {
                        await window.api.invoke('tasks:reorder', { appId, taskIds: ordered });
                        // Refresh local store from main side.
                        const list = await window.api.invoke('tasks:list', { appId });
                        for (const x of list) upsertTask(x);
                      } catch (err) {
                        setError((err as Error).message);
                      }
                    }}
                    onDragEnd={() => {
                      dragIdRef.current = null;
                      setDragOverId(null);
                    }}
                    className={cn(
                      'group flex w-full items-center gap-1.5 px-2 py-1.5 text-xs',
                      editingId === t.id
                        ? 'bg-surface text-fg'
                        : 'text-fg-muted hover:bg-surface/60',
                      dragOverId === t.id && 'border-t-2 border-accent'
                    )}
                  >
                    <GripVertical className="h-3 w-3 cursor-grab text-fg-subtle group-hover:text-fg-muted" />
                    <button
                      onClick={() => setEditingId(t.id)}
                      className="flex flex-1 items-center gap-2 text-left"
                    >
                      <span className="font-medium">{t.name}</span>
                      <span className="ml-auto text-[10px] text-fg-subtle">
                        {readinessLabel(t.readiness)}
                      </span>
                    </button>
                  </div>
                ))
              )}
            </div>
            <button
              onClick={() => void addTask()}
              className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-left text-xs text-fg-muted hover:bg-surface"
            >
              <Plus className="h-3 w-3" /> Add task
            </button>
          </div>

          {/* Editor */}
          <div className="flex-1 overflow-y-auto p-4">
            {editing ? (
              <TaskForm
                task={editing}
                siblings={tasks.filter((t) => t.id !== editing.id)}
                detection={detection}
                onChange={applyPatch}
                onRemove={() => void onRemove(editing.id)}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
                Add a task to get started.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskForm({
  task,
  siblings,
  detection,
  onChange,
  onRemove
}: {
  task: Task;
  siblings: Task[];
  detection: DetectionResult | null;
  onChange: (patch: Partial<Task>) => void;
  onRemove: () => void;
}): JSX.Element {
  const scriptChoices = useMemo(() => Object.keys(detection?.scripts ?? {}), [detection]);
  const isOneShot = task.oneShot;

  const setReadinessKind = (kind: ReadinessSignal['kind']): void => {
    let next: ReadinessSignal;
    switch (kind) {
      case 'none':
        next = { kind: 'none' };
        break;
      case 'port':
        next = { kind: 'port', port: 3000 };
        break;
      case 'log':
        next = { kind: 'log', regex: 'ready' };
        break;
      case 'exit':
        next = { kind: 'exit', code: 0 };
        break;
      case 'delay':
        next = { kind: 'delay', ms: 1000 };
        break;
    }
    void onChange({ readiness: next });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <input
            value={task.name}
            onChange={(e) => void onChange({ name: e.target.value })}
            className="w-full rounded-md bg-transparent text-base font-medium text-fg outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="mt-1 text-[11px] text-fg-subtle">
            position {task.position} · id {task.id.slice(0, 8)}…
          </div>
        </div>
        <button
          onClick={onRemove}
          className="rounded-md p-1.5 text-fg-subtle hover:bg-danger-bg hover:text-danger-fg"
          title="Remove task"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <Field label="Command">
        <div className="space-y-2">
          <div className="flex gap-2">
            <RadioPill
              checked={task.commandKind === 'script'}
              onClick={() => void onChange({ commandKind: 'script', customCommand: null })}
              label="package.json script"
            />
            <RadioPill
              checked={task.commandKind === 'custom'}
              onClick={() => void onChange({ commandKind: 'custom', script: null })}
              label="Custom shell line"
            />
          </div>
          {task.commandKind === 'script' ? (
            <select
              value={task.script ?? ''}
              onChange={(e) => void onChange({ script: e.target.value || null })}
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
            >
              <option value="">— select —</option>
              {scriptChoices.map((s) => (
                <option key={s} value={s}>
                  {s} {detection?.scripts[s] ? `(${detection.scripts[s]})` : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={task.customCommand ?? ''}
              onChange={(e) => void onChange({ customCommand: e.target.value || null })}
              placeholder="e.g. pnpm -F api db:migrate"
              className="w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-fg"
            />
          )}
        </div>
      </Field>

      <Field label="Working directory (relative to app path)">
        <input
          value={task.workingDirOverride ?? ''}
          onChange={(e) => void onChange({ workingDirOverride: e.target.value || null })}
          placeholder="leave empty to use the app's path"
          className="w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-fg"
        />
      </Field>

      <Field label="Depends on (tasks that must be ready first)">
        <div className="flex flex-wrap gap-2">
          {siblings.length === 0 ? (
            <span className="text-[11px] text-fg-subtle">No other tasks to depend on.</span>
          ) : (
            siblings.map((s) => {
              const checked = task.dependsOn.includes(s.id);
              return (
                <label
                  key={s.id}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px]',
                    checked
                      ? 'border-accent/60 bg-accent/10 text-fg'
                      : 'border-border text-fg-muted hover:bg-surface'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...task.dependsOn, s.id]
                        : task.dependsOn.filter((d) => d !== s.id);
                      void onChange({ dependsOn: next });
                    }}
                    className="h-3 w-3"
                  />
                  {s.name}
                </label>
              );
            })
          )}
        </div>
      </Field>

      <Field label="Readiness signal">
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {(['none', 'port', 'log', 'exit', 'delay'] as const).map((k) => (
              <RadioPill
                key={k}
                checked={task.readiness.kind === k}
                onClick={() => setReadinessKind(k)}
                label={k}
              />
            ))}
          </div>
          {task.readiness.kind === 'port' && (
            <input
              type="number"
              value={task.readiness.port}
              onChange={(e) =>
                void onChange({
                  readiness: { kind: 'port', port: Number(e.target.value) || 0 }
                })
              }
              className="w-32 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
            />
          )}
          {task.readiness.kind === 'log' && (
            <input
              value={task.readiness.regex}
              onChange={(e) =>
                void onChange({
                  readiness: { kind: 'log', regex: e.target.value, flags: task.readiness.kind === 'log' ? task.readiness.flags : 'i' }
                })
              }
              placeholder="ready"
              className="w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-fg"
            />
          )}
          {task.readiness.kind === 'exit' && (
            <input
              type="number"
              value={task.readiness.code ?? 0}
              onChange={(e) =>
                void onChange({ readiness: { kind: 'exit', code: Number(e.target.value) } })
              }
              className="w-32 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
            />
          )}
          {task.readiness.kind === 'delay' && (
            <input
              type="number"
              value={task.readiness.ms}
              onChange={(e) =>
                void onChange({ readiness: { kind: 'delay', ms: Number(e.target.value) || 0 } })
              }
              className="w-32 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
            />
          )}
        </div>
      </Field>

      <Field label="One-shot (task is expected to exit)">
        <label className="inline-flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={isOneShot}
            onChange={(e) => {
              const oneShot = e.target.checked;
              const readiness: ReadinessSignal = oneShot
                ? { kind: 'exit', code: 0 }
                : task.readiness.kind === 'exit'
                ? { kind: 'none' }
                : task.readiness;
              void onChange({ oneShot, readiness });
            }}
            className="h-3.5 w-3.5"
          />
          {isOneShot ? 'Yes' : 'No'}
        </label>
      </Field>

      <Field label="Node version">
        <div className="space-y-1">
          <NodeVersionPicker
            value={task.nodeVersionPrefOverride}
            onChange={(v) => void onChange({ nodeVersionPrefOverride: v })}
            includeInherit
          />
          <div className="text-[10px] text-fg-subtle">
            Overrides the app's default. Inherit = use whatever the app is set to.
          </div>
        </div>
      </Field>

      <Field label="Enabled">
        <label className="inline-flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={task.enabled}
            onChange={(e) => void onChange({ enabled: e.target.checked })}
            className="h-3.5 w-3.5"
          />
          {task.enabled ? 'Active in app start' : 'Skipped at app start'}
        </label>
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wider text-fg-subtle">{label}</div>
      {children}
    </div>
  );
}

function RadioPill({
  checked,
  onClick,
  label
}: {
  checked: boolean;
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-md border px-2 py-0.5 text-[11px]',
        checked
          ? 'border-accent/60 bg-accent/10 text-fg'
          : 'border-border text-fg-muted hover:bg-surface'
      )}
    >
      {label}
    </button>
  );
}

function readinessLabel(r: ReadinessSignal): string {
  switch (r.kind) {
    case 'none':
      return '—';
    case 'port':
      return `:${r.port}`;
    case 'log':
      return 'log';
    case 'exit':
      return r.code === undefined || r.code === 0 ? '✓' : `exit ${r.code}`;
    case 'delay':
      return `${Math.round(r.ms / 100) / 10}s`;
  }
}
