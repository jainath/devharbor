import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { OpenInCapabilities, OpenInTarget } from '@shared/ipc';
import { cn } from '../lib/cn';

interface Item {
  target: OpenInTarget;
  label: string;
  available: (c: OpenInCapabilities) => boolean;
}

const ITEMS: Item[] = [
  { target: 'finder', label: 'Finder', available: (c) => c.finder },
  { target: 'terminal', label: 'Terminal', available: (c) => c.terminal },
  { target: 'vscode', label: 'VS Code', available: (c) => c.vscode },
  { target: 'cursor', label: 'Cursor', available: (c) => c.cursor },
  { target: 'sublime', label: 'Sublime Text', available: (c) => c.sublime }
];

export function OpenInMenu({ path }: { path: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [caps, setCaps] = useState<OpenInCapabilities | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void window.api.invoke('openIn:caps', undefined).then(setCaps);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  const onPick = async (target: OpenInTarget): Promise<void> => {
    setOpen(false);
    try {
      await window.api.invoke('openIn:open', { target, path });
    } catch (e) {
      console.error('openIn failed', e);
    }
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface hover:text-fg"
        title="Open this project in an editor…"
        aria-label="Open this project in an editor"
      >
        <ExternalLink className="h-4 w-4" />
      </button>
      {open && caps && (
        <div className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-md border border-border bg-base py-1 shadow-lg">
          {ITEMS.map((it) => {
            const enabled = it.available(caps);
            return (
              <button
                key={it.target}
                disabled={!enabled}
                onClick={() => void onPick(it.target)}
                className={cn(
                  'flex w-full items-center px-3 py-1.5 text-left text-sm',
                  enabled
                    ? 'text-fg hover:bg-surface'
                    : 'text-fg-subtle'
                )}
              >
                {it.label}
                {!enabled && <span className="ml-auto text-[10px] text-fg-subtle">not found</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
