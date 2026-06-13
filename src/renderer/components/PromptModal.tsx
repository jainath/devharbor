import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle } from 'lucide-react';
import { useDialog } from '../hooks/useDialog';

/**
 * Lightweight in-app dialogs - replace `window.prompt()` / `window.confirm()`,
 * which are silently no-op'd or visually inconsistent inside Electron's
 * BrowserWindow. Promise-style API:
 *
 *   const name = await openPrompt({ title: 'New folder', defaultValue: '' });
 *   const ok   = await openConfirm({ title: 'Delete?', danger: true });
 *
 * Rendered via a portal at document.body so they survive any overflow:hidden parent.
 * Mount <DialogHost /> once at the app root.
 */
export interface PromptArgs {
  title: string;
  description?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  /** Optional sync validator. Return a string error message to block confirm, or null to allow. */
  validate?: (value: string) => string | null;
}

export interface ConfirmArgs {
  title: string;
  /** Body text. Newlines render as separate lines. */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button + warning icon for destructive actions. */
  danger?: boolean;
}

let openPromptImpl: ((args: PromptArgs) => Promise<string | null>) | null = null;
let openConfirmImpl: ((args: ConfirmArgs) => Promise<boolean>) | null = null;

/** Module-level resolver. Set by <DialogHost /> when it mounts. */
export function openPrompt(args: PromptArgs): Promise<string | null> {
  if (!openPromptImpl) {
    const v = window.prompt(args.title, args.defaultValue ?? '');
    return Promise.resolve(v);
  }
  return openPromptImpl(args);
}

export function openConfirm(args: ConfirmArgs): Promise<boolean> {
  if (!openConfirmImpl) {
    return Promise.resolve(window.confirm(`${args.title}${args.description ? '\n\n' + args.description : ''}`));
  }
  return openConfirmImpl(args);
}

type PromptState = PromptArgs & { mode: 'prompt'; resolve: (v: string | null) => void };
type ConfirmState = ConfirmArgs & { mode: 'confirm'; resolve: (v: boolean) => void };
type DialogState = PromptState | ConfirmState;

// Stable id for the dialog heading so aria-labelledby can point at it.
const TITLE_ID = 'prompt-modal-title';

/**
 * The actual dialog panel. Split out from DialogHost so it mounts only while a
 * dialog is open - useDialog's effect runs on mount/unmount, which is exactly
 * the open/close lifecycle we want for its focus-into / Tab-trap / Escape /
 * focus-restore behaviour. (Mounting useDialog on the always-present DialogHost
 * would capture the wrong "previously focused" element and never restore.)
 */
