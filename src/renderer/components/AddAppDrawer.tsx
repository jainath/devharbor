import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, FolderOpen, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
import type { App, DetectionResult, NodeVersionPref, PackageManager } from '@shared/types';
import type { CreateAppInput, CreateTaskSpec } from '@shared/ipc';
import { parseDotEnv, isSecretKey } from '@shared/dotenv';
import { ErrorBanner } from './ErrorBanner';
import { NodeVersionPicker } from './NodeVersionPicker';
import { cn } from '../lib/cn';
import { basename } from '../lib/processState';
import { useDialog } from '../hooks/useDialog';
import { invokeOrToast } from '../lib/invoke';

/** Stable id for the dialog heading so aria-labelledby can point at it. */
const TITLE_ID = 'add-app-title';

const PMS: (PackageManager | null)[] = [null, 'npm', 'yarn', 'pnpm', 'bun'];

/**
 * Add-app screen - a single, progressively-disclosed form (not a wizard).
 *
 * You browse for a project folder first; an inline error appears if it's already
 * registered. Once a valid, not-yet-added folder is detected, the rest of the form reveals:
 * how it runs (Node version, package manager, default script → first task) and an optional
 * environment-variables section. Each section carries a short "why this matters" hint so a
 * newcomer sees the whole shape of an app at once, while a regular adds in seconds.
 *
 * The chosen default script is materialised into a real Task on add (so the app is
 * immediately startable). The whole add is a SINGLE `apps:create` invoke - main commits the
 * app + first task + env vars in one DB transaction, so a thrown step can never leave an
 * orphan app row (no renderer-side rollback to get wrong).
 */
