import { Play, Square, RotateCw, EyeOff, Eye, Edit3, KeyRound, Trash2 } from 'lucide-react';
import type { AppId, ProcessState, ReadinessSignal, Task, TaskId } from '@shared/types';
import { useStore } from '../store/store';
import { cn } from '../lib/cn';
import { useContextMenu, type MenuItem } from './ContextMenu';
import { openConfirm } from './PromptModal';

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
    const st = taskState[task.id];
    const isLive = st === 'running' || st === 'starting' || st === 'exiting';
    return [
      {
        label: isLive ? 'Stop this task' : 'Start this task',
        icon: isLive ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />,
        onSelect: async () => {
          if (isLive) await window.api.invoke('task:stop', { id: task.id });
          else {
            const rt = await window.api.invoke('task:start', { id: task.id });
            useStore.setState((s) => ({
              runningTasks: { ...s.runningTasks, [rt.taskId]: rt },
              taskState: { ...s.taskState, [rt.taskId]: rt.state }
            }));
          }
        }
      },
      {
        label: 'Restart this task',
        icon: <RotateCw className="h-3.5 w-3.5" />,
        disabled: !isLive,
        onSelect: async () => {
          await window.api.invoke('task:stop', { id: task.id });
          setTimeout(async () => {
            const rt = await window.api.invoke('task:start', { id: task.id });
            useStore.setState((s) => ({
              runningTasks: { ...s.runningTasks, [rt.taskId]: rt },
              taskState: { ...s.taskState, [rt.taskId]: rt.state }
            }));
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
        disabled: isLive,
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
        disabled: isLive,
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
            onContextMenu={(e) => openMenu(e, buildItems(t))}
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
  onContextMenu
}: {
  task: Task;
  active: boolean;
  state: ProcessState | undefined;
  ready: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}): JSX.Element {
  const isLive = state === 'running' || state === 'starting' || state === 'exiting';
  const stateColor = !task.enabled
    ? 'bg-border-strong/50'
    : state === 'crashed'
    ? 'bg-red-500'
    : state === 'starting' || state === 'exiting'
    ? 'bg-amber-500'
    : state === 'running' && ready
    ? 'bg-green-500'
    : state === 'running'
    ? 'bg-amber-500'
    : task.oneShot && state === 'exited'
    ? 'bg-blue-500'
    : 'bg-fg-subtle';

  const startStop = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    if (isLive) {
      await window.api.invoke('task:stop', { id: task.id });
    } else {
      const rt = await window.api.invoke('task:start', { id: task.id });
      useStore.setState((s) => ({
        runningTasks: { ...s.runningTasks, [rt.taskId]: rt },
        taskState: { ...s.taskState, [rt.taskId]: rt.state }
      }));
    }
  };

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        'group flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
        active
          ? 'border-border-strong bg-surface text-fg'
          : 'border-transparent text-fg-muted hover:bg-surface/60 hover:text-fg',
        !task.enabled && 'opacity-50'
      )}
      title={tooltipFor(task)}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', stateColor)} />
      <span className="font-medium">{task.name}</span>
      <span className="text-[10px] text-fg-subtle">{readinessLabel(task.readiness)}</span>
      <span
        role="button"
        onClick={(e) => void startStop(e)}
        className="ml-1 rounded p-0.5 text-fg-subtle hover:bg-elevated hover:text-fg"
        title={isLive ? 'Stop task' : 'Start task'}
      >
        {isLive ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      </span>
    </button>
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
