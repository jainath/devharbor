import { app, shell } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal local file logger. DevHarbor ships with no telemetry, so when a user reports "it
 * crashed" or "updates don't work" there was previously nothing to attach (IMPROVEMENT-PLAN
 * 13.1). This writes plain-text diagnostics to the OS logs dir (~/Library/Logs/DevHarbor on
 * macOS) - purely local, nothing leaves the machine. Deliberately dependency-free.
 */

let logFilePath: string | null = null;

function file(): string {
  if (logFilePath) return logFilePath;
  const dir = app.getPath('logs');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  logFilePath = join(dir, 'devharbor.log');
  return logFilePath;
}

function fmt(a: unknown): string {
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function write(level: string, args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(fmt).join(' ')}\n`;
  try {
    appendFileSync(file(), line);
  } catch {
    // never let logging throw
  }
}

export const logger = {
  info: (...a: unknown[]): void => write('INFO', a),
  warn: (...a: unknown[]): void => write('WARN', a),
  error: (...a: unknown[]): void => write('ERROR', a),
  path: (): string => file(),
  openFolder: (): void => {
    void shell.showItemInFolder(file());
  }
};

/**
 * Route process-level faults into the log file. Without these, an uncaught exception or
 * rejected promise in the packaged main process vanishes (no console attached). We log and
 * keep running rather than letting the default handler tear the app down.
 */
export function installProcessLogging(): void {
  process.on('uncaughtException', (err) => write('UNCAUGHT', [err]));
  process.on('unhandledRejection', (reason) => write('UNHANDLED_REJECTION', [reason]));
  write('INFO', [`DevHarbor ${app.getVersion()} starting`]);
}
