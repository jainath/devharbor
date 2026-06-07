import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Apps launched from Finder/Spotlight inherit a stripped PATH that lacks the user's
 * shell additions (pnpm, asdf shims, /opt/homebrew, etc.). Probing a login shell on
 * startup captures the *real* PATH the user sees in their terminal, which we then use
 * as the base for spawned children.
 *
 * Cached for the app's lifetime.
 */
export class PathProbe {
  private cached: string | null = null;
  private probed = false;

  /** Returns the probed PATH, or process.env.PATH if probing fails. */
  async get(): Promise<string> {
    if (this.probed) return this.cached ?? process.env.PATH ?? '/usr/bin:/bin';
    this.probed = true;
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      // `-l` login, `-i` interactive — read full user rc files. `print -r --` is zsh-safe
      // and bash treats it as printing a string too.
      const { stdout } = await execFileP(shell, ['-l', '-i', '-c', 'printf %s "$PATH"'], {
        timeout: 3000,
        maxBuffer: 1 << 20
      });
      const probed = stdout.trim();
      if (probed) {
        this.cached = probed;
        return probed;
      }
    } catch {
      // Fall through to process.env.PATH
    }
    return process.env.PATH ?? '/usr/bin:/bin';
  }
}
