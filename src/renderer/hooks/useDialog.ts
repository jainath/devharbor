import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isVisible(el: HTMLElement): boolean {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

/**
 * Stack of currently-open dialogs (tokens pushed on mount, popped on unmount). Dialogs can
 * STACK - a confirm (PromptModal) opens on top of a drawer that also uses this hook, and both
 * register document-level capture listeners. `stopPropagation` does NOT silence other
 * listeners on the same node, so without this stack one Escape press would fire EVERY open
 * dialog's close handler (closing the whole drawer when the user only meant to dismiss the
 * confirm). Only the TOP-most dialog may handle Escape/Tab.
 */
const dialogStack: symbol[] = [];

export interface UseDialogResult {
  containerRef: RefObject<HTMLDivElement>;
  /** Spread onto the dialog's root element: role/aria-modal/aria-labelledby + ref. */
  dialogProps: {
    ref: RefObject<HTMLDivElement>;
    role: 'dialog';
    'aria-modal': boolean;
    'aria-labelledby'?: string;
  };
}

/**
 * Accessible modal-dialog behaviour shared by every overlay drawer: focus moves into the
 * dialog on open, Tab/Shift+Tab is trapped inside it, Escape closes it, and focus is
 * restored to whatever was focused before it opened. Document-level keydown (capture) means
 * Escape keeps working even after focus leaves the first field, and shortcuts bound on the
 * window (⌘N, ⌘↩) still reach their handlers - callers gate those on dialog-open state.
 *
 * Mark a preferred initial-focus element with `data-autofocus`; otherwise the first
 * focusable element (or the container) is focused.
 *
 * Inner widgets that consume Escape themselves (e.g. a combobox closing its popup) can mark
 * their root with `data-escape-stop` WHILE their popup is open - Escape originating inside
 * such an element is left to the widget instead of closing the dialog.
 */
export function useDialog(onClose: () => void, labelledBy?: string): UseDialogResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const prevActive = document.activeElement as HTMLElement | null;
    const el = containerRef.current;
    const token = Symbol('dialog');
    dialogStack.push(token);

    const focusTarget =
      el?.querySelector<HTMLElement>('[data-autofocus]') ??
      el?.querySelector<HTMLElement>(FOCUSABLE) ??
      el;
    // Defer so the element is laid out before we focus it.
    requestAnimationFrame(() => focusTarget?.focus());

    const onKey = (e: KeyboardEvent): void => {
      // Only the top-most open dialog reacts - a stacked confirm owns Escape/Tab while open.
      if (dialogStack[dialogStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        // An open inner popup (combobox/tag suggestions) gets first claim on Escape.
        const target = e.target as HTMLElement | null;
        if (target?.closest('[data-escape-stop]')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isVisible);
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || !el.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    // Capture phase so Escape fires before background window handlers.
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const idx = dialogStack.indexOf(token);
      if (idx !== -1) dialogStack.splice(idx, 1);
      // Restore focus to the trigger.
      if (prevActive && typeof prevActive.focus === 'function') prevActive.focus();
    };
  }, []);

  return {
    containerRef,
    dialogProps: {
      ref: containerRef,
      role: 'dialog',
      'aria-modal': true,
      ...(labelledBy ? { 'aria-labelledby': labelledBy } : {})
    }
  };
}
