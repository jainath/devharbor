import { useEffect, useMemo, useState } from 'react';
import { X, FolderOpen, ChevronDown, ChevronRight } from 'lucide-react';
import type { App, DetectionResult, NodeVersionPref, PackageManager, EnvVar } from '@shared/types';
import { ulid } from 'ulid';
import { parseDotEnv, isSecretKey } from '@shared/dotenv';
import { ErrorBanner } from './ErrorBanner';
import { NodeVersionPicker } from './NodeVersionPicker';

const PMS: (PackageManager | null)[] = [null, 'npm', 'yarn', 'pnpm', 'bun'];

/**
 * Confirm-before-add drawer. Shows detected node version / package manager / scripts /
 * .env files, and lets the user set: name, Node version, package manager, the default
 * script (which becomes the app's first task), and optionally paste a .env blob.
 *
 * Key behaviour (Phase 10 fix): the chosen default script is materialised into a real
 * Task on add, so the app is immediately startable. Previously the script was only
 * stored on the app row and no task existed until the next app restart → Start failed.
 */
export function AddAppDrawer({
  path,
  onCancel,
  onConfirm
}: {
  path: string;
  onCancel: () => void;
  onConfirm: (app: App) => void;
}): JSX.Element {
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [name, setName] = useState<string>(() => basename(path));
  const [defaultScript, setDefaultScript] = useState<string | null>(null);
  const [nodePref, setNodePref] = useState<NodeVersionPref>({ kind: 'auto' });
  const [pm, setPm] = useState<PackageManager | null>(null);
  const [envText, setEnvText] = useState('');
  const [envOpen, setEnvOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .invoke('apps:detect', { path })
      .then((d) => {
        if (cancelled) return;
        setDetection(d);
        setDefaultScript(d.suggestedDefaultScript);
        setPm(d.packageManager); // pre-select detected PM; user can override
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const add = async (): Promise<void> => {
    setError(null);
    setAdding(true);
    try {
      const app = await window.api.invoke('apps:add', { path });
      // apps:add committed the app row. Everything after must succeed or we roll the
      // app back — otherwise a thrown tasks:add/env:setApp leaves an orphan in the DB
      // that's invisible until reload.
      try {
        // Persist name / node version / package manager. We deliberately do NOT persist
        // `defaultScript` on the app row: the task created below is the source of truth.
        // Storing default_script would let the startup backfill resurrect a task the
        // user later deletes (it seeds a task for any app that has default_script + 0 tasks).
        const patched = await window.api.invoke('apps:update', {
          id: app.id,
          patch: {
            name: name.trim() || app.name,
            nodeVersionPref: nodePref,
            packageManager: pm
          }
        });

        // Materialise the chosen script into the app's first task so Start works
        // immediately. Only if a script was actually chosen (not "don't create a task yet").
        if (defaultScript) {
          await window.api.invoke('tasks:add', {
            appId: app.id,
            patch: {
              name: defaultScript,
              commandKind: 'script',
              script: defaultScript,
              enabled: true
            }
          });
        }

        // Optional: apply pasted .env to the app scope.
        const parsed = parseDotEnv(envText);
        const keys = Object.keys(parsed);
        if (keys.length > 0) {
          const vars: EnvVar[] = keys.map((key) => ({
            id: ulid(),
            appId: app.id,
            key,
            value: parsed[key]!,
            enabled: true,
            isSecret: isSecretKey(key)
          }));
          await window.api.invoke('env:setApp', { id: app.id, vars });
        }

        onConfirm(patched);
      } catch (inner) {
        // Roll back the half-created app so we don't leave an orphan.
        try {
          await window.api.invoke('apps:remove', { id: app.id });
        } catch {
          /* best-effort rollback */
        }
        throw inner;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const scriptCount = detection ? Object.keys(detection.scripts).length : 0;
  // Only re-parse when the env text changes (was re-parsing the whole blob every keystroke).
  const envKeyCount = useMemo(
    () => (envOpen ? Object.keys(parseDotEnv(envText)).length : 0),
    [envText, envOpen]
  );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-base shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-fg-muted" />
            <h2 className="text-sm font-medium text-fg">Add app</h2>
          </div>
          <button
            onClick={onCancel}
            className="rounded-md p-1 text-fg-subtle hover:bg-surface hover:text-fg"
            title="Close without adding"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {error && (
          <ErrorBanner message={error} onDismiss={() => setError(null)} className="m-3 rounded-md" />
        )}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="mb-4">
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle">Path</div>
            <div className="mt-0.5 truncate font-mono text-xs text-fg-muted">{path}</div>
          </div>

          {!detection ? (
            <div className="text-sm text-fg-subtle">Detecting…</div>
          ) : (
            <>
              <div className="mb-5 grid grid-cols-2 gap-3 text-xs">
                <Detected
                  label="Detected scripts"
                  value={scriptCount > 0 ? `${scriptCount} found` : 'none'}
                />
                <Detected
                  label=".env files"
                  value={detection.envFiles.length > 0 ? detection.envFiles.join(', ') : 'none'}
                />
              </div>

              <Row label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
                />
              </Row>

              <Row
                label="Node version"
                hint={
                  detection.nodeVersionFromProject
                    ? `Project pins ${detection.nodeVersionFromProject} (.nvmrc / engines) — "Auto" uses it.`
                    : 'No project pin found — "Auto" falls back to your latest installed.'
                }
              >
                <NodeVersionPicker value={nodePref} onChange={(v) => setNodePref(v ?? { kind: 'auto' })} />
              </Row>

              <Row
                label="Package manager"
                hint={
                  detection.packageManager
                    ? `Detected ${detection.packageManager} from lockfile / packageManager field.`
                    : 'Nothing detected — defaults to npm at run time.'
                }
              >
                <select
                  value={pm ?? ''}
                  onChange={(e) => setPm((e.target.value || null) as PackageManager | null)}
                  className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
                >
                  {PMS.map((p) => (
                    <option key={p ?? 'auto'} value={p ?? ''}>
                      {p
                        ? `${p}${detection.packageManager === p ? ' (detected)' : ''}`
                        : 'Auto-detect each run'}
                    </option>
                  ))}
                </select>
              </Row>

              {scriptCount > 0 ? (
                <Row
                  label="Default script → first task"
                  hint="Becomes the app's first task so you can Start immediately. Add more tasks later."
                >
                  <select
                    value={defaultScript ?? ''}
                    onChange={(e) => setDefaultScript(e.target.value || null)}
                    className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
                  >
                    <option value="">— don't create a task yet —</option>
                    {Object.entries(detection.scripts).map(([k, v]) => (
                      <option key={k} value={k}>
                        {k} — {v}
                      </option>
                    ))}
                  </select>
                </Row>
              ) : (
                <Row label="Tasks" hint="No package.json scripts found. Add a task (script or custom command) after creating.">
                  <span className="text-xs text-fg-subtle">No scripts detected.</span>
                </Row>
              )}

              {/* Optional env paste — collapsed by default to keep the drawer light. */}
              <div className="mt-2 border-t border-surface pt-3">
                <button
                  onClick={() => setEnvOpen((v) => !v)}
                  title={envOpen ? 'Collapse environment variables' : 'Expand to paste environment variables'}
                  className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-fg-subtle hover:text-fg-muted"
                >
                  {envOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  Environment variables (optional)
                  {envKeyCount > 0 && (
                    <span className="ml-1 normal-case tracking-normal text-fg-muted">
                      · {envKeyCount} key{envKeyCount === 1 ? '' : 's'}
                    </span>
                  )}
                </button>
                {envOpen && (
                  <div className="mt-2">
                    <textarea
                      value={envText}
                      onChange={(e) => setEnvText(e.target.value)}
                      rows={5}
                      placeholder={'DATABASE_URL=postgres://…\nAPI_KEY=…\n# comments allowed'}
                      className="w-full resize-none rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-fg"
                    />
                    <p className="mt-1 text-[10px] text-fg-subtle">
                      Applied at the app scope. SECRET/TOKEN/PASSWORD/KEY/PRIVATE keys are
                      auto-masked. You can edit these later under Env.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-2">
          <button
            onClick={onCancel}
            className="rounded-md px-2.5 py-1 text-sm text-fg-muted hover:bg-surface"
          >
            Cancel
          </button>
          <button
            onClick={() => void add()}
            disabled={adding || !detection}
            className="rounded-md bg-accent px-2.5 py-1 text-sm text-accent-fg hover:bg-accent/90 disabled:opacity-50"
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="mb-4">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-subtle">{label}</div>
      {children}
      {hint && <p className="mt-1 text-[10px] text-fg-subtle">{hint}</p>}
    </div>
  );
}

function Detected({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">{label}</div>
      <div className="mt-0.5 truncate font-mono text-xs text-fg">{value}</div>
    </div>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
