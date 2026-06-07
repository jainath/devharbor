import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { X, Search, ChevronUp, ChevronDown, Type, ArrowDown } from 'lucide-react';
import type { TaskId } from '@shared/types';
import { cn } from '../lib/cn';

const LIVE_THEME = {
  // Chrome aligned to the zinc + teal app theme; the ANSI 16 below stay a readable,
  // vivid log palette (terminal output colors are conventionally their own set).
  background: '#141417', // a hair darker than the zinc-900 base for subtle terminal depth
  foreground: '#e4e4e7', // zinc-200 — soft white
  cursor: '#2dd4bf', // harbor teal
  selectionBackground: '#3f3f46', // zinc-700
  black: '#1a1b26',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#c0caf5',
  brightBlack: '#414868',
  brightRed: '#ff7a93',
  brightGreen: '#b9f27c',
  brightYellow: '#ff9e64',
  brightBlue: '#7da6ff',
  brightMagenta: '#bb9af7',
  brightCyan: '#0db9d7',
  brightWhite: '#c0caf5'
};

const MIN_FONT = 9;
const MAX_FONT = 22;

export interface LogTerminalRef {
  copyAll: () => Promise<void>;
  saveToFile: () => Promise<void>;
}

export const LogTerminal = forwardRef<LogTerminalRef, { taskId: TaskId }>(function LogTerminal(
  { taskId },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [fontSize, setFontSize] = useState(12);
  const [scrolledUp, setScrolledUp] = useState(false);

  // Imperative API for the AppDetail toolbar.
  useImperativeHandle(ref, () => ({
    copyAll: async () => {
      const buf = await window.api.invoke('task:readBuffer', { id: taskId });
      await navigator.clipboard.writeText(stripAnsi(buf));
    },
    saveToFile: async () => {
      const buf = await window.api.invoke('task:readBuffer', { id: taskId });
      const blob = new Blob([stripAnsi(buf)], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `task-${taskId.slice(0, 8)}-${Date.now()}.log`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
  }));

  // Initialize xterm on mount or taskId change.
  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;

    const term = new Terminal({
      cursorBlink: false,
      fontFamily: '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize,
      lineHeight: 1.2,
      scrollback: 10000,
      convertEol: true,
      theme: LIVE_THEME,
      allowProposedApi: true
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // canvas fallback
    }
    try {
      fit.fit();
    } catch {
      // ignore
    }

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // Replay the persistent main-side buffer.
    let cancelled = false;
    void window.api.invoke('task:readBuffer', { id: taskId }).then((initial) => {
      if (cancelled) return;
      if (initial) term.write(initial);
    });

    const pushResize = (): void => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const cols = term.cols;
      const rows = term.rows;
      const last = lastSizeRef.current;
      if (!last || last.cols !== cols || last.rows !== rows) {
        lastSizeRef.current = { cols, rows };
        void window.api.invoke('task:resize', { id: taskId, cols, rows });
      }
    };

    pushResize();
    const ro = new ResizeObserver(() => pushResize());
    ro.observe(host);

    // Track whether the user has scrolled away from the bottom.
    const onScroll = (): void => {
      // viewportY is the top of the visible viewport (line index).
      // When user is at bottom, viewportY = buffer.length - rows ≈ baseY.
      const buf = term.buffer.active;
      const atBottom = buf.viewportY >= buf.baseY - 1;
      setScrolledUp(!atBottom);
    };
    term.onScroll(onScroll);

    const offLog = window.api.on('task:log', (e) => {
      if (e.taskId !== taskId) return;
      term.write(e.chunk);
    });

    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        // Only intercept when focus is in the log area (or document body)
        const active = document.activeElement;
        if (active && active !== document.body && !host.contains(active)) return;
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKey);
      offLog();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      lastSizeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // React to font-size changes.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    try {
      fit?.fit();
    } catch {
      // ignore
    }
  }, [fontSize]);

  const runSearch = (direction: 'next' | 'prev'): void => {
    const s = searchRef.current;
    if (!s || !searchQuery) return;
    const opts = {
      decorations: {
        matchBackground: '#7aa2f7',
        matchOverviewRuler: '#7aa2f7',
        activeMatchBackground: '#e0af68',
        activeMatchColorOverviewRuler: '#e0af68'
      }
    };
    if (direction === 'next') s.findNext(searchQuery, opts);
    else s.findPrevious(searchQuery, opts);
  };

  const jumpToBottom = (): void => {
    termRef.current?.scrollToBottom();
  };

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" data-selectable />

      {/* Floating compact toolbar — bottom-right when scrolled up, top-right always for tools */}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-border bg-base/90 px-1 py-0.5 backdrop-blur">
        <ToolbarButton
          title="Find (⌘ F)"
          onClick={() => setSearchOpen(true)}
        >
          <Search className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          title="Decrease font size"
          onClick={() => setFontSize((s) => Math.max(MIN_FONT, s - 1))}
        >
          <Type className="h-3 w-3" />
          <span className="text-[9px]">−</span>
        </ToolbarButton>
        <ToolbarButton
          title="Increase font size"
          onClick={() => setFontSize((s) => Math.min(MAX_FONT, s + 1))}
        >
          <Type className="h-3.5 w-3.5" />
          <span className="text-[9px]">+</span>
        </ToolbarButton>
      </div>

      {scrolledUp && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-3 right-3 z-10 inline-flex items-center gap-1 rounded-full border border-border-strong bg-surface/90 px-2.5 py-1 text-[11px] text-fg shadow-md backdrop-blur hover:bg-elevated"
        >
          <ArrowDown className="h-3 w-3" /> Jump to bottom
        </button>
      )}

      {searchOpen && (
        <div className="absolute right-3 top-10 z-10 flex items-center gap-1 rounded-md border border-border bg-base/95 px-2 py-1 shadow-lg backdrop-blur">
          <Search className="h-3.5 w-3.5 text-fg-subtle" />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(e.shiftKey ? 'prev' : 'next');
              if (e.key === 'Escape') {
                setSearchOpen(false);
                setSearchQuery('');
              }
            }}
            placeholder="Find in logs (⌘ F)"
            className="w-56 bg-transparent text-xs text-fg outline-none placeholder:text-fg-subtle"
          />
          <button
            onClick={() => runSearch('prev')}
            className="rounded p-0.5 text-fg-muted hover:bg-surface hover:text-fg"
            title="Previous (⇧↩)"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => runSearch('next')}
            className="rounded p-0.5 text-fg-muted hover:bg-surface hover:text-fg"
            title="Next (↩)"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery('');
            }}
            className="rounded p-0.5 text-fg-muted hover:bg-surface hover:text-fg"
            title="Close (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
});

function ToolbarButton({
  children,
  onClick,
  title
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex items-center gap-0.5 rounded p-1 text-fg-muted hover:bg-surface hover:text-fg'
      )}
    >
      {children}
    </button>
  );
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
