import { app, BrowserWindow } from 'electron';
import type { AppRegistry } from './AppRegistry';
import type { AppOrchestrator } from './AppOrchestrator';
import type { AppId } from '@shared/types';

const PROTOCOL = 'devharbor';

/**
 * Custom `devharbor://` protocol handler.
 *
 * Supported URLs:
 *   - devharbor://open?path=/abs/path     → focus the app for that path (or surface
 *                                            an "unknown path" event so the renderer
 *                                            can offer to register it).
 *   - devharbor://open?id=<appId>         → focus by id
 *   - devharbor://start?id=<appId>        → focus the app and ask the renderer to CONFIRM
 *                                            starting it (never starts silently — a link
 *                                            from any web page must not run shell commands
 *                                            without the user's consent)
 *
 * Side-effects (via callbacks):
 *   - `focusWindow` brings the BrowserWindow forward.
 *   - `getWin().webContents.send` pushes `deepLink:focusApp` / `deepLink:unknownPath`
 *     so the renderer can update its selection.
 */
export class DeepLinks {
  constructor(
    private readonly registry: AppRegistry,
    private readonly orchestrator: AppOrchestrator,
    private readonly focusWindow: () => void,
    private readonly getWin: () => BrowserWindow | null
  ) {
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [process.argv[1]!]);
      }
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }

    app.on('open-url', (event, url) => {
      event.preventDefault();
      void this.handle(url);
    });

    // Cold start on macOS comes in via open-url after whenReady; nothing to drain.
  }

  async handle(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol.replace(':', '') !== PROTOCOL) return;

    const host = parsed.host || parsed.pathname.replace(/^\/+/, '').split('/')[0] || '';
    const params = parsed.searchParams;

    this.focusWindow();
    const win = this.getWin();
    if (!win) return;

    if (host === 'open') {
      const id = params.get('id');
      const path = params.get('path');
      if (id) {
        const a = this.registry.get(id as AppId);
        if (a) {
          win.webContents.send('deepLink:focusApp', { appId: a.id });
          return;
        }
      }
      if (path) {
        const existing = this.registry.getByPath(path);
        if (existing) {
          win.webContents.send('deepLink:focusApp', { appId: existing.id });
        } else {
          win.webContents.send('deepLink:unknownPath', { path });
        }
      }
    } else if (host === 'start') {
      const id = params.get('id');
      if (id) {
        const a = this.registry.get(id as AppId);
        if (a) {
          // Focus + ask the renderer to confirm. Starting an app runs its tasks (custom
          // tasks execute via a login shell), so we never trigger that straight from a URL.
          win.webContents.send('deepLink:focusApp', { appId: a.id });
          win.webContents.send('deepLink:confirmStart', { appId: a.id, appName: a.name });
        }
      }
    }
  }
}
