import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle, Info, CheckCircle2 } from 'lucide-react';

/**
 * Global, app-wide toast surface. Mount <ToastHost /> once at the app root; call
 * `pushToast(message, { kind })` from anywhere - including non-React code like the
 * `invokeOrToast` IPC helper - so failures from any view surface instead of being
 * swallowed into an unhandled promise rejection (IMPROVEMENT-PLAN 5.5).
 */
export type ToastKind = 'error' | 'info' | 'success';

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

let pushImpl: ((message: string, opts?: { kind?: ToastKind; durationMs?: number }) => void) | null =
  null;
let counter = 0;

export function pushToast(
  message: string,
  opts?: { kind?: ToastKind; durationMs?: number }
): void {
  if (pushImpl) pushImpl(message, opts);
  else console.error('[toast]', message);
}

export function ToastHost(): JSX.Element | null {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  useEffect(() => {
    pushImpl = (message, opts) => {
      const id = ++counter;
      const kind = opts?.kind ?? 'info';
      setToasts((t) => [...t, { id, message, kind }]);
      const dur = opts?.durationMs ?? (kind === 'error' ? 8000 : 4000);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), dur);
    };
    return () => {
      pushImpl = null;
    };
  }, []);

  if (toasts.length === 0) return null;

  return createPortal(
    <div
      className="fixed bottom-4 right-4 z-[80] flex w-80 flex-col gap-2"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-lg ${
            t.kind === 'error'
              ? 'border-danger-border bg-danger-bg text-danger-fg'
              : t.kind === 'success'
                ? 'border-border bg-surface text-fg'
                : 'border-border bg-surface text-fg'
          }`}
        >
          {t.kind === 'error' ? (
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : t.kind === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          ) : (
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
          )}
          <span className="flex-1 whitespace-pre-line break-words">{t.message}</span>
          <button
            onClick={() => dismiss(t.id)}
            className="shrink-0 rounded p-0.5 opacity-70 hover:bg-black/10 hover:opacity-100"
            aria-label="Dismiss notification"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}