function DialogPanel({
  state,
  onClose
}: {
  state: DialogState;
  onClose: () => void;
}): JSX.Element {
  const [value, setValue] = useState(state.mode === 'prompt' ? state.defaultValue ?? '' : '');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Delegates Escape (window-level capture → keeps working after focus leaves
  // the input), Tab/Shift+Tab focus trap, and focus restore on close to the
  // shared hook. onClose here means "cancel" - same as the X / backdrop click.
  // useDialog focuses the [data-autofocus] element (the input here); we follow
  // up to select its contents so a prefilled defaultValue is overwrite-ready.
  const { dialogProps } = useDialog(onClose, TITLE_ID);

  useEffect(() => {
    if (state.mode !== 'prompt') return;
    requestAnimationFrame(() => inputRef.current?.select());
  }, [state.mode]);

  const confirmPrompt = (): void => {
    if (state.mode !== 'prompt') return;
    const trimmed = value.trim();
    if (state.validate) {
      const err = state.validate(trimmed);
      if (err) {
        setError(err);
        return;
      }
    }
    if (!trimmed) {
      setError('Value cannot be empty.');
      return;
    }
    state.resolve(trimmed);
  };

  const confirmConfirm = (): void => {
    if (state.mode !== 'confirm') return;
    state.resolve(true);
  };

  const danger = state.mode === 'confirm' && state.danger;
  const confirmBtnClass = danger
    ? 'rounded-md border border-danger-border bg-danger-bg px-3 py-1 text-sm text-danger-fg hover:bg-danger-bg-hover'
    : 'rounded-md bg-accent px-3 py-1 text-sm text-accent-fg hover:bg-accent/90';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        // Enter-to-confirm for the confirm dialog (the prompt input handles its
        // own Enter). Escape/Tab are owned by useDialog at the window level.
        if (e.key === 'Enter' && state.mode === 'confirm') {
          e.preventDefault();
          confirmConfirm();
        }
      }}
    >
      <div
        {...dialogProps}
        className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-base shadow-2xl outline-none"
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            {danger && <AlertTriangle className="h-4 w-4 text-danger-fg" />}
            <h3 id={TITLE_ID} className="text-sm font-medium text-fg">
              {state.title}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-fg-subtle hover:bg-surface hover:text-fg"
            title="Cancel"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="p-4">
          {state.description && (
            <p className="mb-2 whitespace-pre-line text-xs text-fg-subtle">{state.description}</p>
          )}
          {state.mode === 'prompt' && (
            <>
              <input
                ref={inputRef}
                data-autofocus
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmPrompt();
                  }
                }}
                placeholder={state.placeholder}
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-border-strong"
              />
              {error && <p className="mt-1 text-xs text-danger-fg">{error}</p>}
            </>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-2">
          <button
            onClick={onClose}
            className="rounded-md px-2.5 py-1 text-sm text-fg-muted hover:bg-surface"
          >
            {state.mode === 'confirm' ? state.cancelLabel ?? 'Cancel' : 'Cancel'}
          </button>
          <button
            data-autofocus={state.mode === 'confirm' ? true : undefined}
            onClick={state.mode === 'prompt' ? confirmPrompt : confirmConfirm}
            className={confirmBtnClass}
          >
            {state.confirmLabel ?? 'Confirm'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Mount once at the root. Renders nothing until openPrompt()/openConfirm() is awaited.
 * Backwards-compatible alias `PromptModalHost` is exported below.
 */
export function DialogHost(): JSX.Element | null {
  const [state, setState] = useState<DialogState | null>(null);
  // Monotonic id per shown dialog: keys DialogPanel so a replacement remounts it (fresh
  // input state), and lets us detect staleness.
  const [dialogId, setDialogId] = useState(0);
  // Live mirror of `state` so the open* impls can settle a DISPLACED dialog's promise.
  // Without this, opening a second prompt/confirm while one is showing would silently drop
  // the first dialog's `resolve` and its `await` would hang forever.
  const currentRef = useRef<DialogState | null>(null);
  currentRef.current = state;

  useEffect(() => {
    const displace = (): void => {
      const prev = currentRef.current;
      if (!prev) return;
      if (prev.mode === 'prompt') prev.resolve(null);
      else prev.resolve(false);
    };
    openPromptImpl = (args) =>
      new Promise<string | null>((resolve) => {
        displace();
        setDialogId((n) => n + 1);
        setState({ ...args, mode: 'prompt', resolve });
      });
    openConfirmImpl = (args) =>
      new Promise<boolean>((resolve) => {
        displace();
        setDialogId((n) => n + 1);
        setState({ ...args, mode: 'confirm', resolve });
      });
    return () => {
      openPromptImpl = null;
      openConfirmImpl = null;
    };
  }, []);

  if (!state) return null;

  // Cancel resolves with the negative value (null / false) and closes.
  const cancel = (): void => {
    if (state.mode === 'prompt') state.resolve(null);
    else state.resolve(false);
    setState(null);
  };

  // DialogPanel resolves the positive cases directly via state.resolve, but only
  // the host can null out `state` to unmount the panel (and let useDialog restore
  // focus). So we hand the panel a state whose resolve also clears host state.
  // The ternary keeps the discriminated union intact - spreading the union as a
  // whole would widen `resolve`'s parameter to `string | null | boolean`.
  const wrapped: DialogState =
    state.mode === 'prompt'
      ? { ...state, resolve: (v: string | null) => { state.resolve(v); setState(null); } }
      : { ...state, resolve: (v: boolean) => { state.resolve(v); setState(null); } };

  return createPortal(<DialogPanel key={dialogId} state={wrapped} onClose={cancel} />, document.body);
}

/** Backwards-compatible alias - App.tsx mounts this. */
export const PromptModalHost = DialogHost;
