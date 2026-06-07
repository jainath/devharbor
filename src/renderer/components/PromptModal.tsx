import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle } from 'lucide-react';

/**
 * Lightweight in-app dialogs — replace `window.prompt()` / `window.confirm()`,
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

/**
 * Mount once at the root. Renders nothing until openPrompt()/openConfirm() is awaited.
 * Backwards-compatible alias `PromptModalHost` is exported below.
 */
export function DialogHost(): JSX.Element | null {
  const [state, setState] = useState<DialogState | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    openPromptImpl = (args) =>
      new Promise<string | null>((resolve) => {
        setValue(args.defaultValue ?? '');
        setError(null);
        setState({ ...args, mode: 'prompt', resolve });
      });
    openConfirmImpl = (args) =>
      new Promise<boolean>((resolve) => {
        setState({ ...args, mode: 'confirm', resolve });
      });
    return () => {
      openPromptImpl = null;
      openConfirmImpl = null;
    };
  }, []);

  // Focus the input (prompt) or the confirm button (confirm) when shown.
  useEffect(() => {
    if (!state) return;
    requestAnimationFrame(() => {
      if (state.mode === 'prompt') {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        confirmBtnRef.current?.focus();
      }
    });
  }, [state]);

  if (!state) return null;

  const cancel = (): void => {
    if (state.mode === 'prompt') state.resolve(null);
    else state.resolve(false);
    setState(null);
  };

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
    setState(null);
  };

  const confirmConfirm = (): void => {
    if (state.mode !== 'confirm') return;
    state.resolve(true);
    setState(null);
  };

  const danger = state.mode === 'confirm' && state.danger;
  const confirmBtnClass = danger
    ? 'rounded-md border border-danger-border bg-danger-bg px-3 py-1 text-sm text-danger-fg hover:bg-danger-bg-hover'
    : 'rounded-md bg-accent px-3 py-1 text-sm text-accent-fg hover:bg-accent/90';

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
        if (e.key === 'Enter' && state.mode === 'confirm') {
          e.preventDefault();
          confirmConfirm();
        }
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-base shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            {danger && <AlertTriangle className="h-4 w-4 text-danger-fg" />}
            <h3 className="text-sm font-medium text-fg">{state.title}</h3>
          </div>
          <button
            onClick={cancel}
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
            onClick={cancel}
            className="rounded-md px-2.5 py-1 text-sm text-fg-muted hover:bg-surface"
          >
            {state.mode === 'confirm' ? state.cancelLabel ?? 'Cancel' : 'Cancel'}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={state.mode === 'prompt' ? confirmPrompt : confirmConfirm}
            className={confirmBtnClass}
          >
            {state.confirmLabel ?? 'Confirm'}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}

/** Backwards-compatible alias — App.tsx mounts this. */
export const PromptModalHost = DialogHost;
