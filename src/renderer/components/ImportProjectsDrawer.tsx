import { useState } from 'react';
import { X, FolderOpen, Loader2, CheckCircle2 } from 'lucide-react';
import type { App } from '@shared/types';
import type { ImportCandidate } from '@shared/ipc';
import { useDialog } from '../hooks/useDialog';
import { invokeOrToast } from '../lib/invoke';
import { pushToast } from './Toast';

const TITLE_ID = 'import-projects-title';

/**
 * Bulk import (IMPROVEMENT-PLAN 14.5). The target user keeps 3-20 repos under one folder, but
 * the only way to register them was the add drawer, one at a time. This shallow-scans a chosen
 * folder for package.json projects (apps:scanFolder), shows a checklist with detected package
 * manager + start script, and batch-registers the selected ones via apps:create - reusing all
 * the existing detection + atomic-create machinery.
 */
export function ImportProjectsDrawer({
  onClose,
  onImported
}: {
  onClose: () => void;
  onImported: (apps: App[]) => void;
}): JSX.Element {
  const { dialogProps } = useDialog(onClose, TITLE_ID);
  const [dir, setDir] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  const chooseFolder = async (): Promise<void> => {
    const picked = await window.api.invoke('dialog:browse', undefined);
    if (!picked) return;
    setDir(picked);
    setScanning(true);
    setCandidates([]);
    try {
      const found = await window.api.invoke('apps:scanFolder', { dir: picked });
      setCandidates(found);
      // Pre-select everything not already registered.
      setSelected(new Set(found.filter((c) => !c.alreadyRegistered).map((c) => c.path)));
    } catch (e) {
      pushToast(`Scan failed: ${(e as Error).message}`, { kind: 'error' });
    } finally {
      setScanning(false);
    }
  };

  const toggle = (path: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const selectableCount = candidates.filter((c) => !c.alreadyRegistered).length;
  const chosen = candidates.filter((c) => selected.has(c.path) && !c.alreadyRegistered);

  const doImport = async (): Promise<void> => {
    if (chosen.length === 0) return;
    setImporting(true);
    const created: App[] = [];
    for (const c of chosen) {
      const app = await invokeOrToast(
        'apps:create',
        {
          path: c.path,
          name: c.name,
          packageManager: c.packageManager,
          defaultScript: c.suggestedScript,
          firstTask: c.suggestedScript
            ? { name: c.suggestedScript, commandKind: 'script', script: c.suggestedScript }
            : null
        },
        { context: `Import "${c.name}" failed` }
      );
      if (app) created.push(app);
    }
    setImporting(false);
    if (created.length > 0) {
      pushToast(`Imported ${created.length} project${created.length === 1 ? '' : 's'}.`, {
        kind: 'success'
      });
      onImported(created);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
      <div
        {...dialogProps}
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-base shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id={TITLE_ID} className="text-sm font-medium text-fg">
            Import projects
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-fg-subtle hover:bg-surface hover:text-fg"
            title="Close"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          <p className="mb-3 text-[11px] leading-snug text-fg-subtle">
            Point DevHarbor at a folder that contains several project folders. It scans one level
            deep for <code className="text-fg-muted">package.json</code> projects and registers the
            ones you pick.
          </p>
          <button
            data-autofocus
            onClick={() => void chooseFolder()}
            className="flex w-full items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm hover:border-border-strong"
          >
            <FolderOpen className="h-4 w-4 shrink-0 text-fg-muted" />
            {dir ? (
              <span className="min-w-0 flex-1 truncate text-left font-mono text-xs text-fg">{dir}</span>
            ) : (
              <span className="flex-1 text-left text-fg-subtle">Choose a folder of projects…</span>
            )}
            <span className="shrink-0 rounded bg-elevated px-1.5 py-0.5 text-[10px] text-fg-muted">
              {dir ? 'Change' : 'Browse'}
            </span>
          </button>

          {scanning && (
            <p className="mt-3 flex items-center gap-2 text-sm text-fg-subtle">
              <Loader2 className="h-4 w-4 animate-spin" /> Scanning…
            </p>
          )}

          {!scanning && dir && candidates.length === 0 && (
            <p className="mt-3 text-sm text-fg-subtle">No package.json projects found in that folder.</p>
          )}

          {candidates.length > 0 && (
            <ul className="mt-3 space-y-1">
              {candidates.map((c) => {
                const isSel = selected.has(c.path);
                return (
                  <li key={c.path}>
                    <label
                      className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-sm ${
                        c.alreadyRegistered
                          ? 'cursor-not-allowed border-border bg-base/50 opacity-60'
                          : 'border-border bg-surface hover:border-border-strong'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={c.alreadyRegistered ? true : isSel}
                        disabled={c.alreadyRegistered}
                        onChange={() => toggle(c.path)}
                        className="shrink-0 accent-accent"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-fg">{c.name}</span>
                        <span className="block truncate text-[10px] text-fg-subtle">
                          {c.packageManager ?? 'npm'}
                          {c.suggestedScript ? ` · ${c.suggestedScript}` : ' · no script'}
                        </span>
                      </span>
                      {c.alreadyRegistered && (
                        <span className="flex shrink-0 items-center gap-1 text-[10px] text-fg-subtle">
                          <CheckCircle2 className="h-3 w-3" /> added
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-2">
          <span className="text-[11px] text-fg-subtle">
            {selectableCount > 0 ? `${chosen.length} of ${selectableCount} selected` : ''}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="rounded-md px-2.5 py-1 text-sm text-fg-muted hover:bg-surface">
              Cancel
            </button>
            <button
              onClick={() => void doImport()}
              disabled={chosen.length === 0 || importing}
              className="rounded-md bg-accent px-3 py-1 text-sm text-accent-fg hover:bg-accent/90 disabled:opacity-50"
            >
              {importing ? 'Importing…' : `Add ${chosen.length || ''} selected`.trim()}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
