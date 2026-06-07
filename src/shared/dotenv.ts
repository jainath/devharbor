/**
 * The single .env parser + secret heuristic, shared by main and renderer.
 *
 * Previously this logic was copy-pasted in three places (EnvBuilder, EnvEditor,
 * AddAppDrawer) and had already drifted — the main-side copy expanded `\n`/`\r`/`\t`
 * inside double-quoted values while the renderer copies did not, so a pasted `.env`
 * parsed differently than the same file read at spawn time. This is now the one source.
 */

/** Parse a `.env` blob into a key→value map. Comments + blank lines ignored. */
export function parseDotEnv(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quoted = value.slice(1, -1);
      // Double-quoted values expand escape sequences; single-quoted are literal.
      value = value.startsWith('"')
        ? quoted.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
        : quoted;
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Heuristic: should this env var be masked as a secret by default? */
export function isSecretKey(key: string): boolean {
  return /SECRET|TOKEN|PASSWORD|KEY|PRIVATE/i.test(key);
}
