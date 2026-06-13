import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, FolderPlus, Plus } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Pick a folder for an app: choose "(No folder)", select an existing folder, or create a
 * new one inline. Replaces the plain text+datalist field so the available folders are
 * explicit and creating a new one is a clear, distinct action.
 *
 * Exposes proper listbox semantics (trigger = aria-haspopup="listbox", list = role="listbox",
 * items = role="option" + aria-selected) and full keyboard support - ArrowUp/Down move a
 * highlight, Enter chooses it, Escape closes - so the dropdown is usable without a pointer.
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
  // Index into `entries` that the keyboard highlight currently sits on.
  const [activeIdx, setActiveIdx] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const newInputRef = useRef<HTMLInputElement | null>(null);
  const listId = 'folder-select-listbox';

  // Flat, ordered list of selectable rows: "No folder" first, then existing folders.
  // Drives both rendering and ArrowUp/Down navigation so the highlight maps 1:1 to rows.
  const entries = useMemo(
    () => [{ label: 'No folder', value: '' }, ...options.map((f) => ({ label: f, value: f }))],
    [options]
  );

  const close = (): void => {
    setOpen(false);
    setCreating(false);
    setDraft('');
  };

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (creating) requestAnimationFrame(() => newInputRef.current?.focus());
  }, [creating]);

  // When opening, start the highlight on the currently-selected folder so the user
  // lands where they already are rather than at the top.
  useEffect(() => {
    if (!open) return;
    const sel = entries.findIndex((e) => e.value.toLowerCase() === value.toLowerCase());
    setActiveIdx(sel >= 0 ? sel : 0);
  }, [open, entries, value]);

  const pick = (folder: string): void => {
    onChange(folder);
    close();
    triggerRef.current?.focus();
  };

  const commitNew = (): void => {
    const t = draft.trim().slice(0, 60);
    if (!t) return;
    pick(t);
  };

  // Keyboard handling for the trigger button: open + move the highlight + choose.
  // Only active while not editing the new-folder input (that input owns its own keys).
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
      if (creating) return;
      setActiveIdx((i) =>
        e.key === 'ArrowDown'
          ? Math.min(i + 1, entries.length - 1)
          : Math.max(i - 1, 0)
      );
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && open && !creating) {
      e.preventDefault();
      const entry = entries[activeIdx];
      if (entry) pick(entry.value);
    }
  };

  return (
    <div ref={ref} className="relative w-72" data-escape-stop={open ? '' : undefined}>
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg hover:border-border-strong"
      >
        <span className={cn('truncate', !value && 'text-fg-subtle')}>
          {value || 'No folder'}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-border bg-base py-1 shadow-lg">
          <ul id={listId} role="listbox" aria-label="Folder" className="max-h-44 overflow-y-auto">
            <Option
              label="No folder"
              selected={!value}
              active={activeIdx === 0}
              muted
              onSelect={() => pick('')}
              onHover={() => setActiveIdx(0)}
            />
            {options.length > 0 && <li role="presentation" className="my-1 border-t border-border" />}
            {options.map((f, i) => {
              // +1 offsets the leading "No folder" entry so indices line up with `entries`.
              const idx = i + 1;
              return (
                <Option
                  key={f}
                  label={f}
                  selected={f.toLowerCase() === value.toLowerCase()}
                  active={activeIdx === idx}
                  onSelect={() => pick(f)}
                  onHover={() => setActiveIdx(idx)}
                />
              );
            })}
          </ul>
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
                    e.preventDefault();
                    // First Escape backs out of the create flow; a second (handled by the
                    // trigger when re-focused) would close the whole list.
                    setCreating(false);
                    setDraft('');
                    triggerRef.current?.focus();
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
  active,
  muted = false,
  onSelect,
  onHover
}: {
  label: string;
  selected: boolean;
  /** Keyboard highlight is on this row (visual only; selection is `selected`). */
  active: boolean;
  muted?: boolean;
  onSelect: () => void;
  onHover: () => void;
}): JSX.Element {
  return (
    <li role="presentation">
      <button
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        onMouseEnter={onHover}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
          active ? 'bg-surface' : 'hover:bg-surface',
          muted ? 'text-fg-subtle' : 'text-fg'
        )}
      >
        <Check className={cn('h-3.5 w-3.5 shrink-0', selected ? 'opacity-100 text-accent' : 'opacity-0')} />
        <span className="truncate">{label}</span>
      </button>
    </li>
  );
}
