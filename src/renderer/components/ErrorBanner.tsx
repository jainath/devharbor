import { X } from 'lucide-react';
import { cn } from '../lib/cn';

export function ErrorBanner({
  message,
  onDismiss,
  className
}: {
  message: string;
  onDismiss: () => void;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border border-danger-border bg-danger-bg px-3 py-1.5 text-xs text-danger-fg',
        className
      )}
    >
      <span className="flex-1">{message}</span>
      <button
        onClick={onDismiss}
        className="-mr-1 rounded p-0.5 text-danger-fg/70 hover:bg-danger-bg-hover hover:text-danger-strong"
        title="Dismiss this error"
        aria-label="Dismiss"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
