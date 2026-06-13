import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Chip-based tag editor with autocomplete. Type and press Enter/comma to add a tag,
 * Backspace on an empty input removes the last chip, and a dropdown suggests existing
 * tags (from other apps) that match what you're typing.
 *
 * The suggestion dropdown is a real combobox+listbox: the input owns the focus and points
 * at the highlighted option via aria-activedescendant (role="listbox"/option on the list),
 * so screen readers announce the active suggestion. ArrowUp/Down move the highlight, Enter
 * adds it, and Escape closes the list while keeping the typed draft.
 */
export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder = 'Add a tag…'
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** All known tags across the app, for autocomplete. */
  suggestions?: string[];
  placeholder?: string;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = 'tag-suggestions-listbox';
  const optionId = (i: number): string => `tag-suggestion-${i}`;

  const norm = (t: string): string => t.trim();
  const has = (t: string): boolean => value.some((v) => v.toLowerCase() === t.toLowerCase());

  const matches = suggestions
    .filter((s) => !has(s))
    .filter((s) => (draft ? s.toLowerCase().includes(draft.toLowerCase()) : true))
    .slice(0, 8);

  const listOpen = open && matches.length > 0;

  const addTag = (raw: string): void => {
    const t = norm(raw);
    if (!t || has(t)) {
      setDraft('');
      return;
    }
    onChange([...value, t]);
    setDraft('');
    setActiveIdx(0);
  };

  const removeTag = (t: string): void => onChange(value.filter((v) => v !== t));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (listOpen && matches[activeIdx]) addTag(matches[activeIdx]!);
      else if (draft.trim()) addTag(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      removeTag(value[value.length - 1]!);
    } else if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Escape') {
      // Close the suggestions but keep the draft so the user can keep typing.
      setOpen(false);
    }
  };

  return (
    <div className="relative w-72" data-escape-stop={listOpen ? '' : undefined}>
      <div
        className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-1 focus-within:border-border-strong"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-xs text-accent"
          >
            {t}
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeTag(t);
              }}
              className="rounded-sm hover:bg-accent/20"
              title={`Remove tag “${t}”`}
              aria-label={`Remove tag ${t}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={draft}
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={listOpen ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={listOpen ? optionId(activeIdx) : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
            setActiveIdx(0);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Commit a pending draft on blur, then close the dropdown next tick.
            if (draft.trim()) addTag(draft);
            setTimeout(() => setOpen(false), 120);
          }}
          placeholder={value.length === 0 ? placeholder : ''}
          className="min-w-[80px] flex-1 bg-transparent px-1 py-0.5 text-sm text-fg outline-none placeholder:text-fg-subtle"
        />
      </div>
      {listOpen && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Tag suggestions"
          className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-border bg-base py-1 shadow-lg"
        >
          {matches.map((s, i) => (
            <li role="presentation" key={s}>
              <button
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIdx}
                onMouseDown={(e) => {
                  e.preventDefault();
                  addTag(s);
                }}
                onMouseEnter={() => setActiveIdx(i)}
                className={cn(
                  'flex w-full items-center px-3 py-1.5 text-left text-sm',
                  i === activeIdx ? 'bg-surface text-fg' : 'text-fg-muted'
                )}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
