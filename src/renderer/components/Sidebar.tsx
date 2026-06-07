import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Boxes,
  Plus,
  Settings,
  Search,
  Play,
  Square,
  RotateCw,
  Folder,
  FolderPlus,
  FolderMinus,
  Tag,
  ChevronRight,
  ChevronDown,
  MoreVertical,
  Trash2,
  Edit3,
  Eye,
  Cog,
  ArrowDownUp,
  ArrowDownAZ,
  Clock,
  Check
} from 'lucide-react';
import type { App, AppId, ProcessState } from '@shared/types';
import { useStore } from '../store/store';
import { cn } from '../lib/cn';
import { useContextMenu, type MenuItem } from './ContextMenu';
import { openPrompt, openConfirm } from './PromptModal';
import { StatusDot } from './StatusDot';
import { sortApps, type AppSortMode } from '../lib/sortApps';

const UNGROUPED = '(Ungrouped)';
const UNTAGGED = '(Untagged)';
const COLLAPSE_KEY = 'devharbor:folder-collapse';
const PINNED_KEY = 'devharbor:pinned-folders';
const ORDER_KEY = 'devharbor:folder-order';
const GROUPMODE_KEY = 'devharbor:group-mode'; // 'folder' | 'tag'
const DRAG_MIME = 'application/x-appmgr-app-id'; // dragging an app
const FOLDER_MIME = 'application/x-appmgr-folder'; // dragging a folder header to reorder

type GroupMode = 'folder' | 'tag';

/** Read/write helpers for our two localStorage blobs (collapse state + pinned folder list). */
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore — storage unavailable / quota'd
  }
}

