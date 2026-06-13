import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Unique markers printed around the real PATH so we can recover it from stdout that may
 * also contain interactive-rc noise (banners, version-manager warnings, etc.). They must
 * be unlikely to appear in any legitimate PATH or rc output.
 */
const PATH_BEGIN = '__DH_PATH_BEGIN__';
const PATH_END = '__DH_PATH_END__';

/**
 * Recovers the real PATH from probe stdout. Prefers the substring between the sentinels
 * (so rc banners/warnings printed before or after the marker are discarded). If the
 * markers are missing - e.g. an old shell that mangled the printf - falls back to the last
 * non-empty line, which is the most likely place for a bare `echo $PATH`-style value.
 * Returns '' when nothing usable is found so the caller can drop to process.env.PATH.
 */
function extractPath(stdout: string): string {
  const start = stdout.indexOf(PATH_BEGIN);
  const end = stdout.indexOf(PATH_END, start + PATH_BEGIN.length);
  if (start !== -1 && end !== -1) {
    return stdout.slice(start + PATH_BEGIN.length, end).trim();
  }
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) return line;
  }
  return '';
}

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
      // `-l` login, `-i` interactive - read full user rc files. But `-i` runs the user's
      // interactive rc, and anything those files print to stdout (shell banners,
      // fastfetch/neofetch, "nvm is not compatible…" warnings, fnm/asdf messages) lands in
      // our captured stdout and would corrupt PATH. Wrap the real value in unique sentinels
      // so we can slice out exactly the PATH and discard any surrounding rc noise.
      const { stdout } = await execFileP(
        shell,
        ['-l', '-i', '-c', `printf '${PATH_BEGIN}%s${PATH_END}' "$PATH"`],
        {
          timeout: 3000,
          maxBuffer: 1 << 20
        }
      );
      const probed = extractPath(stdout);
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
