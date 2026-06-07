import { BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

/**
 * Auto-update plumbing.
 *
 * Phase 4: wired but NOT activated — no release feed is configured yet (that's Phase 5
 * packaging + signing). We listen for events and forward an `update:ready` IPC payload
 * to the renderer when the time comes; for now `start()` is a no-op unless the host
 * environment has a feed URL set.
 */
export class Updater {
  private started = false;

  constructor(private readonly getWin: () => BrowserWindow | null) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      this.getWin()?.webContents.send('update:available', { version: info.version });
    });
    autoUpdater.on('download-progress', (p) => {
      this.getWin()?.webContents.send('update:progress', {
        percent: Math.round(p.percent),
        bytesPerSecond: p.bytesPerSecond,
        transferred: p.transferred,
        total: p.total
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.getWin()?.webContents.send('update:ready', { version: info.version });
    });
    autoUpdater.on('error', (err) => {
      console.warn('[updater]', err.message);
    });
  }

  /** Check for updates if a feed is configured. Safe to call repeatedly. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // electron-updater throws if no feed (or no app-update.yml) is configured — silence it.
    autoUpdater.checkForUpdates().catch(() => {
      // No feed configured yet (Phase 5). That's fine in dev/v0.1.x.
    });
  }

  quitAndInstall(): void {
    autoUpdater.quitAndInstall(true, true);
  }
}