export function AddAppDrawer({
  initialPath,
  autoDetectInitial = true,
  onCancel,
  onConfirm
}: {
  /** Pre-selected folder (e.g. from a devharbor:// deep link). Otherwise the user browses. */
  initialPath?: string | null;
  /**
   * Whether to immediately validate + detect `initialPath` on open. False for paths that
   * arrived from an untrusted source (a devharbor:// deep link) - we prefill but require an
   * explicit "Scan this folder" click before touching the filesystem, so a web page can't
   * make DevHarbor probe arbitrary directories without a user gesture (IMPROVEMENT-PLAN 6.6).
   */
  autoDetectInitial?: boolean;
  onCancel: () => void;
  onConfirm: (app: App) => void;
}): JSX.Element {
  const [path, setPath] = useState<string | null>(initialPath ?? null);
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [nodePref, setNodePref] = useState<NodeVersionPref>({ kind: 'auto' });
  const [pm, setPm] = useState<PackageManager | null>(null);
  const [defaultScript, setDefaultScript] = useState<string | null>(null);
  // When a monorepo is detected, the user can opt to materialise one task per workspace package
  // instead of a single start-script task (IMPROVEMENT-PLAN 14.4).
  const [perWorkspaceTasks, setPerWorkspaceTasks] = useState(false);
  const [envText, setEnvText] = useState('');
  const [envOpen, setEnvOpen] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Focus trap / Escape-to-close / focus-restore + role=dialog wiring shared with every drawer.
  const { dialogProps } = useDialog(onCancel, TITLE_ID);

  // Validate + detect a freshly chosen folder. Sets the inline path error if it's already
  // registered; otherwise runs detection to fill in sensible defaults.
  const choosePath = useCallback(async (p: string): Promise<void> => {
    setError(null);
    setPathError(null);
    setDetection(null);
    setPath(p);
    setName(basename(p));
    try {
      const existing = await window.api.invoke('apps:findByPath', { path: p });
      if (existing) {
        setPathError(`This folder is already added as “${existing.name}”.`);
        return;
      }
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setDetecting(true);
    try {
      const d = await window.api.invoke('apps:detect', { path: p });
      setDetection(d);
      setDefaultScript(d.suggestedDefaultScript);
      setPm(d.packageManager);
      // A fresh scan starts opted-out; the user re-opts per folder if it's a monorepo.
      setPerWorkspaceTasks(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDetecting(false);
    }
  }, []);

  // A trusted pre-filled folder is validated immediately. An untrusted one (deep link) is
  // only prefilled - the user must click "Scan this folder" before any filesystem read.
  useEffect(() => {
    if (initialPath && autoDetectInitial) void choosePath(initialPath);
  }, [initialPath, autoDetectInitial, choosePath]);

  const browse = async (): Promise<void> => {
    const p = await window.api.invoke('dialog:browse', undefined);
    if (p) await choosePath(p);
  };

  const scriptCount = detection ? Object.keys(detection.scripts).length : 0;
  const envKeyCount = useMemo(() => Object.keys(parseDotEnv(envText)).length, [envText]);

  // Monorepo workspace packages that have at least one runnable script. Packages with no
  // scripts can't be materialised into a startable task, so we exclude them from both the
  // count shown to the user and the apps:create payload below.
  const workspaces = detection?.workspaces ?? [];
  const runnableWorkspaces = useMemo(
    // Derive from `detection` inside the memo so the dep array is exactly [detection]; the
    // `workspaces` const above is just a render-time convenience for the JSX below.
    () => (detection?.workspaces ?? []).filter((ws) => (ws.suggestedScript ?? ws.scripts[0]) != null),
    [detection]
  );

  // Ready to add once a valid, not-already-added folder has finished detecting.
  const ready = !!path && !pathError && !detecting && detection != null;

  const add = async (): Promise<void> => {
    if (!path || !ready) return;
    setError(null);
    setAdding(true);

    // Monorepo mode: the workspace packages ARE the tasks (one task per package, each pinned
    // to its subdir via workingDirOverride), so we send `tasks` and clear firstTask. Otherwise
    // keep the single start-script-as-first-task behavior.
    const useWorkspaceTasks = perWorkspaceTasks && runnableWorkspaces.length > 0;
    const tasks: CreateTaskSpec[] | undefined = useWorkspaceTasks
      ? runnableWorkspaces.map((ws) => ({
          name: ws.name || ws.relPath,
          commandKind: 'script',
          script: ws.suggestedScript ?? ws.scripts[0],
          workingDirOverride: ws.relPath
        }))
      : undefined;

    // One atomic create: main commits app + first task + env vars in a single transaction,
    // so a failure mid-way can never strand an orphan app row (was a 4-call add + rollback).
    const input: CreateAppInput = {
      path,
      name: name.trim() || undefined,
      nodeVersionPref: nodePref,
      packageManager: pm,
      defaultScript: defaultScript ?? null,
      firstTask: useWorkspaceTasks
        ? null
        : defaultScript
          ? { name: defaultScript, commandKind: 'script', script: defaultScript }
          : null,
      tasks,
      envVars: Object.entries(parseDotEnv(envText)).map(([key, value]) => ({
        key,
        value,
        isSecret: isSecretKey(key)
      }))
    };

    const app = await invokeOrToast('apps:create', input, { context: 'Add failed' });
    setAdding(false);
    if (app) onConfirm(app);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
      <div
        {...dialogProps}
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-base shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id={TITLE_ID} className="text-sm font-medium text-fg">
            Add app
          </h2>
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
          {/* 1 - Project folder */}
          <SectionHeader
            n={1}
            title="Project folder"
            desc="Pick the root of a Node.js project - the folder with its package.json. DevHarbor reads it to fill in smart defaults below."
          />
          <button
            onClick={() => void browse()}
            data-autofocus
            className={cn(
              'flex w-full items-center gap-2 rounded-md border bg-surface px-3 py-2 text-sm hover:border-border-strong',
              pathError ? 'border-danger-border' : 'border-border'
            )}
          >
            <FolderOpen className="h-4 w-4 shrink-0 text-fg-muted" />
            {path ? (
              <span className="min-w-0 flex-1 truncate text-left font-mono text-xs text-fg">{path}</span>
            ) : (
              <span className="flex-1 text-left text-fg-subtle">Browse for a folder…</span>
            )}
            <span className="shrink-0 rounded bg-elevated px-1.5 py-0.5 text-[10px] text-fg-muted">
              {path ? 'Change' : 'Browse'}
            </span>
          </button>
          {pathError && (
            <p className="mt-1.5 flex items-center gap-1 text-[11px] text-danger-fg">
              <AlertCircle className="h-3 w-3 shrink-0" /> {pathError}
            </p>
          )}
          {/* Deep-link path: require an explicit gesture before detecting (no auto fs read). */}
          {path && !detection && !detecting && !pathError && (
            <button
              onClick={() => void choosePath(path)}
              className="mt-2 rounded-md border border-border bg-surface px-2.5 py-1 text-xs text-fg hover:border-border-strong"
            >
              Scan this folder
            </button>
          )}
          {detecting && <p className="mt-2 text-sm text-fg-subtle">Detecting…</p>}

          {/* Everything below reveals once a valid folder is detected. */}
          {ready && detection && (
            <>
              {/* What we found - teaches by showing. */}
              <div className="mt-3 grid grid-cols-3 gap-3 rounded-md border border-border bg-base/50 p-3 text-xs">
                <Found label="Scripts" value={scriptCount > 0 ? `${scriptCount} found` : 'none'} />
                <Found
                  label="Package mgr"
                  value={detection.packageManager ?? 'not detected'}
                />
                <Found
                  label=".env files"
                  value={detection.envFiles.length ? detection.envFiles.join(', ') : 'none'}
                />
              </div>

              {/* No package.json here: auto-detection can't help, but the folder is still
                  addable as a custom-command app - warn, don't block (IMPROVEMENT-PLAN 10.2). */}
              {!detection.hasPackageJson && (
                <p className="mt-2 flex items-start gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] leading-snug text-fg-muted">
                  <AlertCircle className="mt-px h-3 w-3 shrink-0 text-fg-subtle" />
                  <span>
                    No package.json found here - you can still add it and run custom shell
                    commands, but auto-detection won&apos;t help.
                  </span>
                </p>
              )}

              {/* 2 - How it runs */}
              <div className="mt-6">
                <SectionHeader
                  n={2}
                  title="How it runs"
                  desc="Sensible defaults are pre-filled from your project - adjust if you like."
                />
                <Row label="Name">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={60}
                    className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
                  />
                </Row>

                <Row
                  label="Node version"
                  hint={
                    detection.nodeVersionFromProject
                      ? `“Auto” follows your project's pin (${detection.nodeVersionFromProject} from .nvmrc / engines).`
                      : '“Auto” falls back to your latest installed Node. DevHarbor reads nvm / fnm / volta / asdf.'
                  }
                >
                  <NodeVersionPicker value={nodePref} onChange={(v) => setNodePref(v ?? { kind: 'auto' })} />
                </Row>

                <Row
                  label="Package manager"
                  hint={
                    detection.packageManager
                      ? `Detected ${detection.packageManager} from the lockfile / packageManager field.`
                      : 'Nothing detected - defaults to npm at run time.'
                  }
                >
                  <select
                    value={pm ?? ''}
                    onChange={(e) => setPm((e.target.value || null) as PackageManager | null)}
                    className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
                  >
                    {PMS.map((p) => (
                      <option key={p ?? 'auto'} value={p ?? ''}>
                        {p ? `${p}${detection.packageManager === p ? ' (detected)' : ''}` : 'Auto-detect each run'}
                      </option>
                    ))}
                  </select>
                </Row>

                {scriptCount > 0 ? (
                  <Row
                    label="Start script → first task"
                    hint="This becomes the app's first task, so you can Start it right away. Add more tasks anytime."
                  >
                    <select
                      value={defaultScript ?? ''}
                      onChange={(e) => setDefaultScript(e.target.value || null)}
                      className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
                    >
                      <option value=""> - don't create a task yet - </option>
                      {Object.entries(detection.scripts).map(([k, v]) => (
                        <option key={k} value={k}>
                          {k} - {v}
                        </option>
                      ))}
                    </select>
                  </Row>
                ) : (
                  <Row
                    label="Tasks"
                    hint="No package.json scripts found. You can add a task (a script or any shell command) after creating the app."
                  >
                    <span className="text-xs text-fg-subtle">No scripts detected.</span>
                  </Row>
                )}

                {/* Monorepo offer - when workspace packages are detected, let the user create
                    one task per package (each pinned to its subdir) instead of a single start
                    task. Only packages with a runnable script become tasks (IMPROVEMENT-PLAN 14.4). */}
                {workspaces.length > 0 && (
                  <div className="mb-4 rounded-md border border-border bg-base/50 p-3">
                    <div className="text-xs font-medium text-fg">
                      Monorepo detected - {workspaces.length} workspace package
                      {workspaces.length === 1 ? '' : 's'} found
                    </div>
                    <label className="mt-2 flex items-start gap-2 text-xs text-fg-muted">
                      <input
                        type="checkbox"
                        checked={perWorkspaceTasks}
                        onChange={(e) => setPerWorkspaceTasks(e.target.checked)}
                        disabled={runnableWorkspaces.length === 0}
                        className="mt-0.5 shrink-0 accent-accent"
                      />
                      <span>
                        Create a task per workspace package
                        {runnableWorkspaces.length === 0 && (
                          <span className="text-fg-subtle"> - none have runnable scripts</span>
                        )}
                      </span>
                    </label>
                    {perWorkspaceTasks && runnableWorkspaces.length > 0 && (
                      <p className="mt-1.5 pl-6 text-[10px] text-fg-subtle">
                        {runnableWorkspaces.length} task
                        {runnableWorkspaces.length === 1 ? '' : 's'} will be created, one per
                        package with a script
                        {runnableWorkspaces.length < workspaces.length &&
                          ` (${workspaces.length - runnableWorkspaces.length} skipped - no scripts)`}
                        . The start-script task above is skipped.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* 3 - Environment variables (optional, collapsed) */}
              <div className="mt-6">
                <SectionHeader
                  n={3}
                  title="Environment variables"
                  desc="Optional. DevHarbor already watches .env files in your project - paste here only to seed app-level variables now."
                />
                <button
                  onClick={() => setEnvOpen((v) => !v)}
                  className="flex w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] text-fg-muted hover:text-fg"
                >
                  {envOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  Paste a .env blob
                  {envKeyCount > 0 && (
                    <span className="ml-auto text-fg-muted">
                      {envKeyCount} key{envKeyCount === 1 ? '' : 's'}
                    </span>
                  )}
                </button>
                {envOpen && (
                  <div className="mt-2">
                    <textarea
                      value={envText}
                      onChange={(e) => setEnvText(e.target.value)}
                      rows={6}
                      placeholder={'DATABASE_URL=postgres://…\nAPI_KEY=…\n# comments allowed'}
                      className="w-full resize-none rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-fg"
                    />
                    <p className="mt-1 text-[10px] text-fg-subtle">
                      SECRET/TOKEN/PASSWORD/KEY/PRIVATE keys are auto-masked. Edit later under Env.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-2">
          <button onClick={onCancel} className="rounded-md px-2.5 py-1 text-sm text-fg-muted hover:bg-surface">
            Cancel
          </button>
          <button
            onClick={() => void add()}
            disabled={!ready || adding}
            title={ready ? undefined : 'Pick a valid, not-yet-added folder first'}
            className="rounded-md bg-accent px-3 py-1 text-sm text-accent-fg hover:bg-accent/90 disabled:opacity-50"
          >
            {adding ? 'Adding…' : 'Add app'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function SectionHeader({ n, title, desc }: { n: number; title: string; desc: string }): JSX.Element {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2">
        <span className="inline-grid h-4 w-4 place-items-center rounded-full bg-elevated text-[10px] font-semibold text-fg-muted">
          {n}
        </span>
        <span className="text-sm font-medium text-fg">{title}</span>
      </div>
      <p className="mt-0.5 pl-6 text-[11px] leading-snug text-fg-subtle">{desc}</p>
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

function Found({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">{label}</div>
      <div className="mt-0.5 truncate font-mono text-xs text-fg" title={value}>
        {value}
      </div>
    </div>
  );
}
