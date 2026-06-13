import { app, BrowserWindow, dialog, screen, shell } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, closeDb } from './db/index.js';
import { registerAllIpcHandlers, type IpcRuntime } from './ipc/index.js';
import { installAppMenu } from './menu.js';
import { installProcessLogging, logger } from './services/Logger.js';

const isDev = process.env.NODE_ENV === 'development' || !!process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | null = null;
let ipcRuntime: IpcRuntime | null = null;
let isQuitting = false;

interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

function boundsFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

/** Restore the last window bounds, validated against currently-connected displays. */
function loadBounds(): WindowBounds {
  const fallback: WindowBounds = { width: 1280, height: 820 };
  try {
    const raw = readFileSync(boundsFile(), 'utf8');
    const b = JSON.parse(raw) as Partial<WindowBounds>;
    if (typeof b.width !== 'number' || typeof b.height !== 'number') return fallback;
    const w = Math.max(960, Math.min(b.width, 8000));
    const h = Math.max(600, Math.min(b.height, 8000));
    // Only keep x/y if the window would land on some connected display (avoid off-screen).
    if (typeof b.x === 'number' && typeof b.y === 'number') {
      const onScreen = screen.getAllDisplays().some((d) => {
        const wa = d.workArea;
        return b.x! < wa.x + wa.width && b.x! + w > wa.x && b.y! < wa.y + wa.height && b.y! + h > wa.y;
      });
      if (onScreen) return { x: b.x, y: b.y, width: w, height: h };
    }
    return { width: w, height: h };
  } catch {
    return fallback;
  }
}

function saveBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    writeFileSync(boundsFile(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }));
  } catch {
    // ignore
  }
}

// Single-instance lock: a second launch (or a deep-link open) focuses the existing
// window instead of spawning a second process with its own DB handle.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Re-launching while an instance holds the lock must surface a window. Previously this
    // only focused an EXISTING window - if all windows were closed (app still alive on
    // macOS), the second launch did nothing, so the app looked like it "won't open".
    getOrCreateWindow();
  });
}

function createWindow(): BrowserWindow {
  const bounds = loadBounds();
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#18181b', // matches the zinc-900 theme base - no launch color flash
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = win;

  win.once('ready-to-show', () => win.show());

  // Persist window size/position so the app reopens where the user left it.
  win.on('close', () => saveBounds(win));

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Reset per-renderer main-process state (log subscriptions) on reload/navigation, so a ⌘R
  // can't leave log forwarding gated to taskIds the new renderer never subscribed to.
  win.webContents.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) ipcRuntime?.onRendererReload();
  });

  // Renderer crash recovery: a GPU/OOM crash (xterm WebGL contexts are a realistic source)
  // would otherwise leave a blank window. Reload once so it self-heals - running PTYs live in
  // the main process and survive (IMPROVEMENT-PLAN 13.2).
  let reloadAttempts = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error('render-process-gone', details.reason, details.exitCode);
    if (reloadAttempts < 2 && details.reason !== 'clean-exit' && !win.isDestroyed()) {
      reloadAttempts += 1;
      win.webContents.reload();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Only forward http(s) - refuse file://, mailto:, etc. that a compromised
    // renderer could try to abuse.
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {
      // Invalid URL - ignore.
    }
    return { action: 'deny' };
  });

  // Navigation guard: the renderer should never navigate the main window away from its
  // own document (loaded from file:// in prod, the dev server in dev). Any other target
  // is opened externally instead, so a compromised renderer can't replace the app shell.
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    if (url === current) return;
    // Compare by ORIGIN, not string prefix - a prefix check would let
    // `http://localhost:5173.evil.com` pass as the dev server.
    let sameDevServer = false;
    if (process.env.ELECTRON_RENDERER_URL) {
      try {
        sameDevServer =
          new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin;
      } catch {
        sameDevServer = false;
      }
    }
    if (sameDevServer) return;
    event.preventDefault();
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(url);
      }
    } catch {
      // ignore invalid URLs
    }
  });

  // Block <webview> embedding outright (we never use it).
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  if (isDev) {
    win.webContents.openDevTools({ mode: 'right' });
  }

  return win;
}

