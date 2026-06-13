import { useEffect, useMemo, useRef, useState } from 'react';
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

/**
 * "Open in…" overflow menu. Presents the app's reveal/edit targets (Finder, Terminal,
 * editors) as a listbox so it carries proper ARIA (role="listbox"/"option") and full
 * keyboard support: ArrowUp/Down move the highlight over *enabled* targets only, Enter
 * activates, and Escape closes the menu (it previously had no keyboard close at all).
 */
export function OpenInMenu({ path }: { path: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [caps, setCaps] = useState<OpenInCapabilities | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listId = 'open-in-listbox';

  useEffect(() => {
    void window.api.invoke('openIn:caps', undefined).then(setCaps);
  }, []);

  // Indices of targets the host can actually open - arrow navigation hops between these
  // so the highlight never lands on a "not found" row the user can't activate.
  const enabledIdxs = useMemo(
    () => (caps ? ITEMS.map((it, i) => (it.available(caps) ? i : -1)).filter((i) => i >= 0) : []),
    [caps]
  );

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  // On open, seat the highlight on the first enabled target.
  useEffect(() => {
    if (open) setActiveIdx(enabledIdxs[0] ?? 0);
  }, [open, enabledIdxs]);

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onPick = async (target: OpenInTarget): Promise<void> => {
    setOpen(false);
    triggerRef.current?.focus();
    try {
      await window.api.invoke('openIn:open', { target, path });
    } catch (e) {
      console.error('openIn failed', e);
    }
  };

  // Step the highlight to the next/previous *enabled* target, wrapping at the ends.
  const move = (dir: 1 | -1): void => {
    if (enabledIdxs.length === 0) return;
    const pos = enabledIdxs.indexOf(activeIdx);
    const nextPos =
      pos < 0
        ? 0
        : (pos + dir + enabledIdxs.length) % enabledIdxs.length;
    setActiveIdx(enabledIdxs[nextPos]!);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        close();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && open) {
      const it = ITEMS[activeIdx];
      if (it && caps && it.available(caps)) {
        e.preventDefault();
        void onPick(it.target);
      }
    }
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open && caps ? listId : undefined}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface hover:text-fg"
        title="Open this project in an editor…"
        aria-label="Open this project in an editor"
      >
        <ExternalLink className="h-4 w-4" />
      </button>
      {open && caps && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Open in"
          className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-md border border-border bg-base py-1 shadow-lg"
        >
          {ITEMS.map((it, i) => {
            const enabled = it.available(caps);
            const active = enabled && i === activeIdx;
            return (
              <li role="presentation" key={it.target}>
                <button
                  role="option"
                  aria-selected={active}
                  aria-disabled={!enabled}
                  disabled={!enabled}
                  onClick={() => void onPick(it.target)}
                  onMouseEnter={() => enabled && setActiveIdx(i)}
                  className={cn(
                    'flex w-full items-center px-3 py-1.5 text-left text-sm',
                    enabled
                      ? active
                        ? 'bg-surface text-fg'
                        : 'text-fg hover:bg-surface'
                      : 'text-fg-subtle'
                  )}
                >
                  {it.label}
                  {!enabled && <span className="ml-auto text-[10px] text-fg-subtle">not found</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
