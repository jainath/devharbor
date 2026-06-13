import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Plug, RotateCw, X } from 'lucide-react';
import type { TaskId } from '@shared/types';
import { useStore } from '../store/store';

/**
 * Scan crashed-task output for an "address already in use" signal and, when
 * present, recover the offending port. Node/Vite/webpack/etc. all surface this
 * differently (`EADDRINUSE`, `Error: listen EADDRINUSE: address already in use
 * :::3000`, `address already in use`, `port 3000 is already in use`), so we
 * accept any of those phrasings and then look for a port number near the match.
 *
 * Returns `null` when no port-conflict signal is found so the caller can render
 * the pin exactly as before - this enrichment is purely additive.
 */
function detectPortConflict(text: string): { port: number | null } | null {
  const signal = text.match(/EADDRINUSE|address already in use/i);
  if (!signal || signal.index == null) return null;

  // Anchor extraction to the CONFLICT LINE (plus the next line for wrapped messages) - the
  // full 200-line tail is littered with other `:NN` tokens (timestamps, stack frames,
  // unrelated URLs) that a whole-text scan would happily report as "the" port.
  const lineStart = text.lastIndexOf('\n', signal.index) + 1;
  let lineEnd = text.indexOf('\n', signal.index);
  if (lineEnd !== -1) lineEnd = text.indexOf('\n', lineEnd + 1); // include one extra line
  const near = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);

  // Prefer an explicit "port 3000" phrasing, then fall back to a `:3000`-style
  // suffix (covers `:::3000`, `127.0.0.1:3000`, `0.0.0.0:3000`). Ports are
  // 2-5 digits; \b keeps us from swallowing a longer trailing number.
  const byKeyword = near.match(/port\s+(\d{2,5})\b/i);
  const byColon = near.match(/:(\d{2,5})\b/);
  const raw = byKeyword?.[1] ?? byColon?.[1];
  const port = raw != null ? Number(raw) : NaN;

  return { port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null };
}

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

  // Stable store slices only - never `?? []`/`?? {}` inside a selector (it
  // returns a fresh reference each render and triggers an infinite re-render
  // loop under React 18). We select the raw maps and derive below.
  const apps = useStore((s) => s.apps);
  const tasksByApp = useStore((s) => s.tasksByApp);
  const taskPorts = useStore((s) => s.taskPorts);

  // Detect an "address already in use" signal in the pinned output.
  const conflict = useMemo(() => detectPortConflict(tail), [tail]);

  // When we know the conflicting port, find which OTHER registered task
  // currently holds it so we can name the culprit in the callout.
  const holder = useMemo(() => {
    const port = conflict?.port;
    if (port == null) return null;
    for (const [appId, tasks] of Object.entries(tasksByApp)) {
      for (const t of tasks) {
        if (t.id === taskId) continue; // skip the crashed task itself
        const ports = taskPorts[t.id] ?? [];
        if (ports.includes(port)) {
          const appName = apps.find((a) => a.id === appId)?.name ?? 'Unknown app';
          return { appName, taskName: t.name };
        }
      }
    }
    return null;
  }, [conflict, tasksByApp, taskPorts, apps, taskId]);

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
      {conflict ? (
        <div className="flex items-start gap-2 border-t border-danger-border bg-danger-bg/60 px-4 py-2 text-[11px]">
          <Plug className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-strong" />
          <span className="text-danger-fg">
            {conflict.port != null
              ? `Port ${conflict.port} is already in use - another process is bound to it.`
              : 'That address is already in use - another process is bound to this port.'}
            {holder != null
              ? ` Held by ${holder.appName} / ${holder.taskName}.`
              : ''}
          </span>
        </div>
      ) : null}
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-base/60 px-4 py-2 font-mono text-[11px] text-fg-muted">
        {tail || '(no output captured)'}
      </pre>
    </div>
  );
}

