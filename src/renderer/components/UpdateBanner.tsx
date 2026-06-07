import { useEffect, useState } from 'react';
import { Download, RefreshCw, X } from 'lucide-react';

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'available'; version: string; percent: number }
  | { kind: 'ready'; version: string };

/**
 * Floating bottom-right banner that surfaces updater events.
 *
 *   update:available  → "Downloading vX.Y.Z…"
 *   update:ready      → "vX.Y.Z is ready. [Quit & Install]"
 *
 * Dismissed locally; reappears on the next update.
 */
export function UpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const offA = window.api.on('update:available', ({ version }) => {
      setDismissed(false);
      setState({ kind: 'available', version, percent: 0 });
    });
    const offP = window.api.on('update:progress', ({ percent }) => {
      setState((s) => (s.kind === 'available' ? { ...s, percent } : s));
    });
    const offR = window.api.on('update:ready', ({ version }) => {
      setDismissed(false);
      setState({ kind: 'ready', version });
    });
    return () => {
      offA();
      offP();
      offR();
    };
  }, []);

  if (state.kind === 'idle' || dismissed) return null;

  return (
    <div className="pointer-events-auto fixed bottom-4 right-4 z-30 flex items-center gap-3 rounded-md border border-accent/40 bg-base px-3 py-2 text-xs text-fg shadow-lg">
      {state.kind === 'available' ? (
        <>
          <Download className="h-3.5 w-3.5 text-accent" />
          <span>
            Downloading <strong>v{state.version}</strong>… {state.percent > 0 ? `${state.percent}%` : ''}
          </span>
        </>
      ) : (
        <>
          <RefreshCw className="h-3.5 w-3.5 text-accent" />
          <span>
            Update <strong>v{state.version}</strong> ready
          </span>
          <button
            onClick={() => void window.api.invoke('update:install', undefined)}
            className="rounded-md bg-accent px-2 py-0.5 text-[11px] text-accent-fg hover:bg-accent/90"
          >
            Quit & install
          </button>
        </>
      )}
      <button
        onClick={() => setDismissed(true)}
        className="rounded p-0.5 text-fg-subtle hover:bg-surface hover:text-fg"
        title="Dismiss this update notice"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
