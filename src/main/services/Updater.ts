import { BrowserWindow } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';

/** How often to re-poll the release feed after the initial launch check. */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Auto-update plumbing - ACTIVE in production.
 *
 * The packaged app ships an `app-update.yml` pointing at the GitHub Releases feed, so
 * `start()` actually polls for updates: once on launch, then every 6 hours. We forward
 * the full lifecycle to the renderer over IPC (`update:available` / `update:progress` /
 * `update:ready` / `update:notAvailable` / `update:error`) so the UI can surface
 * progress, release notes, and failures instead of swallowing them.
 *
 * In dev (or any build without a feed) `checkForUpdates()` rejects; we swallow that
 * rejection so the absence of a feed is a no-op rather than a thrown error.
 */
export class Updater {
  private started = false;
  /** Handle for the periodic re-check timer so start() can't stack duplicate intervals. */
  private recheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly getWin: () => BrowserWindow | null) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      this.getWin()?.webContents.send('update:available', {
        version: info.version,
        releaseNotes: Updater.normalizeReleaseNotes(info)
      });
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
      this.getWin()?.webContents.send('update:ready', {
        version: info.version,
        releaseNotes: Updater.normalizeReleaseNotes(info)
      });
    });
    autoUpdater.on('update-not-available', (info) => {
      // Lets a manual "Check for Updates…" confirm the app is current instead of going silent.
      this.getWin()?.webContents.send('update:notAvailable', { version: info.version });
    });
    autoUpdater.on('error', (err) => {
      // Keep the local log, but also surface the failure so the UI doesn't fail silently.
      console.warn('[updater]', err.message);
      this.getWin()?.webContents.send('update:error', { message: err.message });
    });
  }

  /**
   * Begin update polling: an immediate check plus a 6-hour repeating check so a
   * long-running session still picks up releases. Guarded so it only arms once;
   * use {@link checkNow} for explicit user-triggered checks.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Re-assert the download/install flags - stop() clears them when auto-update is
    // toggled off, and the user may have toggled it back on in the same session.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // electron-updater rejects if no feed (or no app-update.yml) is configured - silence it;
    // any real failure is reported via the 'error' handler above.
    autoUpdater.checkForUpdates().catch(() => {
      // No feed configured (dev build). That's fine.
    });
    this.recheckTimer = setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, RECHECK_INTERVAL_MS);
  }

  /**
   * Manual "Check for Updates…" trigger. Unlike {@link start} it has no started-once
   * guard, so the user can re-check on demand; errors surface via the 'error' handler.
   */
  checkNow(): void {
    autoUpdater.checkForUpdates().catch(() => {});
  }

  /**
   * Stop background polling - called when the user turns auto-update OFF in Settings.
   * Without this, disabling the setting only took effect after a relaunch: the 6-hour
   * interval kept checking and a downloaded update would still install on quit.
   */
  stop(): void {
    if (this.recheckTimer) {
      clearInterval(this.recheckTimer);
      this.recheckTimer = null;
    }
    this.started = false;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
  }

  quitAndInstall(): void {
    autoUpdater.quitAndInstall(true, true);
  }

  /**
   * Collapse electron-updater's polymorphic `releaseNotes` (string, array of
   * `{ note }`, or null/undefined) into a single string for the renderer. Array notes
   * are joined with newlines; nullish notes become `undefined` so the payload omits them.
   */
  private static normalizeReleaseNotes(info: UpdateInfo): string | undefined {
    const notes = info.releaseNotes;
    if (typeof notes === 'string') return notes;
    if (Array.isArray(notes)) {
      const joined = notes
        .map((n) => n.note ?? '')
        .filter((note) => note.length > 0)
        .join('\n');
      return joined.length > 0 ? joined : undefined;
    }
    return undefined;
  }
}
