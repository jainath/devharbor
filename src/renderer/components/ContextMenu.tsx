import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
}

interface State {
  x: number;
  y: number;
  items: MenuItem[];
  /**
   * The element that opened the menu. Focus returns here on close so keyboard
   * users aren't dumped at the top of the document. Held outside React state as
   * a plain ref-like field since it never needs to trigger a re-render.
   */
  trigger: HTMLElement | null;
}

/**
 * Tiny portal-based context menu. Use `useContextMenu()` to open it from any onContextMenu.
 * Renders into document.body so it isn't clipped by overflow:hidden parents.
 *
 * Accessibility (11.2): the portal is a real ARIA menu - role="menu" on the
 * container, role="menuitem" on each entry. Opening moves focus to the first
 * enabled item; ArrowUp/Down (wrapping), Home/End, Enter/Space and Escape/Tab
 * are all handled, and focus is restored to the trigger on close.
 */
export function useContextMenu(): {
  open: (e: React.MouseEvent, items: MenuItem[]) => void;
  node: JSX.Element | null;
} {
  const [state, setState] = useState<State | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  /** Live refs to each rendered menuitem button, in render order, for roving focus. */
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Restore focus to the trigger when the menu closes. Kept separate from the
  // open() closure so it fires for every close path (outside-click, Escape,
  // item activation) rather than only the one that knew about the trigger.
  const triggerRef = useRef<HTMLElement | null>(null);

  const close = (restoreFocus = true): void => {
    const t = triggerRef.current;
    setState(null);
    // Defer so the portal has unmounted before we move focus back; otherwise the
    // focus can land on the trigger and immediately be stolen by unmount churn.
    // Keyboard closes restore focus to the trigger; an outside CLICK must not - the
    // user just focused something else (e.g. the filter input) and yanking focus
    // back would leave them typing into nothing.
    if (t && restoreFocus) requestAnimationFrame(() => t.focus());
  };

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [state]);

  // Move focus to the first enabled item once the menu has rendered.
  useEffect(() => {
    if (!state) return;
    const first = itemRefs.current.find((el) => el && !el.disabled);
    first?.focus();
  }, [state]);

  const open = (e: React.MouseEvent, items: MenuItem[]): void => {
    e.preventDefault();
    e.stopPropagation();
    if (items.length === 0) return;
    // Anchor to the trigger's bounding rect for keyboard/click opens (no real
    // cursor position), but honour the cursor for genuine right-clicks so the
    // menu still appears under the pointer.
    const triggerEl = e.currentTarget as HTMLElement;
    const isPointer = e.type === 'contextmenu' && (e.clientX !== 0 || e.clientY !== 0);
    let x = e.clientX;
    let y = e.clientY;
    if (!isPointer && triggerEl) {
      const r = triggerEl.getBoundingClientRect();
      x = r.left;
      y = r.bottom + 2;
    }
    triggerRef.current = triggerEl ?? null;
    setState({ x, y, items, trigger: triggerEl ?? null });
  };

  /** Roving focus across enabled items; `dir` is +1 (down) or -1 (up). */
  const focusStep = (fromIndex: number, dir: 1 | -1): void => {
    const els = itemRefs.current;
    const n = els.length;
    if (n === 0) return;
    for (let step = 1; step <= n; step++) {
      const i = (((fromIndex + dir * step) % n) + n) % n;
      const el = els[i];
      if (el && !el.disabled) {
        el.focus();
        return;
      }
    }
  };

  const focusEdge = (dir: 1 | -1): void => {
    const els = itemRefs.current;
    if (dir === 1) {
      for (let i = 0; i < els.length; i++) {
        if (els[i] && !els[i]!.disabled) return void els[i]!.focus();
      }
    } else {
      for (let i = els.length - 1; i >= 0; i--) {
        if (els[i] && !els[i]!.disabled) return void els[i]!.focus();
      }
    }
  };

  const activate = (item: MenuItem): void => {
    if (item.disabled) return;
    close();
    item.onSelect();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent, index: number, item: MenuItem): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusStep(index, 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusStep(index, -1);
        break;
      case 'Home':
        e.preventDefault();
        focusEdge(1);
        break;
      case 'End':
        e.preventDefault();
        focusEdge(-1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        activate(item);
        break;
      case 'Tab':
        // Tab leaves the menu - close and restore focus rather than trapping
        // the user inside the portal.
        e.preventDefault();
        close();
        break;
      // Escape is handled at the window level so it also works mid-render.
    }
  };

  // Reset the per-render ref array so stale entries from a previous menu don't
  // linger and break roving focus / first-item focus.
  itemRefs.current = [];

  const node = state
    ? createPortal(
        <div
          ref={ref}
          role="menu"
          aria-orientation="vertical"
          style={{ left: state.x, top: state.y }}
          className="fixed z-[100] min-w-[180px] rounded-md border border-border bg-base py-1 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {state.items.map((item, i) => {
            const showSep = item.separatorBefore && i > 0;
            return (
              <div key={i}>
                {showSep && <div className="my-1 border-t border-border" role="separator" />}
                <button
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  role="menuitem"
                  tabIndex={-1}
                  disabled={item.disabled}
                  aria-disabled={item.disabled || undefined}
                  onClick={() => activate(item)}
                  onKeyDown={(e) => onMenuKeyDown(e, i, item)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none',
                    'focus-visible:bg-surface',
                    item.disabled
                      ? 'text-fg-subtle'
                      : item.danger
                      ? 'text-danger-fg hover:bg-danger-bg focus-visible:bg-danger-bg'
                      : 'text-fg hover:bg-surface'
                  )}
                >
                  {item.icon && <span className="opacity-70">{item.icon}</span>}
                  {item.label}
                </button>
              </div>
            );
          })}
        </div>,
        document.body
      )
    : null;

  return { open, node };
}
