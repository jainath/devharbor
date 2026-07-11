/**
 * Log hygiene for MCP responses (see specs/07-mcp-server.md).
 *
 * Task buffers hold raw PTY output: ANSI escapes and, potentially, secret values the dev
 * server printed itself (`console.log(process.env)`, connection strings in stack traces).
 * Everything log-shaped leaves the process through these two passes.
 *
 * Pure functions - no electron/db imports - so they unit-test under plain node.
 */

// CSI sequences (colors, cursor movement), OSC sequences (terminal title, hyperlinks -
// terminated by BEL or ST), and lone two-byte escapes. The readiness watcher's private
// regex only handles CSI; OSC is common in modern dev servers (iTerm links), so both
// are covered here.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Replace every occurrence of a known secret value with a mask. Literal string
 * replacement (split/join), never regex - secret values are untrusted input.
 * Values shorter than 4 chars are skipped: masking "1" would shred ordinary output,
 * and a 1-3 char secret is not meaningfully protected by masking anyway.
 */
export function redactSecrets(text: string, secretValues: string[]): string {
  let out = text;
  for (const value of secretValues) {
    if (value.length < 4) continue;
    if (out.includes(value)) out = out.split(value).join('[redacted]');
  }
  return out;
}

/** Last `n` newline-delimited lines of `text` (handles \r\n). */
export function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/** One shot: ANSI strip, drop trailing carriage returns (progress-spinner residue that
 *  survives ANSI stripping and clutters agent-facing text), then redact known secrets. */
export function cleanLogText(text: string, secretValues: string[]): string {
  const stripped = stripAnsi(text).replace(/\r+(?=\n|$)/g, '');
  return redactSecrets(stripped, secretValues);
}