export function Sidebar({
  onAddApp,
  onOpenSettings,
  onOpenPalette
}: {
  onAddApp: () => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
}): JSX.Element {
  const apps = useStore((s) => s.apps);
  const view = useStore((s) => s.view);
  const selected = useStore((s) => s.selectedAppId);
  const lastState = useStore((s) => s.appState);
  const setSelected = useStore((s) => s.setSelected);
  const setView = useStore((s) => s.setView);
  const removeApp = useStore((s) => s.removeApp);
  const upsertApp = useStore((s) => s.upsertApp);
  const filterRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    readJson(COLLAPSE_KEY, {})
  );
  const [pinned, setPinned] = useState<string[]>(() => readJson<string[]>(PINNED_KEY, []));
  // User-chosen folder order (lowercased keys). Folders not listed sort alphabetically
  // after the ordered ones; "(Ungrouped)" is always pinned last.
  const [folderOrder, setFolderOrder] = useState<string[]>(() => readJson<string[]>(ORDER_KEY, []));
  // Group the app list by folder or by tag. A view preference, persisted locally.
  const [groupMode, setGroupMode] = useState<GroupMode>(() =>
    readJson<GroupMode>(GROUPMODE_KEY, 'folder')
  );
  const setGroupModePersist = useCallback((m: GroupMode): void => {
    setGroupMode(m);
    writeJson(GROUPMODE_KEY, m);
  }, []);
  // App sort within the list / each group — shared with the Dashboard via the store, so the
  // two views always agree and stay in sync live. 'name' is the stable default.
  const sortMode = useStore((s) => s.appSort);
  const setSortModePersist = useStore((s) => s.setAppSort);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  // The folder key currently being dragged for reordering (null = not reordering folders).
  const [draggingFolder, setDraggingFolder] = useState<string | null>(null);
  const { open: openMenu, node: menuNode } = useContextMenu();

  const runningCount = apps.filter((a) => {
    const st = lastState[a.id];
    return st === 'running' || st === 'starting' || st === 'exiting';
  }).length;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const isRunning = (id: string): boolean => {
      const st = lastState[id];
      return st === 'running' || st === 'starting' || st === 'exiting';
    };
    const sorted = sortApps(apps, sortMode, isRunning);
    if (!q) return sorted;
    return sorted.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.path.toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [apps, filter, sortMode, lastState]);

  /**
   * Group filtered apps for display. In folder mode, empty pinned folders are unioned in and
   * "(Ungrouped)" is the catch-all. In tag mode, an app appears under every tag it carries
   * (tags are non-exclusive labels) and "(Untagged)" is the catch-all. Both pin the catch-all
   * last. `catchAll` flags the bucket that doesn't support folder actions / reorder.
   */
  const groups = useMemo(() => {
    type Group = {
      displayName: string;
      key: string;
      apps: App[];
      totalCount: number;
      catchAll: boolean;
    };

    if (groupMode === 'tag') {
      const tagKey = (t: string): string => `tag:${t.toLowerCase()}`;
      const untaggedKey = `tag:${UNTAGGED.toLowerCase()}`;
      const totals = new Map<string, number>();
      const displayFor = new Map<string, string>();
      for (const a of apps) {
        if (a.tags.length === 0) {
          totals.set(untaggedKey, (totals.get(untaggedKey) ?? 0) + 1);
        } else {
          for (const t of a.tags) {
            const k = tagKey(t);
            totals.set(k, (totals.get(k) ?? 0) + 1);
            if (!displayFor.has(k)) displayFor.set(k, t);
          }
        }
      }
      const buckets = new Map<string, Group>();
      const ensure = (key: string, displayName: string, catchAll: boolean): Group => {
        let g = buckets.get(key);
        if (!g) {
          g = { displayName, key, apps: [], totalCount: totals.get(key) ?? 0, catchAll };
          buckets.set(key, g);
        }
        return g;
      };
      for (const a of filtered) {
        if (a.tags.length === 0) {
          ensure(untaggedKey, UNTAGGED, true).apps.push(a);
        } else {
          for (const t of a.tags) {
            ensure(tagKey(t), displayFor.get(tagKey(t)) ?? t, false).apps.push(a);
          }
        }
      }
      return [...buckets.values()].sort((a, b) => {
        if (a.catchAll) return 1;
        if (b.catchAll) return -1;
        return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
      });
    }

    // Folder mode (default)
    const ungroupedKey = UNGROUPED.toLowerCase();
    const totals = new Map<string, number>();
    for (const a of apps) {
      const key = (a.folder?.trim() || '').toLowerCase() || ungroupedKey;
      totals.set(key, (totals.get(key) ?? 0) + 1);
    }
    const buckets = new Map<string, Group>();
    // Seed with pinned folders (empty until apps are dropped in).
    for (const p of pinned) {
      const key = p.toLowerCase();
      if (!buckets.has(key)) {
        buckets.set(key, {
          displayName: p,
          key,
          apps: [],
          totalCount: totals.get(key) ?? 0,
          catchAll: false
        });
      }
    }
    for (const a of filtered) {
      const raw = a.folder?.trim() || '';
      const key = (raw || UNGROUPED).toLowerCase();
      const displayName = raw || UNGROUPED;
      let g = buckets.get(key);
      if (!g) {
        g = {
          displayName,
          key,
          apps: [],
          totalCount: totals.get(key) ?? 0,
          catchAll: key === ungroupedKey
        };
        buckets.set(key, g);
      }
      g.apps.push(a);
    }
    // Always include an "(Ungrouped)" bucket if any apps belong there.
    if (totals.has(ungroupedKey) && !buckets.has(ungroupedKey)) {
      buckets.set(ungroupedKey, {
        displayName: UNGROUPED,
        key: ungroupedKey,
        apps: [],
        totalCount: totals.get(ungroupedKey) ?? 0,
        catchAll: true
      });
    }
    const orderIndex = (key: string): number => {
      const i = folderOrder.indexOf(key);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...buckets.values()].sort((a, b) => {
      if (a.key === ungroupedKey) return 1; // ungrouped always last
      if (b.key === ungroupedKey) return -1;
      // User-ordered folders first (by saved index), then any unordered alphabetically.
      const ia = orderIndex(a.key);
      const ib = orderIndex(b.key);
      if (ia !== ib) return ia - ib;
      return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
    });
  }, [apps, filtered, pinned, folderOrder, groupMode]);

  const hasAnyTags = useMemo(() => apps.some((a) => a.tags.length > 0), [apps]);

  /**
   * Whether to render grouped sections vs a flat list. Folder mode groups only when
   * something is foldered/pinned; tag mode groups only when at least one tag exists.
   */
  const anyFoldered = useMemo(
    () => apps.some((a) => a.folder) || pinned.length > 0,
    [apps, pinned]
  );
  const showGrouped = groupMode === 'folder' ? anyFoldered : hasAnyTags;

  const toggleCollapse = useCallback((folderKey: string): void => {
    setCollapsed((prev) => {
      const next = { ...prev, [folderKey]: !prev[folderKey] };
      writeJson(COLLAPSE_KEY, next);
      return next;
    });
  }, []);

  const setAppFolder = useCallback(
    async (app: App, folder: string | null): Promise<void> => {
      try {
        const next = await window.api.invoke('apps:update', {
          id: app.id,
          patch: { folder }
        });
        upsertApp(next);
        // The folder now has an app, so it's no longer an "empty pinned" folder — drop it
        // from the pinned list to keep "pinned = empty folders only" and avoid a zombie
        // empty folder reappearing if its last app later leaves.
        if (folder) {
          setPinned((prev) => {
            if (!prev.some((p) => p.toLowerCase() === folder.toLowerCase())) return prev;
            const nextPinned = prev.filter((p) => p.toLowerCase() !== folder.toLowerCase());
            writeJson(PINNED_KEY, nextPinned);
            return nextPinned;
          });
        }
      } catch (err) {
        console.error('folder change failed', err);
      }
    },
    [upsertApp]
  );

  /** Add a tag to an app (used when dropping an app onto a tag group). Idempotent. */
  const addTagToApp = useCallback(
    async (app: App, tag: string): Promise<void> => {
      const t = tag.trim();
      if (!t || app.tags.some((x) => x.toLowerCase() === t.toLowerCase())) return;
      try {
        const next = await window.api.invoke('apps:update', {
          id: app.id,
          patch: { tags: [...app.tags, t] }
        });
        upsertApp(next);
      } catch (err) {
        console.error('add tag failed', err);
      }
    },
    [upsertApp]
  );

  const addPinnedFolder = useCallback(
    (name: string): void => {
      const trimmed = name.trim();
      if (!trimmed) return;
      // Drop "(Ungrouped)" attempts — that label is reserved.
      if (trimmed.toLowerCase() === UNGROUPED.toLowerCase()) return;
      setPinned((prev) => {
        if (prev.some((p) => p.toLowerCase() === trimmed.toLowerCase())) return prev;
        const next = [...prev, trimmed];
        writeJson(PINNED_KEY, next);
        return next;
      });
    },
    []
  );

  const removePinnedFolder = useCallback((name: string): void => {
    setPinned((prev) => {
      const next = prev.filter((p) => p.toLowerCase() !== name.toLowerCase());
      writeJson(PINNED_KEY, next);
      return next;
    });
  }, []);

  const promptForNewFolder = useCallback(
    async (forApp?: App): Promise<void> => {
      const existing = new Set(
        apps.map((a) => (a.folder?.trim() || '').toLowerCase()).filter(Boolean)
      );
      for (const p of pinned) existing.add(p.toLowerCase());
      const name = await openPrompt({
        title: 'New folder',
        description: forApp
          ? `Create a new folder and move "${forApp.name}" into it.`
          : 'Empty folder shows immediately. Drag apps into it.',
        placeholder: 'e.g. Work · Personal · Side projects',
        confirmLabel: 'Create',
        validate: (v) => {
          const t = v.trim();
          if (!t) return 'Value cannot be empty.';
          if (t.toLowerCase() === UNGROUPED.toLowerCase()) return '"(Ungrouped)" is reserved.';
          if (existing.has(t.toLowerCase())) return `Folder "${t}" already exists.`;
          if (t.length > 60) return 'Max 60 characters.';
          return null;
        }
      });
      if (name == null) return;
      if (forApp) {
        await setAppFolder(forApp, name);
      } else {
        addPinnedFolder(name);
      }
      // A newly created folder only exists in the folder view — switch to it so the
      // result is visible instead of silently landing in a hidden grouping.
      setGroupModePersist('folder');
    },
    [apps, pinned, addPinnedFolder, setAppFolder, setGroupModePersist]
  );

  /** Remove a tag from an app (tag-view counterpart of "Remove from folder"). */
  const removeTagFromApp = useCallback(
    async (app: App, tag: string): Promise<void> => {
      try {
        const next = await window.api.invoke('apps:update', {
          id: app.id,
          patch: { tags: app.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()) }
        });
        upsertApp(next);
      } catch (err) {
        console.error('remove tag failed', err);
      }
    },
    [upsertApp]
  );

  /** Prompt for a brand-new tag and apply it to the app. */
  const promptForNewTag = useCallback(
    async (app: App): Promise<void> => {
      const name = await openPrompt({
        title: 'New tag',
        description: `Add a tag to "${app.name}".`,
        placeholder: 'e.g. api · frontend · project-x',
        confirmLabel: 'Add',
        validate: (v) => {
          const t = v.trim();
          if (!t) return 'Value cannot be empty.';
          if (app.tags.some((x) => x.toLowerCase() === t.toLowerCase()))
            return `Already tagged "${t}".`;
          if (t.length > 30) return 'Max 30 characters.';
          return null;
        }
      });
      if (name == null) return;
      await addTagToApp(app, name);
    },
    [addTagToApp]
  );

  const renameFolder = useCallback(
    async (from: string): Promise<void> => {
      const to = await openPrompt({
        title: `Rename folder "${from}"`,
        defaultValue: from,
        placeholder: 'New folder name',
        confirmLabel: 'Rename',
        validate: (v) => {
          const t = v.trim();
          if (!t) return 'Value cannot be empty.';
          if (t.toLowerCase() === UNGROUPED.toLowerCase()) return '"(Ungrouped)" is reserved.';
          if (t.length > 60) return 'Max 60 characters.';
          return null;
        }
      });
      if (to == null || to === from) return;
      try {
        await window.api.invoke('folders:rename', { from, to });
        // Update pinned list too if this was an empty pinned folder.
        setPinned((prev) => {
          const idx = prev.findIndex((p) => p.toLowerCase() === from.toLowerCase());
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = to;
          writeJson(PINNED_KEY, next);
          return next;
        });
        const list = await window.api.invoke('apps:list', undefined);
        useStore.setState({ apps: list });
      } catch (err) {
        console.error('rename folder failed', err);
      }
    },
    []
  );

  const deleteFolder = useCallback(
    async (name: string, appCount: number): Promise<void> => {
      const ok = await openConfirm({
        title: `Delete folder "${name}"?`,
        description: `${
          appCount ? `${appCount} app${appCount === 1 ? '' : 's'} will move to "(Ungrouped)". ` : ''
        }Files on disk are not affected.`,
        confirmLabel: 'Delete folder',
        danger: true
      });
      if (!ok) return;
      try {
        await window.api.invoke('folders:clear', { name });
        removePinnedFolder(name);
        const list = await window.api.invoke('apps:list', undefined);
        useStore.setState({ apps: list });
      } catch (err) {
        console.error('delete folder failed', err);
      }
    },
    [removePinnedFolder]
  );

  // Cmd+P focuses the filter input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p' && !e.shiftKey) {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // macOS File ▸ Add Folder… (⌘⇧N) → App.tsx relays it here as a DOM event, since the
  // new-folder prompt + pinned-folder bookkeeping live in this component.
  useEffect(() => {
    const onNewFolder = (): void => void promptForNewFolder();
    window.addEventListener('devharbor:new-folder', onNewFolder);
    return () => window.removeEventListener('devharbor:new-folder', onNewFolder);
  }, [promptForNewFolder]);

  /**
   * Build the per-app overflow menu (used by both ⋮ click and right-click).
   * Identical set of actions — the ⋮ button is the primary trigger, right-click is
   * the power-user fallback.
   */
  const buildAppMenu = useCallback(
    (app: App): MenuItem[] => {
      const isLive =
        lastState[app.id] === 'running' ||
        lastState[app.id] === 'starting' ||
        lastState[app.id] === 'exiting';
      // The grouping section of the menu is view-appropriate: folder moves in folder
      // view, tag add/remove in tag view — so the ⋮ menu matches what the user is looking at.
      let moveItems: MenuItem[];
      if (groupMode === 'tag') {
        const appTagsLower = new Set(app.tags.map((t) => t.toLowerCase()));
        const otherTags = [
          ...new Set(apps.flatMap((a) => a.tags).filter((t) => !appTagsLower.has(t.toLowerCase())))
        ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        moveItems = [
          ...otherTags.map<MenuItem>((t, idx) => ({
            label: `Add tag: ${t}`,
            icon: <Tag className="h-3.5 w-3.5" />,
            separatorBefore: idx === 0,
            onSelect: () => void addTagToApp(app, t)
          })),
          {
            label: 'New tag…',
            icon: <Tag className="h-3.5 w-3.5" />,
            separatorBefore: otherTags.length === 0,
            onSelect: () => void promptForNewTag(app)
          },
          ...app.tags.map<MenuItem>((t, idx) => ({
            label: `Remove tag: ${t}`,
            icon: <FolderMinus className="h-3.5 w-3.5" />,
            separatorBefore: idx === 0,
            onSelect: () => void removeTagFromApp(app, t)
          }))
        ];
      } else {
        const existingFolders = [
          ...new Set(
            [
              ...apps.map((a) => a.folder?.trim() || '').filter(Boolean),
              ...pinned
            ].filter((f) => f.toLowerCase() !== (app.folder?.trim() || '').toLowerCase())
          )
        ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        moveItems = [
          ...existingFolders.map<MenuItem>((f, idx) => ({
            label: `→ ${f}`,
            icon: <Folder className="h-3.5 w-3.5" />,
            separatorBefore: idx === 0,
            onSelect: () => void setAppFolder(app, f)
          })),
          {
            label: '→ New folder…',
            icon: <FolderPlus className="h-3.5 w-3.5" />,
            separatorBefore: existingFolders.length === 0,
            onSelect: () => void promptForNewFolder(app)
          },
          ...(app.folder
            ? [
                {
                  label: '→ Remove from folder',
                  icon: <FolderMinus className="h-3.5 w-3.5" />,
                  onSelect: () => void setAppFolder(app, null)
                } as MenuItem
              ]
            : [])
        ];
      }

      return [
        {
          label: 'Open',
          icon: <Eye className="h-3.5 w-3.5" />,
          onSelect: () => setSelected(app.id as AppId)
        },
        {
          label: isLive ? 'Stop' : 'Start',
          icon: isLive ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />,
          onSelect: () =>
            void window.api.invoke(isLive ? 'proc:stop' : 'proc:start', { id: app.id })
        },
        {
          label: 'Restart',
          icon: <RotateCw className="h-3.5 w-3.5" />,
          disabled: !isLive,
          onSelect: () => void window.api.invoke('proc:restart', { id: app.id })
        },
        ...moveItems,
        {
          label: 'Reveal in Finder',
          icon: <Folder className="h-3.5 w-3.5" />,
          separatorBefore: true,
          onSelect: () =>
            void window.api.invoke('openIn:open', { target: 'finder', path: app.path })
        },
        {
          label: 'Open in Terminal',
          icon: <Cog className="h-3.5 w-3.5" />,
          onSelect: () =>
            void window.api.invoke('openIn:open', { target: 'terminal', path: app.path })
        },
        {
          label: 'Remove from DevHarbor…',
          icon: <Trash2 className="h-3.5 w-3.5" />,
          danger: true,
          separatorBefore: true,
          disabled: isLive,
          onSelect: async () => {
            const ok = await openConfirm({
              title: `Remove "${app.name}" from DevHarbor?`,
              description: 'This only removes it from DevHarbor. Files on disk are not deleted.',
              confirmLabel: 'Remove',
              danger: true
            });
            if (!ok) return;
            try {
              await window.api.invoke('apps:remove', { id: app.id });
              removeApp(app.id);
            } catch (err) {
              console.error('remove failed', err);
            }
          }
        }
      ];
    },
    [
      apps,
      pinned,
      lastState,
      groupMode,
      setSelected,
      setAppFolder,
      promptForNewFolder,
      addTagToApp,
      removeTagFromApp,
      promptForNewTag,
      removeApp
    ]
  );

  const onFolderContextMenu = (
    e: React.MouseEvent,
    folderName: string,
    appCount: number
  ): void => {
    const isReserved = folderName === UNGROUPED;
    const items: MenuItem[] = [
      {
        label: 'Rename folder…',
        icon: <Edit3 className="h-3.5 w-3.5" />,
        disabled: isReserved,
        onSelect: () => void renameFolder(folderName)
      },
      {
        label: 'Delete folder',
        icon: <Trash2 className="h-3.5 w-3.5" />,
        danger: true,
        disabled: isReserved,
        separatorBefore: true,
        onSelect: () => void deleteFolder(folderName, appCount)
      }
    ];
    openMenu(e, items);
  };

  /**
   * Persist a new folder order. We anchor the order to the full set of current folder
   * keys (so dragging one folder gives every folder a stable index), excluding ungrouped.
   */
  const reorderFolder = useCallback(
    (draggedKey: string, targetKey: string): void => {
      if (draggedKey === targetKey) return;
      const ungroupedKey = UNGROUPED.toLowerCase();
      const keys = groups.map((g) => g.key).filter((k) => k !== ungroupedKey);
      const from = keys.indexOf(draggedKey);
      const to = keys.indexOf(targetKey);
      if (from === -1 || to === -1) return;
      const next = [...keys];
      next.splice(from, 1);
      next.splice(to, 0, draggedKey);
      setFolderOrder(next);
      writeJson(ORDER_KEY, next);
    },
    [groups]
  );

  // A section accepts drops that depend on the grouping mode:
  //  • folder mode: an APP (move into this folder) or a FOLDER header (reorder folders)
  //  • tag mode: an APP (add this tag) — but not onto the "(Untagged)" catch-all
  // The dataTransfer type tells app-drag from folder-drag apart.
  const onSectionDragOver = (e: React.DragEvent, key: string, catchAll: boolean): void => {
    const types = Array.from(e.dataTransfer.types);
    if (groupMode === 'folder' && types.includes(FOLDER_MIME)) {
      if (catchAll) return; // can't reorder relative to "(Ungrouped)"
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOverKey(key);
    } else if (types.includes(DRAG_MIME)) {
      if (groupMode === 'tag' && catchAll) return; // dropping onto "(Untagged)" is a no-op
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOverKey(key);
    }
  };

  const onSectionDragLeave = (key: string): void => {
    setDragOverKey((cur) => (cur === key ? null : cur));
  };

  const onSectionDrop = (
    e: React.DragEvent,
    group: { key: string; displayName: string; catchAll: boolean }
  ): void => {
    e.preventDefault();
    setDragOverKey(null);

    if (groupMode === 'tag') {
      if (group.catchAll) return; // "(Untagged)" — no-op (clearing tags via DnD is too destructive)
      const appId = e.dataTransfer.getData(DRAG_MIME);
      if (!appId) return;
      const app = apps.find((a) => a.id === appId);
      if (!app) return;
      void addTagToApp(app, group.displayName);
      return;
    }

    // Folder mode — reorder?
    const folderKey = e.dataTransfer.getData(FOLDER_MIME);
    if (folderKey) {
      reorderFolder(folderKey, group.key);
      return;
    }
    // Otherwise: move an app into this folder.
    const appId = e.dataTransfer.getData(DRAG_MIME);
    if (!appId) return;
    const app = apps.find((a) => a.id === appId);
    if (!app) return;
    const targetFolder = group.catchAll ? null : group.displayName;
    if ((app.folder ?? null) === targetFolder) return;
    void setAppFolder(app, targetFolder);
  };

  // Sort picker (radio-style menu): active option gets a check, others their own glyph.
  const openSortMenu = (e: React.MouseEvent): void => {
    const opts: { mode: AppSortMode; label: string; icon: JSX.Element }[] = [
      { mode: 'name', label: 'Name (A–Z)', icon: <ArrowDownAZ className="h-3.5 w-3.5" /> },
      { mode: 'recent', label: 'Recently used', icon: <Clock className="h-3.5 w-3.5" /> },
      { mode: 'running', label: 'Running first', icon: <Play className="h-3.5 w-3.5" /> }
    ];
    const items: MenuItem[] = opts.map((o) => ({
      label: o.label,
      icon: sortMode === o.mode ? <Check className="h-3.5 w-3.5 text-accent" /> : o.icon,
      onSelect: () => setSortModePersist(o.mode)
    }));
    openMenu(e, items);
  };

  return (
    <aside className="titlebar-drag flex w-60 shrink-0 flex-col border-r border-border bg-base">
      <div className="h-10" />
      <div className="titlebar-no-drag flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs uppercase tracking-wide text-fg-subtle">DevHarbor</span>
        <button
          onClick={onOpenPalette}
          className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-fg-muted hover:bg-surface hover:text-fg"
          title="Command palette (⌘ K)"
        >
          <span>⌘ K</span>
        </button>
      </div>
      <nav className="titlebar-no-drag flex-1 overflow-y-auto px-2 py-1">
        <button
          onClick={() => setView('dashboard')}
          className={cn(
            'mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
            view === 'dashboard'
              ? 'bg-surface text-fg'
              : 'text-fg-muted hover:bg-surface/60'
          )}
        >
          <Boxes className="h-[15px] w-[15px]" />
          <span className="flex-1">Dashboard</span>
          {runningCount > 0 && (
            // Reference .mk-badge-run: fixed 18px circle (pill only when ≥2 digits),
            // run-green bg at 90%, dark-green text #05140a (not white).
            <span className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-success-strong/90 px-[5px] text-[11px] font-semibold text-[#05140a]">
              {runningCount}
            </span>
          )}
        </button>

        <div className="mb-2 flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1">
          <Search className="h-3 w-3 text-fg-subtle" />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter apps (⌘ P)"
            className="w-full bg-transparent text-[11px] text-fg outline-none placeholder:text-fg-subtle"
          />
        </div>

        {/* APPS header — label + group-by switcher + action icons. */}
        <div className="mb-1 flex items-center gap-1 px-2 text-[10px] uppercase tracking-wider text-fg-subtle">
          <span className="min-w-0 flex-1 truncate">
            Apps {filter && `· ${filtered.length} of ${apps.length}`}
          </span>
          {/* Finder-style segmented control: organize the list by folder or by tag. */}
          <div className="inline-flex shrink-0 items-center overflow-hidden rounded border border-border">
            <button
              onClick={() => setGroupModePersist('folder')}
              title="Group by folder"
              aria-label="Group by folder"
              aria-pressed={groupMode === 'folder'}
              className={cn(
                'p-1 transition-colors',
                groupMode === 'folder' ? 'bg-surface text-fg' : 'text-fg-subtle hover:text-fg'
              )}
            >
              <Folder className="h-3 w-3" />
            </button>
            <button
              onClick={() => setGroupModePersist('tag')}
              title="Group by tag"
              aria-label="Group by tag"
              aria-pressed={groupMode === 'tag'}
              className={cn(
                'p-1 transition-colors',
                groupMode === 'tag' ? 'bg-surface text-fg' : 'text-fg-subtle hover:text-fg'
              )}
            >
              <Tag className="h-3 w-3" />
            </button>
          </div>
          <button
            onClick={openSortMenu}
            title={`Sort apps — ${
              sortMode === 'name'
                ? 'Name (A–Z)'
                : sortMode === 'recent'
                  ? 'Recently used'
                  : 'Running first'
            }`}
            aria-label="Sort apps"
            className={cn(
              'shrink-0 rounded p-1 hover:bg-surface hover:text-fg',
              sortMode === 'name' ? 'text-fg-subtle' : 'text-accent'
            )}
          >
            <ArrowDownUp className="h-3.5 w-3.5" />
          </button>
          {/* Single "+" combines the two creation actions to keep the header uncluttered.
              Add app stays one keystroke away via ⌘N and ⌘K, so a menu here is fine. */}
          <button
            onClick={(e) =>
              openMenu(e, [
                {
                  label: 'New app…',
                  icon: <Plus className="h-3.5 w-3.5" />,
                  onSelect: onAddApp
                },
                {
                  label: 'New folder…',
                  icon: <FolderPlus className="h-3.5 w-3.5" />,
                  onSelect: () => void promptForNewFolder()
                }
              ])
            }
            title="Add app or folder"
            aria-label="Add app or folder"
            className="shrink-0 rounded p-1 text-fg-subtle hover:bg-surface hover:text-fg"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        {apps.length === 0 && pinned.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-fg-subtle">No apps yet</div>
        ) : filtered.length === 0 && !showGrouped ? (
          <div className="px-2 py-1.5 text-xs text-fg-subtle">No matches</div>
        ) : !showGrouped ? (
          // Flat list: folder mode with nothing foldered, or tag mode with no tags yet.
          <>
            {groupMode === 'tag' && (
              <div className="mb-1 px-2 py-1 text-[11px] leading-snug text-fg-subtle">
                No tags yet. Add tags in an app&apos;s settings (⚙), or drag a tagged app here.
              </div>
            )}
            {filtered.map((a) => (
              <AppRow
                key={a.id}
                app={a}
                state={lastState[a.id]}
                active={view === 'app' && selected === a.id}
                onSelect={() => setSelected(a.id as AppId)}
                onContextMenu={(e) => openMenu(e, buildAppMenu(a))}
                onOpenMenu={(e) => openMenu(e, buildAppMenu(a))}
              />
            ))}
          </>
        ) : (
          groups.map((g) => {
            const isCollapsed = !!collapsed[g.key];
            const isDragOver = dragOverKey === g.key;
            const isDraggingFolderNow = isDragOver && draggingFolder != null;
            // Folder-only affordances (reorder, rename/delete menu) never apply to the
            // catch-all bucket or to tag groups (tags live on apps, not as standalone entities).
            const canFolderActions = groupMode === 'folder' && !g.catchAll;
            // A collapsed group hides its rows — surface a glowing dot on the header when one
            // of its apps is live, so "Running first" / monitoring isn't defeated by collapse.
            const hasRunning = g.apps.some((a) => {
              const st = lastState[a.id];
              return st === 'running' || st === 'starting' || st === 'exiting';
            });
            const headerTitle =
              groupMode === 'tag'
                ? g.catchAll
                  ? 'Apps with no tags.'
                  : `Tag: ${g.displayName}. Drop an app here to add this tag.`
                : g.catchAll
                  ? 'Apps without a folder. Drop apps here to remove their folder.'
                  : `Folder: ${g.displayName}. Drag to reorder · right-click or ⋮ for actions.`;
            return (
              <div
                key={g.key}
                onDragOver={(e) => onSectionDragOver(e, g.key, g.catchAll)}
                onDragLeave={() => onSectionDragLeave(g.key)}
                onDrop={(e) => onSectionDrop(e, g)}
                className={cn(
                  'mb-1.5 rounded-md transition-colors',
                  // App drop → fill highlight. Folder-reorder → top insertion line.
                  isDragOver && !isDraggingFolderNow && 'bg-accent/10 ring-1 ring-accent/40',
                  isDraggingFolderNow && 'border-t-2 border-accent'
                )}
              >
                {/* In folder mode the header is a drag source for reordering; the ⋮ menu and
                    right-click rename/delete match the app rows' affordances. Tag groups omit these. */}
                <div
                  draggable={canFolderActions}
                  onDragStart={(e) => {
                    if (!canFolderActions) return;
                    e.dataTransfer.setData(FOLDER_MIME, g.key);
                    e.dataTransfer.effectAllowed = 'move';
                    setDraggingFolder(g.key);
                  }}
                  onDragEnd={() => setDraggingFolder(null)}
                  className="group flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] uppercase tracking-wider text-fg-subtle hover:bg-surface/60"
                >
                  <button
                    onClick={() => toggleCollapse(g.key)}
                    onContextMenu={
                      canFolderActions
                        ? (e) => onFolderContextMenu(e, g.displayName, g.totalCount)
                        : undefined
                    }
                    className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-fg-muted"
                    title={headerTitle}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    )}
                    {groupMode === 'tag' && !g.catchAll && (
                      <Tag className="h-2.5 w-2.5 shrink-0 text-accent" />
                    )}
                    <span className="flex-1 truncate normal-case tracking-normal text-fg-muted">
                      {g.displayName}
                    </span>
                  </button>
                  {isCollapsed && hasRunning && (
                    <span
                      className="status-dot status-dot-run shrink-0"
                      title="An app in this group is running"
                      aria-label="Group has a running app"
                    />
                  )}
                  {canFolderActions && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onFolderContextMenu(e, g.displayName, g.totalCount);
                      }}
                      className="shrink-0 rounded p-0.5 text-fg-subtle opacity-0 transition-opacity hover:bg-elevated hover:text-fg group-hover:opacity-100"
                      title="Folder actions"
                      aria-label={`Actions for folder ${g.displayName}`}
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {groupMode === 'folder' && !isCollapsed && g.apps.length === 0 && (
                  <div className="pl-5 pr-2 py-1 text-[11px] italic text-fg-subtle">
                    Empty — drop apps here.
                  </div>
                )}
                {!isCollapsed &&
                  g.apps.map((a) => (
                    <AppRow
                      key={a.id}
                      app={a}
                      state={lastState[a.id]}
                      active={view === 'app' && selected === a.id}
                      onSelect={() => setSelected(a.id as AppId)}
                      onContextMenu={(e) => openMenu(e, buildAppMenu(a))}
                      onOpenMenu={(e) => openMenu(e, buildAppMenu(a))}
                      indent
                    />
                  ))}
              </div>
            );
          })
        )}
      </nav>
      {/* Settings gear — bottom-LEFT, dim (reference .mk-side-foot: padding 12px 8px,
          left-aligned, opacity 0.55, size 15). "+ Add app" lives in the APPS header. */}
      {/* Settings as a full-width nav row — bookends the Dashboard entry at the top.
          Replaces the lone dim gear (balanced + more discoverable). ⌘, also opens it. */}
      <div className="titlebar-no-drag border-t border-border p-2">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-muted hover:bg-surface/60 hover:text-fg"
          title="Settings (⌘ ,)"
          aria-label="Settings"
        >
          <Settings className="h-[15px] w-[15px]" />
          <span className="flex-1">Settings</span>
        </button>
      </div>
      {menuNode}
    </aside>
  );
}

