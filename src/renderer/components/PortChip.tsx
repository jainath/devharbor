import { ExternalLink } from 'lucide-react';
import { cn } from '../lib/cn';

export function PortChip({
  port,
  label,
  active = true,
  className
}: {
  /** Port number, or null when the task has no detected port yet. */
  port: number | null;
  /** Task name. Always rendered to disambiguate in multi-task apps. */
  label?: string;
  active?: boolean;
  className?: string;
}): JSX.Element {
  if (port == null) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-fg-subtle',
          className
        )}
        title={label ? `${label} — no listening port detected` : 'no listening port'}
      >
        {label && <span>{label}</span>}
        <span>—</span>
      </span>
    );
  }
  const url = `http://localhost:${port}`;
  return (
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault();
        window.open(url, '_blank');
      }}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px]',
        active
          ? 'border-border-strong bg-surface text-fg hover:bg-elevated'
          : 'border-border text-fg-subtle',
        className
      )}
      title={label ? `${label} · ${url}` : url}
    >
      {label && <span className="text-fg-muted">{label}</span>}
      <span className="text-accent">:{port}</span>
      {active && <ExternalLink className="h-3 w-3 opacity-60" />}
    </a>
  );
}
