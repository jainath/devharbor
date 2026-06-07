import { useEffect, useState } from 'react';
import { AlertTriangle, RotateCw, X } from 'lucide-react';
import type { TaskId } from '@shared/types';

export function CrashPin({
  taskId,
  taskName,
  exitCode,
  onRestart
}: {
  taskId: TaskId;
  taskName: string;
  exitCode: number | null;
  onRestart: () => void;
}): JSX.Element | null {
  const [tail, setTail] = useState<string>('');
  const [dismissed, setDismissed] = useState<boolean>(false);

  useEffect(() => {
    // Reset dismissal when the user switches to a different task's pin.
    setDismissed(false);
    let cancelled = false;
    void window.api
      .invoke('task:tailBuffer', { id: taskId, maxLines: 200 })
      .then((t) => {
        if (!cancelled) setTail(t);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (dismissed) return null;

  return (
    <div className="border-b border-danger-border bg-danger-bg">
      <div className="flex items-center gap-2 px-4 py-2 text-xs">
        <AlertTriangle className="h-3.5 w-3.5 text-danger-strong" />
        <span className="font-medium text-danger-fg">
          {taskName} crashed{exitCode != null ? ` (exit ${exitCode})` : ''}
        </span>
        <span className="text-fg-subtle">Last 200 lines pinned below.</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={onRestart}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] text-fg hover:bg-elevated"
          >
            <RotateCw className="h-3 w-3" /> Restart task
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="rounded-md p-1 text-fg-subtle hover:bg-surface hover:text-fg"
            title="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-base/60 px-4 py-2 font-mono text-[11px] text-fg-muted">
        {tail || '(no output captured)'}
      </pre>
    </div>
  );
}

