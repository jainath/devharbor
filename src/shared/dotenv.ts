/**
 * The single .env parser + secret heuristic, shared by main and renderer.
 *
 * Previously this logic was copy-pasted in three places (EnvBuilder, EnvEditor,
 * AddAppDrawer) and had already drifted - the main-side copy expanded `\n`/`\r`/`\t`
 * inside double-quoted values while the renderer copies did not, so a pasted `.env`
 * parsed differently than the same file read at spawn time. This is now the one source.
 */

/**
 * Find the index of the first unescaped `"` in `s` at or after `from`.
 * Used to locate the closing quote of a double-quoted value: a `\"` inside the
 * value is an escaped quote and must not terminate the string (matches
 * motdotla/dotenv, which lets PEM blocks and JSON survive intact). Returns -1
 * when no unescaped closing quote exists on this physical segment.
 */
function findClosingDoubleQuote(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '"') {
      // Count the run of backslashes immediately preceding this quote; an even
      // count (including zero) means the quote itself is unescaped.
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) backslashes++;
      if (backslashes % 2 === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse a `.env` blob into a key→value map. Comments + blank lines ignored.
 *
 * Index-based rather than a simple `for…of` over split lines because a
 * double-quoted value may span multiple physical lines (e.g. a `PRIVATE_KEY`
 * PEM block). When the opening `"` has no unescaped closing `"` on its own line,
 * subsequent lines are consumed verbatim (newline-joined) until the closing
 * quote is found - otherwise such a value would be truncated to its first line
 * with a stray leading quote, and EnvBuilder would inject that mangled fragment
 * into the spawned process env where it WINS over the framework's own dotenv.
 */
export function parseDotEnv(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // `lines[i]` is always defined (i < lines.length), but noUncheckedIndexedAccess
    // widens it to `string | undefined`; the `?? ''` is the narrowing, not a default.
    const line = (lines[i] ?? '').trim();
    if (!line || line.startsWith('#')) continue;
    // Strip an optional `export ` prefix (e.g. shell-sourceable `.env` files)
    // before key validation, otherwise `export FOO` fails the key regex.
    const withoutExport = line.replace(/^export\s+/, '');
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let rest = withoutExport.slice(eq + 1).trimStart();

    let value: string;
    if (rest.startsWith('"')) {
      // Double-quoted: find the closing unescaped quote, consuming further lines
      // for multiline values (PEM blocks, embedded JSON, etc.).
      let close = findClosingDoubleQuote(rest, 1);
      let acc = rest;
      const startLine = i;
      while (close === -1 && i + 1 < lines.length) {
        i++;
        acc += '\n' + (lines[i] ?? '');
        close = findClosingDoubleQuote(acc, 1);
      }
      if (close === -1) {
        // Unterminated quote (no closing `"` anywhere): degrade to a SINGLE-LINE value
        // like motdotla/dotenv does, and rewind so the consumed lines parse normally - 
        // otherwise one malformed line would silently swallow every var below it.
        i = startLine;
        value = rest.slice(1);
        const hash = value.indexOf(' #');
        if (hash !== -1) value = value.slice(0, hash).trim();
      } else {
        const quoted = acc.slice(1, close);
        // Double-quoted values expand escape sequences.
        value = quoted.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
      }
      // Anything after the closing quote (e.g. ` # comment`) is discarded.
    } else if (rest.startsWith("'")) {
      // Single-quoted: literal, no escape expansion. Closing quote ends the value.
      const close = rest.indexOf("'", 1);
      value = close === -1 ? rest.slice(1) : rest.slice(1, close);
    } else {
      // Unquoted: drop an inline ` #` comment, then trim trailing whitespace.
      rest = rest.trimEnd();
      const hash = rest.indexOf(' #');
      if (hash !== -1) rest = rest.slice(0, hash).trim();
      value = rest;
    }
    out[key] = value;
  }
  return out;
}

/** Heuristic: should this env var be masked as a secret by default? */
export function isSecretKey(key: string): boolean {
  return /SECRET|TOKEN|PASSWORD|KEY|PRIVATE/i.test(key);
}
