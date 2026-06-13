import {
  Play,
  Square,
  RotateCw,
  EyeOff,
  Eye,
  Edit3,
  KeyRound,
  Trash2,
  MoreVertical
} from 'lucide-react';
import type { AppId, ProcessState, ReadinessSignal, Task, TaskId } from '@shared/types';
import { useStore } from '../store/store';
import { cn } from '../lib/cn';
import { isLive } from '../lib/processState';
import { invokeOrToast } from '../lib/invoke';
import { useContextMenu, type MenuItem } from './ContextMenu';
import { openConfirm } from './PromptModal';

/**
 * Start a task and reflect the running record in the store, surfacing any rejection as a toast.
 * Shared by the tab strip's start button and the context menu's Start/Restart so all three
 * routes report failures identically (5.5) and the store is only updated on success.
 */
async function startTask(id: TaskId, context = 'Start failed'): Promise<void> {
  const rt = await invokeOrToast('task:start', { id }, { context });
  if (!rt) return;
  useStore.setState((s) => ({
    runningTasks: { ...s.runningTasks, [rt.taskId]: rt },
    taskState: { ...s.taskState, [rt.taskId]: rt.state }
  }));
}

export function TaskTabs({
  appId,
  tasks,
  onManage,
  onEditTaskEnv
}: {
  appId: AppId;
  tasks: Task[];
  onManage: () => void;
  /** Called with a taskId when the right-click menu's "Edit task env…" is chosen. */
  onEditTaskEnv?: (taskId: TaskId) => void;
}): JSX.Element {
  const selected = useStore((s) => s.selectedTaskByApp[appId]);
  const selectTaskTab = useStore((s) => s.selectTaskTab);
  const taskState = useStore((s) => s.taskState);
  const taskReady = useStore((s) => s.taskReady);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTaskInStore = useStore((s) => s.removeTask);
  const { open: openMenu, node: menuNode } = useContextMenu();

  const buildItems = (task: Task): MenuItem[] => {
    const live = isLive(taskState[task.id]);
    return [
      {
        label: live ? 'Stop this task' : 'Start this task',
        icon: live ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />,
        onSelect: async () => {
          if (live) await invokeOrToast('task:stop', { id: task.id }, { context: 'Stop failed' });
          else await startTask(task.id);
        }
      },
      {
        label: 'Restart this task',
        icon: <RotateCw className="h-3.5 w-3.5" />,
        disabled: !live,
        onSelect: async () => {
          const stopped = await invokeOrToast(
            'task:stop',
            { id: task.id },
            { context: 'Restart failed' }
          );
          // Only proceed to the start half once the stop actually resolved, so a failed stop
          // doesn't silently spawn a duplicate process via the timer.
          if (stopped === null) return;
          setTimeout(() => {
            void startTask(task.id, 'Restart failed');
          }, 150);
        }
      },
      {
        label: task.enabled ? 'Disable' : 'Enable',
        icon: task.enabled ? (
          <EyeOff className="h-3.5 w-3.5" />
        ) : (
          <Eye className="h-3.5 w-3.5" />
        ),
        separatorBefore: true,
        disabled: live,
        onSelect: async () => {
          const next = await window.api.invoke('tasks:update', {
            id: task.id,
            patch: { enabled: !task.enabled }
          });
          upsertTask(next);
        }
      },
      {
        label: 'Edit…',
        icon: <Edit3 className="h-3.5 w-3.5" />,
        onSelect: () => onManage()
      },
      ...(onEditTaskEnv
        ? [
            {
              label: 'Edit task env…',
              icon: <KeyRound className="h-3.5 w-3.5" />,
              onSelect: () => onEditTaskEnv(task.id)
            }
          ]
        : []),
      {
        label: 'Remove task…',
        icon: <Trash2 className="h-3.5 w-3.5" />,
        danger: true,
        separatorBefore: true,
        disabled: live,
        onSelect: async () => {
          const ok = await openConfirm({
            title: `Remove task "${task.name}"?`,
            description: 'This removes the task from the app. The project files are not affected.',
            confirmLabel: 'Remove task',
            danger: true
          });
          if (!ok) return;
          try {
            await window.api.invoke('tasks:remove', { id: task.id });
            removeTaskInStore(task.id);
          } catch (e) {
            console.error('remove failed', e);
          }
        }
      }
    ];
  };

  return (
    <div className="flex items-center gap-1 border-b border-surface bg-base px-3 py-1.5">
      <div className="flex flex-1 items-center gap-1 overflow-x-auto">
        {tasks.map((t) => (
          <TaskTab
            key={t.id}
            task={t}
            active={selected === t.id}
            state={taskState[t.id]}
            ready={!!taskReady[t.id]}
            onClick={() => selectTaskTab(appId, t.id)}
            onOpenMenu={(e) => openMenu(e, buildItems(t))}
          />
        ))}
      </div>
      <button
        onClick={onManage}
        className="rounded-md border border-border px-2 py-1 text-[11px] text-fg-muted hover:bg-surface hover:text-fg"
      >
        Manage tasks
      </button>
      {menuNode}
    </div>
  );
}

