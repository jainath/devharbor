import { useEffect, useState } from 'react';
import { X, Download, AlertTriangle } from 'lucide-react';
import type { NodeInstallation } from '@shared/types';
import type { SettingsState } from '@shared/ipc';
import { ErrorBanner } from './ErrorBanner';
import { openConfirm } from './PromptModal';
import { useDialog } from '../hooks/useDialog';
import { cn } from '../lib/cn';

/** id linking the dialog panel (aria-labelledby) to its visible heading for screen readers. */
const SETTINGS_TITLE_ID = 'settings-drawer-title';

export function SettingsDrawer({ onClose }: { onClose: () => void }): JSX.Element {
  // Focus trap / Escape-to-close / focus-restore + role=dialog/aria-modal/aria-labelledby.
  const { dialogProps } = useDialog(onClose, SETTINGS_TITLE_ID);
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nodeInstalls, setNodeInstalls] = useState<NodeInstallation[]>([]);
  const [dbPath, setDbPath] = useState<string>('');
  const [exported, setExported] = useState<string | null>(null);

  useEffect(() => {
    void window.api.invoke('settings:get', undefined).then(setSettings);
    void window.api.invoke('node:list', undefined).then(setNodeInstalls);
    void window.api.invoke('db:path', undefined).then(setDbPath);
  }, []);

  const update = async (patch: Partial<SettingsState>): Promise<void> => {
    setError(null);
    try {
      const next = await window.api.invoke('settings:set', { patch });
      setSettings(next);
      // Notify other parts of the renderer that may be observing settings (e.g. useTheme).
      window.dispatchEvent(new CustomEvent('settings-changed'));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
      <div
        {...dialogProps}
        className="flex h-full max-h-[680px] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-base shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id={SETTINGS_TITLE_ID} className="text-sm font-medium text-fg">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-fg-subtle hover:bg-surface hover:text-fg"
            title="Close settings"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {error && (
          <ErrorBanner
            message={error}
            onDismiss={() => setError(null)}
            className="m-3 rounded-md"
          />
        )}

        <div className="flex-1 overflow-y-auto p-5">
          {!settings ? (
            <div className="text-sm text-fg-subtle">Loading…</div>
          ) : (
            <div className="space-y-6">
              <Section title="General">
                <Field label="Theme" description="Color scheme for the UI.">
                  <select
                    data-autofocus
                    value={settings.theme}
                    onChange={(e) =>
                      void update({ theme: e.target.value as SettingsState['theme'] })
                    }
                    className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
                  >
                    <option value="system">System</option>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                  </select>
                </Field>
                <Toggle
                  label="Check for updates on launch"
                  description="Automatically download and install new DevHarbor releases."
                  checked={settings.auto_update}
                  onChange={(v) => void update({ auto_update: v })}
                />
                <Toggle
                  label="Launch DevHarbor at login"
                  description="Start DevHarbor automatically when you log in to your Mac."
                  checked={settings.launch_at_login}
                  onChange={(v) => void update({ launch_at_login: v })}
                />
                <Toggle
                  label="Show menubar icon"
                  description="Keep a tray icon in the macOS menubar for quick access and background control."
                  checked={settings.tray_enabled}
                  onChange={(v) => void update({ tray_enabled: v })}
                />
              </Section>

              <Section title="Notifications">
                <Toggle
                  label="Notify when an app crashes"
                  description="Show a desktop notification when a task exits unexpectedly while DevHarbor is backgrounded."
                  checked={settings.notify_on_crash}
                  onChange={(v) => void update({ notify_on_crash: v })}
                />
                <Toggle
                  label="Notify when an app is ready"
                  description="Show a desktop notification when an app finishes starting (readiness reached)."
                  checked={settings.notify_on_ready}
                  onChange={(v) => void update({ notify_on_ready: v })}
                />
              </Section>

              <Section title="Dashboard">
                <Field
                  label="Stats refresh interval"
                  description="How often CPU/memory are sampled per task (in ms). Lower = smoother sparklines, more CPU."
                >
                  <NumberInput
                    value={settings.dashboard_refresh_ms}
                    onCommit={(v) => void update({ dashboard_refresh_ms: clamp(v, 200, 10000) })}
                    suffix="ms"
                    step={100}
                    min={200}
                    max={10000}
                  />
                </Field>
              </Section>

              <Section title="Logs">
                <Field
                  label="Ring buffer size"
                  description="Per-task in-memory log lines. Older lines drop off the front."
                >
                  <NumberInput
                    value={settings.log_ring_size}
                    onCommit={(v) => void update({ log_ring_size: clamp(v, 100, 100000) })}
                    suffix="lines"
                    step={1000}
                    min={100}
                    max={100000}
                  />
                </Field>
                <Field
                  label="Keep run history per app"
                  description="Maximum run_history rows retained per app. Older rows are pruned on boot."
                >
                  <NumberInput
                    value={settings.run_history_limit}
                    onCommit={(v) => void update({ run_history_limit: clamp(v, 10, 10000) })}
                    suffix="runs"
                    step={50}
                    min={10}
                    max={10000}
                  />
                </Field>
              </Section>

              <Section title="Processes">
                <Field
                  label="Kill grace window"
                  description="After Stop, how long to wait (ms) for SIGTERM to take effect before escalating to SIGKILL on the process group."
                >
                  <NumberInput
                    value={settings.kill_grace_ms}
                    onCommit={(v) => void update({ kill_grace_ms: clamp(v, 100, 30000) })}
                    suffix="ms"
                    step={500}
                    min={100}
                    max={30000}
                  />
                </Field>
                <Field
                  label="Readiness timeout"
                  description="Abort a task's start if its readiness signal hasn't fired within this many ms."
                >
                  <NumberInput
                    value={settings.readiness_timeout_ms}
                    onCommit={(v) => void update({ readiness_timeout_ms: clamp(v, 1000, 600000) })}
                    suffix="ms"
                    step={1000}
                    min={1000}
                    max={600000}
                  />
                </Field>
              </Section>

              <Section title="Node detection">
                <div className="text-[11px] text-fg-subtle">
                  Installations discovered on this machine (read-only - the list is rescanned every
                  time an app starts). To add a new version, install it via your usual manager
                  (nvm / fnm / volta / asdf) and click an app's Start.
                </div>
                <div className="rounded-md border border-border bg-base/40 p-3">
                  {nodeInstalls.length === 0 ? (
                    <div className="text-xs text-fg-subtle">None found.</div>
                  ) : (
                    <ul className="space-y-0.5 font-mono text-[11px]">
                      {nodeInstalls.map((n) => (
                        <li key={`${n.source}-${n.version}`} className="flex items-center gap-2">
                          <span className="inline-flex w-10 text-fg-subtle">{n.source}</span>
                          <span className="font-medium text-fg">v{n.version}</span>
                          <span className="truncate text-fg-subtle">{n.binDir}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Section>

              <Section title="Danger zone">
                <div className="text-[11px] text-fg-subtle">
                  Database lives at <span className="font-mono">{dbPath}</span>
                </div>
                {exported && (
                  <div className="rounded-md border border-success-border bg-success-bg px-2 py-1 text-[11px] text-success-fg">
                    Exported to <span className="font-mono">{exported}</span>
                  </div>
                )}
                <Field
                  label="Export database"
                  description="Copy the current devharbor.db to a file. Includes app registry, tasks, env vars, run history, settings."
                >
                  <button
                    onClick={async () => {
                      setError(null);
                      try {
                        const p = await window.api.invoke('db:export', undefined);
                        if (p) setExported(p);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg hover:bg-elevated"
                  >
                    <Download className="h-3.5 w-3.5" /> Export…
                  </button>
                </Field>
                <Field
                  label="Reset database"
                  description="Move the DB aside and restart with an empty one. Existing files on disk are untouched; you'll need to re-add your apps. A backup is created alongside."
                >
                  <button
                    onClick={async () => {
                      const ok = await openConfirm({
                        title: 'Reset database?',
                        description:
                          'This will close DevHarbor, archive the current database, and restart with an empty one. A backup is created alongside. Files on disk are untouched, but you will need to re-add your apps.',
                        confirmLabel: 'Reset database',
                        danger: true
                      });
                      if (!ok) return;
                      try {
                        await window.api.invoke('db:reset', undefined);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-danger-border bg-danger-bg px-2 py-1 text-sm text-danger-fg hover:bg-danger-bg-hover"
                  >
                    <AlertTriangle className="h-3.5 w-3.5" /> Reset…
                  </button>
                </Field>
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section>
      <h3 className="mb-2 text-[11px] uppercase tracking-wider text-fg-subtle">{title}</h3>
      <div className="space-y-4 rounded-md border border-border bg-base/50 p-4">
        {children}
      </div>
    </section>
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

function Toggle({
  label,
  description,
  checked,
  onChange
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <Field label={label} description={description}>
      <button
        onClick={() => onChange(!checked)}
        className={cn(
          'inline-flex h-5 w-9 items-center rounded-full transition-colors',
          checked ? 'bg-accent' : 'bg-elevated'
        )}
        aria-pressed={checked}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 rounded-full bg-white transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5'
          )}
        />
      </button>
    </Field>
  );
}

function NumberInput({
  value,
  onCommit,
  suffix,
  step = 1,
  min,
  max
}: {
  value: number;
  onCommit: (v: number) => void;
  suffix?: string;
  step?: number;
  min?: number;
  max?: number;
}): JSX.Element {
  const [local, setLocal] = useState(String(value));
  useEffect(() => setLocal(String(value)), [value]);
  return (
    <div className="inline-flex items-center gap-1">
      <input
        type="number"
        value={local}
        step={step}
        min={min}
        max={max}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const n = Number(local);
          if (!Number.isNaN(n) && n !== value) onCommit(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-right text-sm text-fg"
      />
      {suffix && <span className="text-[11px] text-fg-subtle">{suffix}</span>}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
