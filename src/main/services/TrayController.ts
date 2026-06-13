import { Tray, Menu, nativeImage, type MenuItemConstructorOptions } from 'electron';
import type { AppId, ProcessState } from '@shared/types';

export interface TrayApp {
  id: AppId;
  name: string;
  state: ProcessState;
  ports: number[];
}

export interface TrayCallbacks {
  listApps: () => TrayApp[];
  start: (id: AppId) => void;
  stop: (id: AppId) => void;
  stopAll: () => void;
  open: () => void;
  quit: () => void;
}

function isLive(s: ProcessState): boolean {
  return s === 'running' || s === 'starting' || s === 'exiting';
}

/**
 * Menubar (Tray) presence (IMPROVEMENT-PLAN 14.1). A supervisor for long-running background
 * processes is exactly the category that lives in the menubar - the app already keeps servers
 * running with its window closed, but had zero ambient surface to see/control them. The tray
 * icon reflects aggregate state and its menu lists every app with Start/Stop + detected ports.
 * Pure main-process: all state flows through the callbacks; no renderer dependency.
 */
export class TrayController {
  private tray: Tray | null = null;

  constructor(private readonly cb: TrayCallbacks) {}

  enable(): void {
    if (this.tray) return;
    try {
      this.tray = new Tray(this.makeIcon('idle'));
      this.tray.setToolTip('DevHarbor');
      this.refresh();
    } catch {
      // Tray creation can fail in a display-less environment - never let it block boot.
      this.tray = null;
    }
  }

  disable(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  get enabled(): boolean {
    return this.tray !== null;
  }

  /** Rebuild the menu + icon from current state. Call on any task status change. */
  refresh(): void {
    if (!this.tray) return;
    const apps = this.cb.listApps();
    const runningCount = apps.filter((a) => isLive(a.state)).length;
    const anyCrashed = apps.some((a) => a.state === 'crashed');

    this.tray.setImage(this.makeIcon(anyCrashed ? 'crashed' : runningCount > 0 ? 'running' : 'idle'));
    this.tray.setToolTip(
      runningCount > 0 ? `DevHarbor - ${runningCount} running` : 'DevHarbor - idle'
    );

    const appItems: MenuItemConstructorOptions[] = apps
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => {
        const live = isLive(a.state);
        const portLabel = a.ports.length ? `  :${a.ports.join(' :')}` : '';
        const dot = a.state === 'crashed' ? '⊘' : live ? '●' : '○';
        return {
          label: `${dot} ${a.name}${portLabel}`,
          submenu: [
            { label: live ? 'Stop' : 'Start', click: () => (live ? this.cb.stop(a.id) : this.cb.start(a.id)) }
          ]
        } satisfies MenuItemConstructorOptions;
      });

    const template: MenuItemConstructorOptions[] = [
      { label: 'Open DevHarbor', click: () => this.cb.open() },
      { type: 'separator' },
      ...(appItems.length ? appItems : [{ label: 'No apps registered', enabled: false }]),
      { type: 'separator' },
      { label: 'Stop all', enabled: runningCount > 0, click: () => this.cb.stopAll() },
      { type: 'separator' },
      { label: 'Quit DevHarbor', click: () => this.cb.quit() }
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  /**
   * Render a tiny template-image dot so the menubar icon tints to the macOS theme. A filled
   * dot for idle, a ringed dot for running, an X-ish mark for crashed - distinguishable
   * without colour (the menubar is monochrome anyway).
   */
  private makeIcon(kind: 'idle' | 'running' | 'crashed'): Electron.NativeImage {
    const size = 36; // rendered at 2x for crisp retina menubars (18pt logical)
    const canvas = drawDot(size, kind);
    const img = nativeImage.createFromBuffer(canvas, { width: size, height: size, scaleFactor: 2 });
    img.setTemplateImage(true);
    return img;
  }
}

/**
 * Minimal RGBA bitmap of a centered glyph. Avoids shipping icon assets for the tray: a solid
 * disc (idle/running) or a ring with a gap (crashed). Template image → macOS recolours it.
 */
function drawDot(size: number, kind: 'idle' | 'running' | 'crashed'): Buffer {
  const buf = Buffer.alloc(size * size * 4, 0);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rOuter = size * 0.34;
  const rInner = size * 0.18;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      let on = false;
      if (kind === 'running') {
        on = d <= rOuter && d >= rInner; // ring
      } else if (kind === 'crashed') {
        // X mark
        on = (Math.abs(x - y) <= 1 || Math.abs(x + y - (size - 1)) <= 1) && d <= rOuter;
      } else {
        on = d <= rOuter; // solid disc
      }
      if (on) {
        const i = (y * size + x) * 4;
        buf[i] = 0;
        buf[i + 1] = 0;
        buf[i + 2] = 0;
        buf[i + 3] = 255;
      }
    }
  }
  return buf;
}
