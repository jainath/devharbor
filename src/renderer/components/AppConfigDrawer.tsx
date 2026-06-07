import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { App, NodeVersionPref } from '@shared/types';
import { useStore } from '../store/store';
import { ErrorBanner } from './ErrorBanner';
import { NodeVersionPicker } from './NodeVersionPicker';
import { TagInput } from './TagInput';
import { FolderSelect } from './FolderSelect';
import { cn } from '../lib/cn';

const DEFAULT_GLOBS = ['src/**/*.{ts,tsx,js,jsx,mjs,cjs}'];

export function AppConfigDrawer({
  app,
  onClose
}: {
  app: App;
  onClose: () => void;
}): JSX.Element {
  const apps = useStore((s) => s.apps);
  const upsertApp = useStore((s) => s.upsertApp);
  const [name, setName] = useState(app.name);
  const [autoRestart, setAutoRestart] = useState(app.autoRestartOnChange);
  const [globsText, setGlobsText] = useState((app.watchGlobs.length ? app.watchGlobs : DEFAULT_GLOBS).join('\n'));
  const [tags, setTags] = useState<string[]>(app.tags);
  const [folder, setFolder] = useState(app.folder ?? '');
  const [nodePref, setNodePref] = useState<NodeVersionPref>(app.nodeVersionPref);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(app.name);
    setAutoRestart(app.autoRestartOnChange);
    setGlobsText((app.watchGlobs.length ? app.watchGlobs : DEFAULT_GLOBS).join('\n'));
    setTags(app.tags);
    setFolder(app.folder ?? '');
    setNodePref(app.nodeVersionPref);
  }, [
    app.id,
    app.name,
    app.autoRestartOnChange,
    app.watchGlobs,
    app.tags,
    app.folder,
    app.nodeVersionPref
  ]);

  // Autocomplete suggestions = distinct folder names across all apps, excluding empty.
  const folderSuggestions = Array.from(
    new Set(apps.map((a) => a.folder?.trim() || '').filter((f) => f))
  ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  // Tag suggestions = distinct tags across all apps.
  const tagSuggestions = Array.from(new Set(apps.flatMap((a) => a.tags))).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );

  const save = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      const watchGlobs = globsText
        .split(/\r?\n/)
        .map((g) => g.trim())
        .filter((g) => g.length > 0);
      const next = await window.api.invoke('apps:update', {
        id: app.id,
        patch: {
          name: name.trim() || app.name,
          autoRestartOnChange: autoRestart,
          watchGlobs,
          tags,
          folder: folder.trim() ? folder.trim() : null,
          nodeVersionPref: nodePref
        }
      });
      upsertApp(next);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
      <div className="flex h-full max-h-[640px] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-base shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium text-fg">App settings — {app.name}</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-fg-subtle hover:bg-surface hover:text-fg"
            title="Close app settings"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {error && (
          <ErrorBanner message={error} onDismiss={() => setError(null)} className="m-3 rounded-md" />
        )}

        <div className="flex-1 overflow-y-auto p-5">
          <div className="space-y-5">
            <Field label="Name" description="Display name in the sidebar.">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-72 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
              />
            </Field>
            <Field
              label="Tags"
              description="Free-form labels. Filter by tag in the sidebar and the ⌘P switcher to slice across folders (e.g. everything tagged “api”)."
            >
              <TagInput value={tags} onChange={setTags} suggestions={tagSuggestions} />
            </Field>
            <Field
              label="Folder"
              description="Visual grouping in the sidebar. One folder per app. Leave as “No folder” for (Ungrouped)."
            >
              <FolderSelect value={folder} options={folderSuggestions} onChange={setFolder} />
            </Field>
            <Field
              label="Node version"
              description="Default for every task in this app. `Auto` reads .nvmrc / .node-version / engines.node from the project. Tasks can override individually."
            >
              <NodeVersionPicker
                value={nodePref}
                onChange={(v) => setNodePref(v ?? { kind: 'auto' })}
              />
            </Field>

            <div className="border-t border-border pt-5">
              <Field
                label="Auto-restart on file change"
                description="When enabled, file changes matching the globs below restart the running app (debounced 500ms). Off by default."
              >
                <button
                  onClick={() => setAutoRestart((v) => !v)}
                  className={cn(
                    'inline-flex h-5 w-9 items-center rounded-full transition-colors',
                    autoRestart ? 'bg-accent' : 'bg-elevated'
                  )}
                  aria-pressed={autoRestart}
                >
                  <span
                    className={cn(
                      'inline-block h-4 w-4 rounded-full bg-white transition-transform',
                      autoRestart ? 'translate-x-4' : 'translate-x-0.5'
                    )}
                  />
                </button>
              </Field>

              <div className="mt-3">
                <div className="mb-1 text-[11px] uppercase tracking-wider text-fg-subtle">
                  Watch globs (one per line, relative to project path)
                </div>
                <textarea
                  value={globsText}
                  onChange={(e) => setGlobsText(e.target.value)}
                  rows={6}
                  className={cn(
                    'w-full resize-none rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-fg',
                    !autoRestart && 'opacity-50'
                  )}
                  disabled={!autoRestart}
                />
                <div className="mt-1 text-[10px] text-fg-subtle">
                  node_modules, .git, dist, build, .next are ignored automatically.
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-2">
          <button
            onClick={onClose}
            className="rounded-md px-2.5 py-1 text-sm text-fg-muted hover:bg-surface"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md bg-accent px-2.5 py-1 text-sm text-accent-fg hover:bg-accent/90 disabled:opacity-50"
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  description,
  children
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <div className="text-sm text-fg">{label}</div>
        {description && <div className="mt-0.5 text-[11px] text-fg-subtle">{description}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}
