import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import Anser from 'anser';
import { Search, X } from 'lucide-react';
import type { TaskId } from '@shared/types';
import { cn } from '../lib/cn';

/**
 * Virtualized, searchable view over a task's full log buffer.
 *
 * Pulls the current ring buffer via `task:readBuffer`, refreshes on every `task:log` event
 * (we just re-read; bounded buffer makes this cheap). ANSI is parsed once per line via
 * `anser` and rendered as inline spans.
 */
export function LogSearchView({ taskId }: { taskId: TaskId }): JSX.Element {
  const [lines, setLines] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const listRef = useRef<ListImperativeAPI | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const buf = await window.api.invoke('task:readBuffer', { id: taskId });
    setLines(buf.split(/\r?\n/));
  }, [taskId]);

  useEffect(() => {
    void refresh();
    const off = window.api.on('task:log', (e) => {
      if (e.taskId !== taskId) return;
      void refresh();
    });
    return off;
  }, [taskId, refresh]);

  // Filter to matching lines (with their original index for the line-number column).
  const { filtered, matcher } = useMemo(() => {
    if (!query) {
      return {
        filtered: lines.map((line, i) => ({ line, originalIndex: i })),
        matcher: null as RegExp | null
      };
    }
    let re: RegExp | null = null;
    try {
      re = useRegex
        ? new RegExp(query, caseSensitive ? '' : 'i')
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i');
    } catch {
      re = null;
    }
    if (!re) return { filtered: [], matcher: null };
    const out: { line: string; originalIndex: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? '';
      if (re.test(stripAnsi(l))) out.push({ line: l, originalIndex: i });
    }
    return { filtered: out, matcher: re };
  }, [lines, query, useRegex, caseSensitive]);

  // Scroll to the last match when query or lines change.
  useEffect(() => {
    if (filtered.length === 0) return;
    listRef.current?.scrollToRow({ index: filtered.length - 1, align: 'end' });
  }, [filtered.length]);

  const renderRow = useCallback(
    ({ index, style }: { index: number; style: React.CSSProperties }) => {
      const row = filtered[index];
      if (!row) return null;
      const original = row.originalIndex;
      return (
        <div
          style={style}
          className="flex items-start gap-3 px-3 font-mono text-[12px] leading-[1.4] text-fg hover:bg-surface/40"
          data-selectable
        >
          <span className="w-12 shrink-0 text-right text-fg-subtle">{original + 1}</span>
          <span className="flex-1 whitespace-pre-wrap break-words">
            {renderAnsiWithHighlight(row.line, matcher)}
          </span>
        </div>
      );
    },
    [filtered, matcher]
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-surface bg-base px-3 py-1.5">
        <Search className="h-3.5 w-3.5 text-fg-subtle" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search scrollback (regex or plain text)"
          className="flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-subtle"
        />
        <button
          onClick={() => setUseRegex((v) => !v)}
          className={cn(
            'rounded-md border px-1.5 py-0.5 text-[10px]',
            useRegex
              ? 'border-accent/60 bg-accent/10 text-fg'
              : 'border-border text-fg-muted hover:bg-surface'
          )}
          title="Toggle regex mode"
        >
          .*
        </button>
        <button
          onClick={() => setCaseSensitive((v) => !v)}
          className={cn(
            'rounded-md border px-1.5 py-0.5 text-[10px]',
            caseSensitive
              ? 'border-accent/60 bg-accent/10 text-fg'
              : 'border-border text-fg-muted hover:bg-surface'
          )}
          title="Case-sensitive"
        >
          Aa
        </button>
        <span className="text-[10px] text-fg-subtle">
          {query ? `${filtered.length} of ${lines.length}` : `${lines.length} lines`}
        </span>
        {query && (
          <button
            onClick={() => setQuery('')}
            className="rounded p-0.5 text-fg-subtle hover:bg-surface hover:text-fg"
            title="Clear"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="flex-1">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-fg-subtle">
            {query ? 'No matches.' : 'No logs yet.'}
          </div>
        ) : (
          <List
            listRef={listRef}
            rowCount={filtered.length}
            rowHeight={20}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rowComponent={renderRow as any}
            rowProps={{} as never}
          />
        )}
      </div>
    </div>
  );
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function renderAnsiWithHighlight(line: string, matcher: RegExp | null): React.ReactNode {
  const parsed = Anser.ansiToJson(line, { use_classes: false, json: true });
  return parsed.map((seg, i) => {
    const style: React.CSSProperties = {};
    if (seg.fg) style.color = `rgb(${seg.fg})`;
    if (seg.bg) style.backgroundColor = `rgb(${seg.bg})`;
    if (seg.decoration === 'bold') style.fontWeight = 600;
    if (seg.decoration === 'underline') style.textDecoration = 'underline';
    const text = seg.content;
    if (!matcher) return <span key={i} style={style}>{text}</span>;

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    const localRe = new RegExp(matcher.source, matcher.flags.includes('g') ? matcher.flags : matcher.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = localRe.exec(text)) !== null) {
      if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index));
      parts.push(
        <mark
          key={`${i}-${m.index}`}
          className="bg-warn-bg-hover text-warn-strong"
          style={{ borderRadius: 2 }}
        >
          {m[0]}
        </mark>
      );
      lastIndex = m.index + m[0].length;
      if (m[0].length === 0) localRe.lastIndex++;
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex));
    return (
      <span key={i} style={style}>
        {parts}
      </span>
    );
  });
}
