import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpStatus } from '@shared/ipc';
import { logger } from '../services/Logger.js';
import type { Settings } from '../services/Settings.js';
import { hostHeaderAllowed, originAllowed, bearerMatches } from './gate.js';
import { TokenStore } from './token.js';
import { generateTlsMaterial, loadTlsMaterial, tlsFilesExist } from './tls.js';
import { registerTools } from './tools.js';
import type { McpToolContext } from './context.js';

const LOOPBACK = '127.0.0.1';
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB, counted while streaming
const HEADERS_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 32;

const SERVER_INSTRUCTIONS = [
  'DevHarbor manages the user\'s local dev servers. Do NOT start a project\'s dev server,',
  'watcher, or build daemon by running npm/yarn/pnpm in your own shell - register the',
  'project with add_app and run it with start_app instead. Processes started through',
  'DevHarbor keep running after your session, stay visible to the user, and get logs, port',
  'tracking, and clean shutdown for free.',
  '',
  'Typical loop: get_overview to orient, then instead of `npm run dev` in the project dir,',
  'add_app({ path: "<abs project dir>" }) then start_app({ app: "<name>" }) - start_app',
  'waits for readiness and returns the log tail on failure. Apps are addressed by id, exact',
  'name, or absolute path.',
  '',
  'Monorepos: register the repo ONCE with add_app({ path, workspaceTasks: true }) - one task',
  'per workspace package, each running its own dev script from its own directory. start_app',
  'runs them all, start_task/stop_task control one service. add_task/remove_task adjust the',
  'set (dependsOn orders startup, oneShot for migrations/builds); set_readiness gives each',
  'service its own readiness probe. Do not register workspace subdirectories as separate',
  'apps - task ordering and grouped start/stop only work within one app.'
].join(' ');

/**
 * Local HTTP MCP server (see specs/07-mcp-server.md). Off by default; loopback-only; bearer
 * token by default; stateless Streamable HTTP transport with a fresh McpServer per request.
 *
 * All collaborators arrive via the injected `McpToolContext` so this class carries no direct
 * dependency on the individual services beyond Settings (for live config) and the token store.
 */
export class McpService {
  private server: Server | null = null;
  /** Port + scheme the current `server` was told to bind, set synchronously so applySettings
      can compare against the desired settings even before `listen` has resolved. */
  private serverPort: number | null = null;
  private serverHttps: boolean | null = null;
  private running = false;
  private lastError: string | null = null;
  private disposed = false;
  private readonly tokens = new TokenStore();
  /** In-flight request-handling promises, so dispose() can drain them (bounded). */
  private readonly inflight = new Set<Promise<void>>();
  /** Serialises applySettings so two rapid settings changes can't interleave stop/start. */
  private applyChain: Promise<void> = Promise.resolve();
  /** True while the self-signed cert is being generated off-thread (first HTTPS enable). */
  private preparingTls = false;

  constructor(
    private readonly ctx: McpToolContext,
    private readonly settings: Settings,
    /** Directory for the self-signed TLS material (userData/mcp-tls). */
    private readonly tlsDir: string,
    private readonly onStatus: (status: McpStatus) => void
  ) {}

  /** Start the listener if enabled in settings. Safe to call repeatedly (idempotent-ish). */
  start(): void {
    if (this.disposed) return;
    if (!this.settings.get('mcp_enabled')) {
      this.emitStatus();
      return;
    }
    // Guard against a concurrent start() (e.g. a settings:set arriving before boot's listen
    // callback has fired). `this.server`/`this.serverPort` are assigned SYNCHRONOUSLY below,
    // not in the async listen callback, so this guard actually catches the second call
    // instead of racing two listens onto the same port. `running` stays false until listen
    // confirms the bind, and both callbacks no-op if a newer server has replaced this one.
    if (this.server || this.preparingTls) return;
    this.lastError = null;
    const port = this.settings.get('mcp_port');
    const https = this.settings.get('mcp_https');

    // First HTTPS enable: the cert may not exist yet. Generate it OFF-THREAD so we never
    // block the Electron main process on openssl, then re-enter start() (which now finds the
    // files and proceeds synchronously - keeping the synchronous this.server guard intact).
    if (https && !tlsFilesExist(this.tlsDir)) {
      this.preparingTls = true;
      this.emitStatus();
      void generateTlsMaterial(this.tlsDir).then(
        () => {
          this.preparingTls = false;
          this.start();
        },
        (e) => {
          this.preparingTls = false;
          this.lastError = `HTTPS setup failed: ${e instanceof Error ? e.message : String(e)}`;
          logger.warn('[mcp]', this.lastError);
          this.emitStatus();
        }
      );
      return;
    }

    // Ensure a token exists up front so the UI can show it immediately.
    if (this.settings.get('mcp_require_auth')) this.tokens.getOrCreate();

    const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
      const p = this.handle(req, res).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    };

