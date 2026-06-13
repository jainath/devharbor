import type { InvokeChannelName, InvokeReq, InvokeRes } from '@shared/ipc';
import { pushToast } from '../components/Toast';

/**
 * Electron serialises a thrown main-process Error as
 * `Error invoking remote method 'proc:start': Error: <message>`. Strip that wrapper so the
 * user sees the actual message (e.g. "Node v20 is not installed. Install it first.").
 */
export function cleanIpcError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const stripped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^(?:Uncaught )?Error:\s*/i, '')
    .trim();
  return stripped || 'Something went wrong.';
}

/**
 * Invoke an IPC channel and surface any rejection as a toast instead of letting it become a
 * silent unhandled rejection. Returns the result, or null on failure. Route fire-and-forget
 * lifecycle actions (start/stop/restart) from every view through this so failures are never
 * invisible - previously only AppDetail caught and showed them.
 */
export async function invokeOrToast<C extends InvokeChannelName>(
  channel: C,
  req: InvokeReq<C>,
  opts?: { context?: string }
): Promise<InvokeRes<C> | null> {
  try {
    return await window.api.invoke(channel, req);
  } catch (e) {
    const base = cleanIpcError(e);
    pushToast(opts?.context ? `${opts.context}: ${base}` : base, { kind: 'error' });
    return null;
  }
}
