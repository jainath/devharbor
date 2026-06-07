import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Plus, Trash2, X, FileText, ClipboardPaste, ClipboardCopy } from 'lucide-react';
import { ulid } from 'ulid';
import type { AppId, EnvVar, Task, TaskId } from '@shared/types';
import type { EnvFileInfo } from '@shared/ipc';
import { parseDotEnv, isSecretKey } from '@shared/dotenv';
import { ErrorBanner } from './ErrorBanner';
import { cn } from '../lib/cn';

type Scope = 'global' | 'app' | 'task';

const EMPTY: EnvVar[] = [];

export function EnvEditor({
  appId,
  appName,
  tasks = [],
  initialTab,
  initialTaskId = null,
  onClose
}: {
  appId: AppId;
  appName: string;
  /** Tasks for this app — needed for the Task tab + per-task picker. */
  tasks?: Task[];
  initialTab?: 'app' | 'global' | 'task';
  /** If provided, the editor opens on the Task tab pre-selected to this task. */
  initialTaskId?: TaskId | null;
  onClose: () => void;
}): JSX.Element {
  // Pick a sensible default tab: explicit prop > task-context > app.
  const [tab, setTab] = useState<Scope>(
    initialTab ?? (initialTaskId ? 'task' : 'app')
  );
  // Currently-selected task for the Task tab. Defaults to the passed-in initial.
  const [activeTaskId, setActiveTaskId] = useState<TaskId | null>(
    initialTaskId ?? tasks[0]?.id ?? null
  );
  const [appVars, setAppVars] = useState<EnvVar[]>(EMPTY);
  const [globalVars, setGlobalVars] = useState<EnvVar[]>(EMPTY);
  const [taskVars, setTaskVars] = useState<EnvVar[]>(EMPTY);
  const [envFiles, setEnvFiles] = useState<EnvFileInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    const [a, g, files] = await Promise.all([
      window.api.invoke('env:getApp', { id: appId }),
      window.api.invoke('env:getGlobal', undefined),
      window.api.invoke('env:files', { id: appId })
    ]);
    setAppVars(a);
    setGlobalVars(g);
    setEnvFiles(files);
  }, [appId]);

  const refreshTask = useCallback(async (): Promise<void> => {
    if (!activeTaskId) {
      setTaskVars(EMPTY);
      return;
    }
    const t = await window.api.invoke('env:getTask', { id: activeTaskId });
    setTaskVars(t);
  }, [activeTaskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refreshTask();
  }, [refreshTask]);

  const activeTask = tasks.find((t) => t.id === activeTaskId) ?? null;

  const current = tab === 'app' ? appVars : tab === 'global' ? globalVars : taskVars;
  const setCurrent = tab === 'app' ? setAppVars : tab === 'global' ? setGlobalVars : setTaskVars;

  const onChangeRow = (id: string, patch: Partial<EnvVar>): void => {
    setCurrent((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const onAddRow = (): void => {
    const draft: EnvVar = {
      id: ulid(),
      appId: tab === 'global' ? null : appId,
      key: '',
      value: '',
      enabled: true,
      isSecret: false
    };
    setCurrent((rows) => [...rows, draft]);
  };

  const onRemoveRow = (id: string): void => {
    setCurrent((rows) => rows.filter((r) => r.id !== id));
  };

  const onSave = async (): Promise<void> => {
    setError(null);
    try {
      if (tab === 'app') {
        await window.api.invoke('env:setApp', { id: appId, vars: appVars });
        await refresh();
      } else if (tab === 'global') {
        await window.api.invoke('env:setGlobal', { vars: globalVars });
        await refresh();
      } else if (tab === 'task' && activeTaskId) {
        await window.api.invoke('env:setTask', { id: activeTaskId, vars: taskVars });
        await refreshTask();
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const applyPaste = (): void => {
    const parsed = parseDotEnv(pasteText);
    const incoming: EnvVar[] = Object.entries(parsed).map(([key, value]) => ({
      id: ulid(),
      appId: tab === 'global' ? null : appId,
      key,
      value,
      enabled: true,
      isSecret: isSecretKey(key)
    }));
    // Merge by key — incoming overrides existing values, preserves disabled flag.
    setCurrent((rows) => {
      const byKey = new Map(rows.map((r) => [r.key, r]));
      for (const r of incoming) {
        const existing = byKey.get(r.key);
        if (existing) byKey.set(r.key, { ...existing, value: r.value });
        else byKey.set(r.key, r);
      }
      return [...byKey.values()];
    });
    setPasteOpen(false);
    setPasteText('');
  };

  type Source = 'global' | 'app' | 'task';

  const exportMergedEnv = async (): Promise<void> => {
    const lines: string[] = [
      `# Effective env for ${appName}${activeTask ? ` · task ${activeTask.name}` : ''}`,
      `# generated ${new Date().toISOString()}`,
      `# layering (later wins): global < app < task < .env`
    ];
    const merged = new Map<string, { value: string; source: Source }>();
    for (const v of globalVars) {
      if (!v.enabled || !v.key) continue;
      merged.set(v.key, { value: v.value, source: 'global' });
    }
    for (const v of appVars) {
      if (!v.enabled || !v.key) continue;
      merged.set(v.key, { value: v.value, source: 'app' });
    }
    if (tab === 'task') {
      for (const v of taskVars) {
        if (!v.enabled || !v.key) continue;
        merged.set(v.key, { value: v.value, source: 'task' });
      }
    }
    for (const [k, { value, source }] of [...merged.entries()].sort()) {
      if (source !== 'global') lines.push(`#!override-${source}`);
      lines.push(`${k}=${quoteIfNeeded(value)}`);
    }
    await navigator.clipboard.writeText(lines.join('\n'));
  };

  // Compute "effective" merged env for the right-hand preview pane.
  // When the Task tab is active, fold task vars into the merge too — gives the
  // user the exact env the task will see at spawn time.
  const effective = useMemo(() => {
    const merged = new Map<string, { value: string; source: Source }>();
    for (const v of globalVars) {
      if (!v.enabled || !v.key) continue;
      merged.set(v.key, { value: v.value, source: 'global' });
    }
    for (const v of appVars) {
      if (!v.enabled || !v.key) continue;
      merged.set(v.key, { value: v.value, source: 'app' });
    }
    if (tab === 'task') {
      for (const v of taskVars) {
        if (!v.enabled || !v.key) continue;
        merged.set(v.key, { value: v.value, source: 'task' });
      }
    }
    return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [appVars, globalVars, taskVars, tab]);

  // Which keys does the current scope override from lower scopes? Drives the
  // "⤴ overrides app" / "⤴ overrides global" badges next to keys.
  const overrideHints = useMemo(() => {
    const globalKeys = new Set(globalVars.filter((v) => v.enabled).map((v) => v.key));
    const appKeys = new Set(appVars.filter((v) => v.enabled).map((v) => v.key));
    return { globalKeys, appKeys };
  }, [globalVars, appVars]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
      <div className="flex h-full max-h-[760px] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-base shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium text-fg">Environment variables</h2>
            <div className="flex gap-1 rounded-md border border-border bg-surface p-0.5 text-xs">
              <button
                onClick={() => setTab('global')}
                className={cn(
                  'rounded px-2 py-0.5',
                  tab === 'global' ? 'bg-elevated text-fg' : 'text-fg-muted'
                )}
              >
                Global
              </button>
              <button
                onClick={() => setTab('app')}
                className={cn(
                  'rounded px-2 py-0.5',
                  tab === 'app' ? 'bg-elevated text-fg' : 'text-fg-muted'
                )}
              >
                App · {appName}
              </button>
              {tasks.length > 0 && (
                <button
                  onClick={() => setTab('task')}
                  className={cn(
                    'rounded px-2 py-0.5',
                    tab === 'task' ? 'bg-elevated text-fg' : 'text-fg-muted'
                  )}
                  title="Edit env vars scoped to one task only"
                >
                  Task{activeTask ? ` · ${activeTask.name}` : ''}
                </button>
              )}
            </div>
            {tab === 'task' && tasks.length > 1 && (
              <select
                value={activeTaskId ?? ''}
                onChange={(e) => setActiveTaskId(e.target.value as TaskId)}
                className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-fg outline-none"
              >
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPasteOpen(true)}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface hover:text-fg"
              title="Paste a .env blob"
            >
              <ClipboardPaste className="h-3 w-3" /> Paste .env
            </button>
            <button
              onClick={() => void exportMergedEnv()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface hover:text-fg"
              title="Copy effective merged env to clipboard"
            >
              <ClipboardCopy className="h-3 w-3" /> Export
            </button>
            <button
              onClick={() => setShowSecrets((v) => !v)}
              className="rounded-md p-1 text-fg-subtle hover:bg-surface hover:text-fg"
              title={showSecrets ? 'Mask secrets' : 'Reveal secrets'}
            >
              {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
            <button
              onClick={onClose}
              className="rounded-md p-1 text-fg-subtle hover:bg-surface hover:text-fg"
              title="Close env editor"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        {error && (
          <ErrorBanner
            message={error}
            onDismiss={() => setError(null)}
            className="m-3 rounded-md"
          />
        )}

        <div className="flex flex-1 overflow-hidden">
          {/* Table */}
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-surface px-4 py-1.5 text-[11px] uppercase tracking-wider text-fg-subtle">
              <span>
                {tab === 'app'
                  ? 'App overrides'
                  : tab === 'global'
                  ? 'Global defaults'
                  : `Task overrides · ${activeTask?.name ?? ''}`}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={onAddRow}
                  title="Add a new env variable row"
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-fg-muted hover:bg-surface hover:text-fg"
                >
                  <Plus className="h-3 w-3" /> Add row
                </button>
                <button
                  onClick={() => void onSave()}
                  className="rounded-md bg-accent px-2 py-0.5 text-[11px] text-accent-fg hover:bg-accent/90"
                >
                  Save
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {current.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
                  No variables. Click "Add row" to start.
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-base text-[10px] uppercase tracking-wider text-fg-subtle">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">On</th>
                      <th className="px-2 py-1.5 font-medium">Key</th>
                      <th className="px-2 py-1.5 font-medium">Value</th>
                      <th className="px-2 py-1.5 font-medium">Secret</th>
                      <th className="px-2 py-1.5 font-medium">Note</th>
                      <th className="px-2 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.map((row) => {
                      // Override hints depend on current scope: app rows can override
                      // global; task rows can override app and/or global.
                      const overridesGlobal =
                        (tab === 'app' || tab === 'task') && overrideHints.globalKeys.has(row.key);
                      const overridesApp = tab === 'task' && overrideHints.appKeys.has(row.key);
                      return (
                        <tr key={row.id} className="border-t border-surface">
                          <td className="px-2 py-1 align-middle">
                            <input
                              type="checkbox"
                              checked={row.enabled}
                              onChange={(e) => onChangeRow(row.id, { enabled: e.target.checked })}
                              className="h-3.5 w-3.5"
                            />
                          </td>
                          <td className="px-2 py-1 align-middle">
                            <input
                              value={row.key}
                              onChange={(e) => onChangeRow(row.id, { key: e.target.value })}
                              placeholder="KEY"
                              className="w-full rounded bg-transparent px-1 py-0.5 font-mono text-xs text-fg outline-none focus:bg-surface"
                            />
                            <span className="ml-1 inline-flex items-center gap-1">
                              {overridesApp && (
                                <span
                                  className="text-[10px] text-warn-strong"
                                  title="Overrides an app-scoped value"
                                >
                                  ⤴ overrides app
                                </span>
                              )}
                              {overridesGlobal && (
                                <span
                                  className="text-[10px] text-warn-strong"
                                  title="Overrides a global value"
                                >
                                  ⤴ overrides global
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="px-2 py-1 align-middle">
                            <input
                              type={row.isSecret && !showSecrets ? 'password' : 'text'}
                              value={row.value}
                              onChange={(e) => onChangeRow(row.id, { value: e.target.value })}
                              placeholder="value"
                              className="w-full rounded bg-transparent px-1 py-0.5 font-mono text-xs text-fg outline-none focus:bg-surface"
                            />
                          </td>
                          <td className="px-2 py-1 align-middle">
                            <input
                              type="checkbox"
                              checked={row.isSecret}
                              onChange={(e) => onChangeRow(row.id, { isSecret: e.target.checked })}
                              className="h-3.5 w-3.5"
                            />
                          </td>
                          <td className="px-2 py-1 align-middle">
                            <input
                              value={row.note ?? ''}
                              onChange={(e) => onChangeRow(row.id, { note: e.target.value })}
                              placeholder="—"
                              className="w-full rounded bg-transparent px-1 py-0.5 text-xs text-fg-muted outline-none focus:bg-surface"
                            />
                          </td>
                          <td className="px-2 py-1 text-right align-middle">
                            <button
                              onClick={() => onRemoveRow(row.id)}
                              className="rounded p-0.5 text-fg-subtle hover:bg-danger-bg hover:text-danger-fg"
                              title="Remove"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Right side panel — effective merged env, grouped by winning scope. */}
          <aside className="flex w-72 shrink-0 flex-col border-l border-border">
            <div className="border-b border-surface px-4 py-1.5 text-[11px] uppercase tracking-wider text-fg-subtle">
              Effective merged env
              <span className="ml-2 normal-case tracking-normal text-fg-subtle">
                (grouped by winning scope)
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {effective.length === 0 ? (
                <div className="text-xs text-fg-subtle">(empty)</div>
              ) : (
                (() => {
                  // Partition winners by their source. Task on top (most specific),
                  // then App, then Global. Shadowed (overridden) lower-scope values
                  // are intentionally not shown — the editor table itself shows them.
                  const groups: Record<
                    Source,
                    [string, { value: string; source: Source }][]
                  > = { task: [], app: [], global: [] };
                  for (const [k, v] of effective) groups[v.source].push([k, v]);

                  const Section = ({
                    title,
                    accent,
                    rows
                  }: {
                    title: string;
                    accent: string;
                    rows: [string, { value: string; source: Source }][];
                  }): JSX.Element | null =>
                    rows.length === 0 ? null : (
                      <div className="mb-2">
                        <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-fg-subtle">
                          <span className={cn('inline-block h-1.5 w-1.5 rounded-full', accent)} />
                          <span>{title}</span>
                          <span className="text-fg-subtle/70">· {rows.length}</span>
                        </div>
                        <ul className="space-y-0.5 font-mono text-[11px]">
                          {rows.map(([k, v]) => (
                            <li key={k} className="truncate">
                              <span className="text-fg-muted">{k}</span>
                              <span className="text-fg-subtle">=</span>
                              <span className="text-fg-muted">{v.value}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );

                  return (
                    <>
                      <Section
                        title={`Task${activeTask ? ` · ${activeTask.name}` : ''}`}
                        accent="bg-danger-strong"
                        rows={groups.task}
                      />
                      <Section title="App" accent="bg-warn-strong" rows={groups.app} />
                      <Section title="Global" accent="bg-fg-subtle" rows={groups.global} />
                    </>
                  );
                })()
              )}
            </div>
            <div className="border-t border-border px-3 py-2 text-[11px] text-fg-subtle">
              <div className="flex items-center gap-1 text-fg-muted">
                <FileText className="h-3 w-3" /> .env files found
              </div>
              <ul className="mt-1 space-y-0.5 font-mono">
                {envFiles.length === 0 ? (
                  <li>(none)</li>
                ) : (
                  envFiles.map((f) => (
                    <li key={f.path} className="flex items-center justify-between gap-2">
                      <span className="truncate text-fg-muted">{f.name}</span>
                      <span className="text-[10px] text-fg-subtle">{formatAgo(f.modifiedAt)}</span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </aside>
        </div>
      </div>

      {pasteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
          <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-base shadow-2xl">
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h3 className="text-sm font-medium text-fg">
                  Paste .env into{' '}
                  {tab === 'app'
                    ? `App · ${appName}`
                    : tab === 'global'
                    ? 'Global'
                    : `Task · ${activeTask?.name ?? ''}`}
                </h3>
                <p className="mt-0.5 text-[11px] text-fg-subtle">
                  Existing keys are overwritten with the new value. SECRET/TOKEN/PASSWORD/KEY/PRIVATE
                  keys are auto-marked secret.
                </p>
              </div>
              <button
                onClick={() => setPasteOpen(false)}
                title="Close without pasting"
                aria-label="Close"
                className="rounded-md p-1 text-fg-subtle hover:bg-surface hover:text-fg"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="flex-1 p-3">
              <textarea
                autoFocus
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={12}
                placeholder="DATABASE_URL=postgres://...\nAPI_KEY=...\n# comments allowed"
                className="w-full resize-none rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-fg"
              />
              <div className="mt-1 text-[10px] text-fg-subtle">
                {(() => {
                  const parsed = parseDotEnv(pasteText);
                  const n = Object.keys(parsed).length;
                  return n === 0 ? 'No valid keys yet.' : `${n} key${n === 1 ? '' : 's'} ready.`;
                })()}
              </div>
            </div>
            <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-2">
              <button
                onClick={() => setPasteOpen(false)}
                className="rounded-md px-2.5 py-1 text-sm text-fg-muted hover:bg-surface"
              >
                Cancel
              </button>
              <button
                onClick={applyPaste}
                disabled={Object.keys(parseDotEnv(pasteText)).length === 0}
                className="rounded-md bg-accent px-2.5 py-1 text-sm text-accent-fg hover:bg-accent/90 disabled:opacity-50"
              >
                Merge into rows
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function quoteIfNeeded(value: string): string {
  if (/[\s"'#]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

function formatAgo(ts: number): string {
  if (!ts) return '';
  const ms = Date.now() - ts;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
