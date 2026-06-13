import { useEffect, useMemo, useState } from 'react';
import type { NodeInstallation, NodeVersionPref } from '@shared/types';

/**
 * Picks a Node version preference for an app or a task.
 *
 *   auto       - let NodeResolver read .nvmrc / .node-version / engines.node from the
 *                project at start time
 *   system     - whatever `node` resolves to on the user's PATH
 *   explicit   - a specific installed version (across nvm/fnm/volta/asdf/system)
 *
 * Versions discovered from any installed manager appear in one list, deduped by version.
 */
export function NodeVersionPicker({
  value,
  onChange,
  includeInherit = false
}: {
  value: NodeVersionPref | null;
  onChange: (next: NodeVersionPref | null) => void;
  /** If true, adds an "Inherit from app" option (returns null). Use in TaskEditor. */
  includeInherit?: boolean;
}): JSX.Element {
  const [installs, setInstalls] = useState<NodeInstallation[]>([]);

  useEffect(() => {
    void window.api.invoke('node:list', undefined).then(setInstalls);
  }, []);

  // Dedupe by version; record sources so we can show e.g. "(nvm + fnm)".
  const versions = useMemo(() => {
    const byVersion = new Map<string, NodeInstallation[]>();
    for (const n of installs) {
      const arr = byVersion.get(n.version) ?? [];
      arr.push(n);
      byVersion.set(n.version, arr);
    }
    return [...byVersion.entries()]
      .map(([version, sources]) => ({ version, sources: sources.map((s) => s.source) }))
      .sort((a, b) => semverCompare(b.version, a.version));
  }, [installs]);

  // Encode the current selection as a stable string key for the <select>.
  const selectedKey = encode(value, includeInherit);

  const onSelect = (key: string): void => {
    onChange(decode(key));
  };

  return (
    <div className="inline-flex items-center gap-2">
      <select
        value={selectedKey}
        onChange={(e) => onSelect(e.target.value)}
        className="w-72 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
      >
        {includeInherit && <option value="inherit">Inherit from app</option>}
        <option value="auto">Auto (.nvmrc / .node-version / engines.node)</option>
        <option value="system">System Node (on PATH)</option>
        {versions.length > 0 && <option disabled>──────────</option>}
        {versions.map((v) => (
          <option key={v.version} value={`explicit:${v.version}`}>
            v{v.version} {v.sources.length > 0 ? `· ${v.sources.join(', ')}` : ''}
          </option>
        ))}
      </select>
      {versions.length === 0 && (
        <span className="text-[10px] text-fg-subtle">
          No installations detected - try `nvm install &lt;version&gt;`
        </span>
      )}
    </div>
  );
}

function encode(v: NodeVersionPref | null, includeInherit: boolean): string {
  if (v == null) return includeInherit ? 'inherit' : 'auto';
  if (v.kind === 'auto') return 'auto';
  if (v.kind === 'system') return 'system';
  return `explicit:${v.version}`;
}

function decode(key: string): NodeVersionPref | null {
  if (key === 'inherit') return null;
  if (key === 'auto') return { kind: 'auto' };
  if (key === 'system') return { kind: 'system' };
  if (key.startsWith('explicit:')) {
    return { kind: 'explicit', version: key.slice('explicit:'.length) };
  }
  return { kind: 'auto' };
}

function semverCompare(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number(x) || 0);
  const pb = b.split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}