/**
 * Return the main window, creating it if there isn't one (the app keeps running on macOS
 * with all windows closed). `created` lets the caller wait for the renderer to load before
 * sending it a message. Used by the application menu so ⌘, / ⌘N / ⌘⇧N aren't dead keys.
 */
function getOrCreateWindow(): { win: BrowserWindow; created: boolean } {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return { win: mainWindow, created: false };
  }
  return { win: createWindow(), created: true };
}

app.whenReady().then(() => {
  // Route uncaught exceptions / rejections to the local log file for support diagnostics.
  installProcessLogging();

  // Configure the macOS About panel ( ⌘ → DevHarbor → About DevHarbor ).
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: 'DevHarbor',
      applicationVersion: app.getVersion(),
      version: app.getVersion(),
      copyright: 'Copyright © 2026 Jainath Ponnala',
      credits: 'A harbor for your local dev servers. Licensed under GNU AGPL-3.0.',
      website: 'https://www.devharbor.app'
    });
  }

  installAppMenu(isDev, getOrCreateWindow);
  // Opening the DB can fail (corrupt file, half-applied migration). Surface it instead of
  // launching to a dock icon with no window and no error (IMPROVEMENT-PLAN 8.1).
  try {
    db();
  } catch (e) {
    logger.error('database open/migration failed', e);
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'DevHarbor - database error',
      message: 'DevHarbor could not open its database.',
      detail: `${(e as Error).message}\n\nThe database is at:\n${join(app.getPath('userData'), 'devharbor.db')}\n\nYou can move the corrupt database aside and start fresh, or quit.`,
      buttons: ['Move aside & restart', 'Quit'],
      defaultId: 0,
      cancelId: 1
    });
    if (choice === 0) {
      try {
        const p = join(app.getPath('userData'), 'devharbor.db');
        for (const suffix of ['', '-wal', '-shm']) {
          if (existsSync(`${p}${suffix}`)) {
            writeFileSync(`${p}${suffix}.corrupt-${Date.now()}.bak`, readFileSync(`${p}${suffix}`));
          }
        }
        for (const suffix of ['', '-wal', '-shm']) rmSync(`${p}${suffix}`, { force: true });
      } catch (moveErr) {
        logger.error('failed to move corrupt DB aside', moveErr);
      }
      app.relaunch();
    }
    app.exit(choice === 0 ? 0 : 1);
    return;
  }
  ipcRuntime = registerAllIpcHandlers(() => mainWindow, getOrCreateWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Graceful teardown on quit (including auto-update's quitAndInstall). The whole point of the
// app is "stop apps cleanly, no orphans" - but the only quit hook used to be closeDb(), so
// running dev servers were killed abruptly via PTY teardown (or survived as orphans). Now we
// confirm, run the reverse-topo graceful stop, then close the DB last (IMPROVEMENT-PLAN 5.9).
let teardownInFlight = false;

app.on('before-quit', (event) => {
  if (isQuitting) return; // teardown finished - let the final quit proceed
  if (teardownInFlight) {
    // A second ⌘Q / dock-quit while we're still stopping tasks must NOT bypass the teardown
    // (it would abandon the SIGTERM→grace sequence mid-flight and skip the DB close).
    event.preventDefault();
    return;
  }
  const running = ipcRuntime?.runningTaskCount() ?? 0;
  if (running === 0) {
    closeDb();
    return;
  }
  event.preventDefault();
  teardownInFlight = true;
  void (async () => {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Quit DevHarbor?',
      message: `${running} running ${running === 1 ? 'task is' : 'tasks are'} still active.`,
      detail: 'DevHarbor will stop your running dev servers before quitting.',
      buttons: ['Stop & Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    });
    if (response !== 0) {
      teardownInFlight = false;
      return; // cancelled - stay open
    }
    try {
      await ipcRuntime?.stopAllRunning();
    } catch (e) {
      logger.error('teardown on quit failed', e);
    }
    closeDb();
    isQuitting = true;
    app.quit();
  })();
});
