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
}

/**
 * Tiny portal-based context menu. Use `useContextMenu()` to open it from any onContextMenu.
 * Renders into document.body so it isn't clipped by overflow:hidden parents.
 */
export function useContextMenu(): {
  open: (e: React.MouseEvent, items: MenuItem[]) => void;
  node: JSX.Element | null;
} {
  const [state, setState] = useState<State | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!state) return;
    const close = (): void => setState(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [state]);

  const open = (e: React.MouseEvent, items: MenuItem[]): void => {
    e.preventDefault();
    e.stopPropagation();
    if (items.length === 0) return;
    setState({ x: e.clientX, y: e.clientY, items });
  };

  const node = state
    ? createPortal(
        <div
          ref={ref}
          style={{ left: state.x, top: state.y }}
          className="fixed z-[100] min-w-[180px] rounded-md border border-border bg-base py-1 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {state.items.map((item, i) => {
            const showSep = item.separatorBefore && i > 0;
            return (
              <div key={i}>
                {showSep && <div className="my-1 border-t border-border" />}
                <button
                  disabled={item.disabled}
                  onClick={() => {
                    if (item.disabled) return;
                    setState(null);
                    item.onSelect();
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
                    item.disabled
                      ? 'text-fg-subtle'
                      : item.danger
                      ? 'text-danger-fg hover:bg-danger-bg'
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
