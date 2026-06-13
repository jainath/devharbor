import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search } from 'lucide-react';
import type { AppId } from '@shared/types';
import type { GlobalLogMatch } from '@shared/ipc';
import { useDialog } from '../hooks/useDialog';

const TITLE_ID = 'global-log-search-title';

/**
 * Cross-task log search (IMPROVEMENT-PLAN 14.9). With several servers running, "which service
 * printed ECONNREFUSED?" used to mean opening each app, each task tab, and searching one at a
 * time. LogBuffer already holds every live task's output in main, so this fans a single
 * logs:searchAll query across all of them and groups the matches; picking one jumps to its app.
 */
export function GlobalLogSearch({
  onClose,
  onSelectApp
}: {
  onClose: () => void;
  onSelectApp: (id: AppId) => void;
}): JSX.Element {
  const { dialogProps } = useDialog(onClose, TITLE_ID);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<GlobalLogMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search across all live task buffers.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setMatches([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      void window.api
        .invoke('logs:searchAll', { query: q, limit: 300 })
        .then((res) => setMatches(res))
        .catch(() => setMatches([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Group matches by app + task for a scannable result list.
  const groups = useMemo(() => {
    const byKey = new Map<string, { appId: AppId; appName: string; taskName: string; lines: string[] }>();
    for (const m of matches) {
      const key = `${m.appId}::${m.taskId}`;
      const g = byKey.get(key) ?? { appId: m.appId, appName: m.appName, taskName: m.taskName, lines: [] };
      g.lines.push(m.line);
      byKey.set(key, g);
    }
    return [...byKey.values()];
  }, [matches]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        {...dialogProps}
        className="flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-base shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-fg-subtle" />
          <h2 id={TITLE_ID} className="sr-only">
            Search all logs
          </h2>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all running tasks' logs… (regex)"
            className="flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle outline-none"
          />
          <button
            onClick={onClose}
            className="rounded-md p-1 text-fg-subtle hover:bg-surface hover:text-fg"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {query.trim() && !searching && groups.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-fg-subtle">No matches in any live task.</p>
          )}
          {!query.trim() && (
            <p className="px-3 py-6 text-center text-xs text-fg-subtle">
              Type to search across every running task's log buffer.
            </p>
          )}
          {groups.map((g) => (
            <div key={`${g.appId}-${g.taskName}`} className="mb-2">
              <button
                onClick={() => {
                  onSelectApp(g.appId);
                  onClose();
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-surface"
              >
                <span className="font-medium text-fg">{g.appName}</span>
                <span className="text-fg-subtle">/ {g.taskName}</span>
                <span className="ml-auto text-[10px] text-fg-subtle">{g.lines.length} match{g.lines.length === 1 ? '' : 'es'}</span>
              </button>
              <div className="mt-0.5 space-y-0.5 pl-2">
                {g.lines.slice(0, 8).map((line, i) => (
                  <div
                    key={i}
                    className="truncate rounded bg-elevated/40 px-2 py-0.5 font-mono text-[11px] text-fg-muted"
                    title={line}
                  >
                    {line || ' '}
                  </div>
                ))}
                {g.lines.length > 8 && (
                  <div className="pl-2 text-[10px] text-fg-subtle">+{g.lines.length - 8} more…</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
