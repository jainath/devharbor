import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { db, closeDb } from './db/index.js';
import { registerAllIpcHandlers } from './ipc/index.js';
import { installAppMenu } from './menu.js';

const isDev = process.env.NODE_ENV === 'development' || !!process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | null = null;

// Single-instance lock: a second launch (or a deep-link open) focuses the existing
// window instead of spawning a second process with its own DB handle.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Re-launching while an instance holds the lock must surface a window. Previously this
    // only focused an EXISTING window — if all windows were closed (app still alive on
    // macOS), the second launch did nothing, so the app looked like it "won't open".
    getOrCreateWindow();
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#18181b', // matches the zinc-900 theme base — no launch color flash
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

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Only forward http(s) — refuse file://, mailto:, etc. that a compromised
    // renderer could try to abuse.
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {
      // Invalid URL — ignore.
    }
    return { action: 'deny' };
  });

  // Navigation guard: the renderer should never navigate the main window away from its
  // own document (loaded from file:// in prod, the dev server in dev). Any other target
  // is opened externally instead, so a compromised renderer can't replace the app shell.
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    if (url === current) return;
    // Compare by ORIGIN, not string prefix — a prefix check would let
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
  db();
  registerAllIpcHandlers(() => mainWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  closeDb();
});
