import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FolderPlus, Plus } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Pick a folder for an app: choose "(No folder)", select an existing folder, or create a
 * new one inline. Replaces the plain text+datalist field so the available folders are
 * explicit and creating a new one is a clear, distinct action.
 */
export function FolderSelect({
  value,
  options,
  onChange
}: {
  /** Current folder name, or '' for none. */
  value: string;
  /** Existing folder names across all apps. */
  options: string[];
  onChange: (next: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  const newInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setDraft('');
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (creating) requestAnimationFrame(() => newInputRef.current?.focus());
  }, [creating]);

  const pick = (folder: string): void => {
    onChange(folder);
    setOpen(false);
    setCreating(false);
    setDraft('');
  };

  const commitNew = (): void => {
    const t = draft.trim().slice(0, 60);
    if (!t) return;
    pick(t);
  };

  return (
    <div ref={ref} className="relative w-72">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg hover:border-border-strong"
      >
        <span className={cn('truncate', !value && 'text-fg-subtle')}>
          {value || 'No folder'}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-border bg-base py-1 shadow-lg">
          <Option label="No folder" selected={!value} muted onSelect={() => pick('')} />
          {options.length > 0 && <div className="my-1 border-t border-border" />}
          <div className="max-h-44 overflow-y-auto">
            {options.map((f) => (
              <Option
                key={f}
                label={f}
                selected={f.toLowerCase() === value.toLowerCase()}
                onSelect={() => pick(f)}
              />
            ))}
          </div>
          <div className="my-1 border-t border-border" />
          {creating ? (
            <div className="flex items-center gap-1 px-2 py-1">
              <input
                ref={newInputRef}
                value={draft}
                maxLength={60}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitNew();
                  }
                  if (e.key === 'Escape') {
                    setCreating(false);
                    setDraft('');
                  }
                }}
                placeholder="New folder name…"
                className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5 text-sm text-fg outline-none"
              />
              <button
                onClick={commitNew}
                disabled={!draft.trim()}
                className="rounded-md bg-accent px-1.5 py-0.5 text-xs text-accent-fg disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-muted hover:bg-surface hover:text-fg"
            >
              <FolderPlus className="h-3.5 w-3.5" /> Create new folder…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Option({
  label,
  selected,
  muted = false,
  onSelect
}: {
  label: string;
  selected: boolean;
  muted?: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface',
        muted ? 'text-fg-subtle' : 'text-fg'
      )}
    >
      <Check className={cn('h-3.5 w-3.5 shrink-0', selected ? 'opacity-100 text-accent' : 'opacity-0')} />
      <span className="truncate">{label}</span>
    </button>
  );
}