    let server: Server;
    if (https) {
      // Fail CLOSED on certificate problems - never silently downgrade to plain HTTP when
      // the user asked for TLS. Files exist here (generated above or on a prior run).
      try {
        const material = loadTlsMaterial(this.tlsDir);
        server = createHttpsServer({ key: material.key, cert: material.cert }, onRequest);
      } catch (e) {
        this.lastError = `HTTPS setup failed: ${e instanceof Error ? e.message : String(e)}`;
        logger.warn('[mcp]', this.lastError);
        this.emitStatus();
        return;
      }
    } else {
      server = createServer(onRequest);
    }
    this.server = server;
    this.serverPort = port;
    this.serverHttps = https;
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.maxConnections = MAX_CONNECTIONS;
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (this.server !== server) return; // a newer server owns the state now
      this.running = false;
      this.server = null;
      this.serverPort = null;
      this.serverHttps = null;
      this.lastError =
        err.code === 'EADDRINUSE'
          ? `Port ${port} is already in use. Choose another port in Settings.`
          : err.message;
      logger.warn('[mcp] listen error', this.lastError);
      this.emitStatus();
    });
    server.listen(port, LOOPBACK, () => {
      if (this.server !== server) return; // stopped/replaced during the bind
      this.running = true;
      this.lastError = null;
      logger.info(`[mcp] listening on ${https ? 'https' : 'http'}://${LOOPBACK}:${port}/mcp`);
      this.emitStatus();
    });
  }

  /** Stop the listener and destroy in-flight sockets. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.serverPort = null;
    this.serverHttps = null;
    this.running = false;
    if (!server) {
      this.emitStatus();
      return;
    }
    // Bounded close so a stuck socket can never hang app quit: force-close connections, then
    // resolve on close-callback OR a short timeout, whichever comes first.
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      server.close(() => finish());
      server.closeAllConnections?.();
      const t = setTimeout(finish, 2000);
      t.unref?.();
    });
    logger.info('[mcp] stopped');
    this.emitStatus();
  }

  /**
   * React to a settings change. Only port change and enable/disable bounce the listener;
   * auth toggle and token rotation are evaluated per request, so they need no restart.
   */
  async applySettings(): Promise<void> {
    // Serialise: two settings changes in quick succession must not interleave their
    // stop/start (which is how two listeners could end up racing the same port).
    this.applyChain = this.applyChain.then(() => this.doApplySettings());
    return this.applyChain;
  }

  private async doApplySettings(): Promise<void> {
    if (this.disposed) return;
    const enabled = this.settings.get('mcp_enabled');
    if (!enabled) {
      await this.stop();
      return;
    }
    const port = this.settings.get('mcp_port');
    const https = this.settings.get('mcp_https');
    // Compare against the port/scheme the current server was told to bind (set synchronously
    // in start), NOT server.address() which is null until the async bind resolves.
    if (this.server && (this.serverPort !== port || this.serverHttps !== https)) {
      await this.stop();
      this.start();
      return;
    }
    if (!this.server) {
      this.start();
      return;
    }
    // Auth-only change: nothing to restart, just refresh status.
    if (this.settings.get('mcp_require_auth')) this.tokens.getOrCreate();
    this.emitStatus();
  }

  /** Permanent teardown for the quit path - closes the listener and blocks late requests. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
    // Drain any request handlers still finishing (bounded) so their work settles before the
    // caller proceeds to tear down tasks / close the DB.
    if (this.inflight.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.inflight]),
        new Promise((r) => setTimeout(r, 3000))
      ]);
    }
  }

  status(): McpStatus {
    const port = this.settings.get('mcp_port');
    const https = this.settings.get('mcp_https');
    const certPath = join(this.tlsDir, 'mcp-cert.pem');
    return {
      enabled: this.settings.get('mcp_enabled'),
      running: this.running,
      port,
      url: this.running ? `${https ? 'https' : 'http'}://${LOOPBACK}:${port}/mcp` : null,
      requireAuth: this.settings.get('mcp_require_auth'),
      https,
      certPath: https && existsSync(certPath) ? certPath : null,
      lastError: this.lastError,
      tokenStoredPlaintext: this.tokens.storedPlaintext
    };
  }

  /** Current plaintext token (creating one if auth is on and none exists yet). */
  getToken(): string | null {
    if (!this.settings.get('mcp_require_auth')) return this.tokens.load();
    return this.tokens.getOrCreate();
  }

  regenerateToken(): string {
    const token = this.tokens.regenerate();
    this.emitStatus();
    return token;
  }

  private emitStatus(): void {
    try {
      this.onStatus(this.status());
    } catch (e) {
      logger.warn('[mcp] status emit failed', e);
    }
  }

  private send(res: ServerResponse, code: number, body: unknown, headers?: Record<string, string>): void {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(text);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (this.disposed) {
        this.send(res, 503, { error: 'DevHarbor is shutting down.' });
        return;
      }

      // Host allowlist applies to EVERY path (blocks DNS-rebinding presence probes too).
      if (!hostHeaderAllowed(req.headers.host)) {
        this.send(res, 403, { error: 'Forbidden host.' });
        return;
      }
      if (!originAllowed(req.headers.origin)) {
        this.send(res, 403, { error: 'Forbidden origin.' });
        return;
      }

      const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
      const path = url.pathname;

      if (path === '/healthz') {
        this.send(res, 200, { ok: true });
        return;
      }
      if (path !== '/mcp') {
        this.send(res, 404, { error: 'Not found.' });
        return;
      }

      // Auth (per request; no listener restart on toggle).
      if (this.settings.get('mcp_require_auth')) {
        const token = this.tokens.getOrCreate();
        if (!bearerMatches(req.headers.authorization, token)) {
          this.send(res, 401, { error: 'Unauthorized.' }, { 'www-authenticate': 'Bearer' });
          return;
        }
      }

      if (req.method !== 'POST') {
        // Stateless mode has no server-push stream to offer on GET/DELETE.
        this.send(res, 405, { error: 'Method not allowed.' }, { allow: 'POST' });
        return;
      }

      const body = await this.readBody(req, res);
      if (body === undefined) return; // readBody already responded (413/400)

      await this.dispatch(req, res, body);
    } catch (e) {
      logger.warn('[mcp] request error', e);
      if (!res.headersSent) this.send(res, 500, { error: 'Internal error.' });
      else res.end();
    }
  }

  /**
   * Buffer the request body while counting bytes - never trust Content-Length. Responds 413
   * (and destroys the socket) on overflow, 400 on invalid JSON, and returns undefined in both
   * cases so the caller stops. An empty body parses to undefined-JSON handled by the SDK.
   */
  private async readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    try {
      for await (const chunk of req) {
        const buf = chunk as Buffer;
        total += buf.length;
        if (total > MAX_BODY_BYTES) {
          overflow = true;
          break;
        }
        chunks.push(buf);
      }
    } catch {
      this.send(res, 400, { error: 'Malformed request body.' });
      return undefined;
    }
    if (overflow) {
      this.send(res, 413, { error: 'Request body too large.' });
      req.destroy();
      return undefined;
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      this.send(res, 400, { error: 'Invalid JSON.' });
      return undefined;
    }
  }

  /** Build a fresh stateless McpServer + transport and hand off the pre-parsed body. */
  private async dispatch(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const mcp = new McpServer(
      { name: 'devharbor', version: this.ctx.appVersion },
      { instructions: SERVER_INSTRUCTIONS }
    );
    registerTools(mcp, this.ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
