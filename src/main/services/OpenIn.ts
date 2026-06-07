import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shell } from 'electron';

const execFileP = promisify(execFile);

export type OpenInTarget = 'finder' | 'terminal' | 'vscode' | 'cursor' | 'sublime';

export interface OpenInCapabilities {
  finder: boolean;
  terminal: boolean;
  vscode: boolean;
  cursor: boolean;
  sublime: boolean;
}

/**
 * macOS .app bundle names per editor. We detect by bundle existence and launch via
 * `open -a "<App Name>"` — NOT by probing CLI shims (`code`, `cursor`, `subl`) on PATH.
 *
 * Why: a GUI-launched macOS app inherits a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`)
 * that excludes `/usr/local/bin` and `/opt/homebrew/bin` where those CLI shims live. So
 * `which code` would fail even when VS Code is installed, leaving "Open in" disabled.
 * Bundle detection + `open -a` is PATH-independent and reliable.
 */
const EDITORS: Record<'vscode' | 'cursor' | 'sublime', { appName: string; bundles: string[] }> = {
  vscode: { appName: 'Visual Studio Code', bundles: ['Visual Studio Code.app'] },
  cursor: { appName: 'Cursor', bundles: ['Cursor.app'] },
  sublime: { appName: 'Sublime Text', bundles: ['Sublime Text.app', 'Sublime Text 4.app'] }
};

function bundleExists(bundles: string[]): boolean {
  const dirs = ['/Applications', join(homedir(), 'Applications')];
  for (const dir of dirs) {
    for (const b of bundles) {
      if (existsSync(join(dir, b))) return true;
    }
  }
  return false;
}

/**
 * Ask LaunchServices whether an app of this display name is installed ANYWHERE
 * (Setapp, nested folders, /Applications/Utilities, etc.) — `open -a "<name>"` resolves
 * the same way, so this matches what the launch will actually do. Returns false on any
 * error (osascript exits non-zero when the app is unknown).
 */
async function launchServicesKnows(appName: string): Promise<boolean> {
  try {
    await execFileP('osascript', ['-e', `id of application "${appName}"`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Open in" dispatcher for the AppDetail header.
 *
 * - Finder + Terminal: always available on macOS.
 * - VS Code / Cursor / Sublime: detected by their installed `.app` bundle.
 */
export class OpenIn {
  private capsCache: OpenInCapabilities | null = null;

  async caps(): Promise<OpenInCapabilities> {
    if (this.capsCache) return this.capsCache;
    // Fast path: bundle present in the standard dirs. Fallback: ask LaunchServices, which
    // finds the app wherever it's installed — matching what `open -a` will actually do.
    const detect = async (e: { appName: string; bundles: string[] }): Promise<boolean> =>
      bundleExists(e.bundles) || launchServicesKnows(e.appName);
    const [vscode, cursor, sublime] = await Promise.all([
      detect(EDITORS.vscode),
      detect(EDITORS.cursor),
      detect(EDITORS.sublime)
    ]);
    this.capsCache = { finder: true, terminal: true, vscode, cursor, sublime };
    return this.capsCache;
  }

  async open(target: OpenInTarget, path: string): Promise<void> {
    if (!existsSync(path)) {
      throw new Error(`Path no longer exists: ${path}`);
    }
    switch (target) {
      case 'finder':
        shell.showItemInFolder(path);
        return;
      case 'terminal':
        await execFileP('open', ['-a', 'Terminal', path]);
        return;
      case 'vscode':
        await execFileP('open', ['-a', EDITORS.vscode.appName, path]);
        return;
      case 'cursor':
        await execFileP('open', ['-a', EDITORS.cursor.appName, path]);
        return;
      case 'sublime':
        await execFileP('open', ['-a', EDITORS.sublime.appName, path]);
        return;
    }
  }
}
