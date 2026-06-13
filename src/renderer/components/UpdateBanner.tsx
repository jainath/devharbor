import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Download, RefreshCw, X } from 'lucide-react';

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'available'; version: string; percent: number; releaseNotes?: string }
  | { kind: 'ready'; version: string; releaseNotes?: string }
  | { kind: 'error'; message: string }
  // Only shown when the user explicitly asked ("Check for Updates…"); the passive boot
  // check stays silent so we don't nag on every launch.
  | { kind: 'upToDate'; version: string };

/**
 * Floating bottom-right banner that surfaces updater events.
 *
 *   update:available    → "Downloading vX.Y.Z…" (+ optional release notes)
 *   update:ready        → "vX.Y.Z is ready. [Quit & Install]" (+ optional release notes)
 *   update:error        → "Update check failed: <message>" (dismissible)
 *   update:notAvailable → "You're up to date" ONLY if a manual check is in flight
 *
 * Dismissed locally; reappears on the next update.
 */
export function UpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  // Expandable release-notes drawer for available/ready states.
  const [notesOpen, setNotesOpen] = useState(false);
  // Mirror of state.kind for the event listeners (registered once, so they can't read state).
  const kindRef = useRef<UpdateState['kind']>('idle');
  kindRef.current = state.kind;

  useEffect(() => {
    // A manual "Check for Updates…" is in flight. update:check is fired from App.tsx on the
    // same menu:checkUpdates event, so the banner can independently tell a user-initiated
    // check (worth a "You're up to date" confirmation) from the silent periodic/boot check.
    let manualCheckPending = false;
    const offMenuCheck = window.api.on('menu:checkUpdates', () => {
      manualCheckPending = true;
    });

    const offA = window.api.on('update:available', ({ version, releaseNotes }) => {
      manualCheckPending = false;
      setDismissed(false);
      setNotesOpen(false);
      setState({ kind: 'available', version, percent: 0, releaseNotes });
    });
    const offP = window.api.on('update:progress', ({ percent }) => {
      setState((s) => (s.kind === 'available' ? { ...s, percent } : s));
    });
    const offR = window.api.on('update:ready', ({ version, releaseNotes }) => {
      manualCheckPending = false;
      setDismissed(false);
      setState({ kind: 'ready', version, releaseNotes });
    });
    const offErr = window.api.on('update:error', ({ message }) => {
      // Passive boot/periodic checks fail routinely (offline, rate-limited) - surfacing each
      // one would nag every 6h on a plane, so those stay in the local log only. But a failure
      // while a DOWNLOAD is showing must always surface, or the banner would sit frozen on
      // "Downloading vX… 37%" forever. Manual check failures always surface too.
      const downloadInFlight = kindRef.current === 'available';
      if (!manualCheckPending && !downloadInFlight) return;
      manualCheckPending = false;
      setDismissed(false);
      setState({ kind: 'error', message });
    });
    const offNA = window.api.on('update:notAvailable', ({ version }) => {
      // Silent on the passive boot/periodic check - only confirm when the user asked.
      if (!manualCheckPending) return;
      manualCheckPending = false;
      setDismissed(false);
      setState({ kind: 'upToDate', version });
    });

    return () => {
      offMenuCheck();
      offA();
      offP();
      offR();
      offErr();
      offNA();
    };
  }, []);

  if (state.kind === 'idle' || dismissed) return null;

  // Release notes are present only on available/ready; keep the toggle out of error/upToDate.
  const releaseNotes =
    state.kind === 'available' || state.kind === 'ready' ? state.releaseNotes?.trim() : undefined;

  return (
    <div className="pointer-events-auto fixed bottom-4 right-4 z-30 flex max-w-sm flex-col gap-2 rounded-md border border-accent/40 bg-base px-3 py-2 text-xs text-fg shadow-lg">
      <div className="flex items-center gap-3">
        {state.kind === 'available' && (
          <>
            <Download className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="flex-1">
              Downloading <strong>v{state.version}</strong>…{' '}
              {state.percent > 0 ? `${state.percent}%` : ''}
            </span>
          </>
        )}

        {state.kind === 'ready' && (
          <>
            <RefreshCw className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="flex-1">
              Update <strong>v{state.version}</strong> ready
            </span>
            <button
              onClick={() => void window.api.invoke('update:install', undefined)}
              className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-[11px] text-accent-fg hover:bg-accent/90"
            >
              Quit & install
            </button>
          </>
        )}

        {state.kind === 'error' && (
          <>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger-fg" />
            <span className="flex-1">
              Update check failed: <span className="text-fg-muted">{state.message}</span>
            </span>
          </>
        )}

        {state.kind === 'upToDate' && (
          <>
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="flex-1">
              You&rsquo;re up to date <span className="text-fg-subtle">(v{state.version})</span>
            </span>
          </>
        )}

        {/* Release-notes toggle - only when notes exist, so the user can preview what
            they're installing before "Quit & install". */}
        {releaseNotes && (
          <button
            onClick={() => setNotesOpen((v) => !v)}
            className="shrink-0 rounded p-0.5 text-fg-subtle hover:bg-surface hover:text-fg"
            title={notesOpen ? 'Hide release notes' : "Show what's new"}
            aria-expanded={notesOpen}
            aria-label="Toggle release notes"
          >
            {notesOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        )}

        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded p-0.5 text-fg-subtle hover:bg-surface hover:text-fg"
          title="Dismiss this update notice"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {releaseNotes && notesOpen && (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap border-t border-border pt-2 text-[11px] leading-relaxed text-fg-muted">
          {releaseNotes}
        </div>
      )}
    </div>
  );
}