function TaskTab({
  task,
  active,
  state,
  ready,
  onClick,
  onOpenMenu
}: {
  task: Task;
  active: boolean;
  state: ProcessState | undefined;
  ready: boolean;
  onClick: () => void;
  /** Opens the per-task action menu at the pointer; used by both right-click and the ⋮ button. */
  onOpenMenu: (e: React.MouseEvent) => void;
}): JSX.Element {
  const live = isLive(state);
  // Prefer the semantic status tokens; the oneShot-exited "info" case has no semantic dot token,
  // so it falls back to the accent colour rather than the old raw bg-blue-500.
  const stateColor = !task.enabled
    ? 'bg-border-strong/50'
    : state === 'crashed'
    ? 'bg-danger-strong'
    : state === 'starting' || state === 'exiting'
    ? 'bg-warn-strong'
    : state === 'running' && ready
    ? 'bg-success-strong'
    : state === 'running'
    ? 'bg-warn-strong'
    : task.oneShot && state === 'exited'
    ? 'bg-accent'
    : 'bg-fg-subtle';

  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (live) void invokeOrToast('task:stop', { id: task.id }, { context: 'Stop failed' });
    else void startTask(task.id);
  };

  // A group of sibling controls - no nested interactive elements. Right-click anywhere on the
  // group opens the action menu; the ⋮ button exposes the same menu without a mouse.
  return (
    <div
      onContextMenu={onOpenMenu}
      className={cn(
        'group flex items-center gap-1.5 rounded-md border px-1 py-0.5 text-xs',
        active
          ? 'border-border-strong bg-surface text-fg'
          : 'border-transparent text-fg-muted hover:bg-surface/60 hover:text-fg',
        !task.enabled && 'opacity-50'
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-1.5 rounded px-1 py-0.5"
        title={tooltipFor(task)}
        aria-pressed={active}
      >
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', stateColor)} />
        <span className="font-medium">{task.name}</span>
        <span className="text-[10px] text-fg-subtle">{readinessLabel(task.readiness)}</span>
      </button>
      <button
        type="button"
        onClick={toggle}
        className="rounded p-0.5 text-fg-subtle hover:bg-elevated hover:text-fg"
        aria-label={live ? `Stop ${task.name}` : `Start ${task.name}`}
        title={live ? 'Stop task' : 'Start task'}
      >
        {live ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      </button>
      <button
        type="button"
        onClick={onOpenMenu}
        className="rounded p-0.5 text-fg-subtle hover:bg-elevated hover:text-fg"
        aria-label={`More actions for ${task.name}`}
        title="More actions"
      >
        <MoreVertical className="h-3 w-3" />
      </button>
    </div>
  );
}

function readinessLabel(r: ReadinessSignal): string {
  switch (r.kind) {
    case 'none':
      return '';
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

function tooltipFor(t: Task): string {
  const cmd = t.commandKind === 'custom' ? t.customCommand ?? '' : t.script ?? '';
  const deps = t.dependsOn.length ? ` · depends: ${t.dependsOn.length}` : '';
  return `${t.name}\n${cmd}${deps}\nRight-click for more actions.`;
}