/**
 * One app row. Three slots:
 *   [status dot]  [name]  [⋮ menu trigger (hover)]
 *
 * Single status dot (green+glow when running, muted otherwise) — consistent with the
 * dashboard, recent strip, and detail header. The ⋮ trigger lives on the right.
 */
function AppRow({
  app,
  state,
  active,
  onSelect,
  onContextMenu,
  onOpenMenu,
  indent = false
}: {
  app: App;
  state: ProcessState | undefined;
  active: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onOpenMenu: (e: React.MouseEvent) => void;
  indent?: boolean;
}): JSX.Element {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, app.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={cn(
        'group mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 text-left text-sm',
        indent ? 'pl-5 pr-1' : 'pl-2 pr-1',
        active ? 'bg-surface text-fg' : 'text-fg-muted hover:bg-surface/60'
      )}
    >
      <StatusDot state={state} />
      <span className="flex-1 truncate">{app.name}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onOpenMenu(e);
        }}
        title="More actions"
        aria-label={`More actions for ${app.name}`}
        className={cn(
          'shrink-0 rounded p-0.5 text-fg-subtle opacity-0 transition-opacity hover:bg-elevated hover:text-fg',
          // Always show on the active row so the trigger is discoverable without hover.
          (active ? 'opacity-100' : 'group-hover:opacity-100')
        )}
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
