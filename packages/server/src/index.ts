import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from 'orderup-shared';
import { createGuard, createRequestHandler } from './http.js';
import { SessionStore, type StoreOptions } from './sessions/store.js';
import { normalizeHook } from './sources/hooks.js';
import { TranscriptTail } from './sources/transcripts.js';
import { attachWebSocket } from './ws.js';

export { reduce, type SessionEvent } from './sessions/machine.js';
export { SessionStore, type StoreChange } from './sessions/store.js';
export { normalizeHook } from './sources/hooks.js';
export { TranscriptParser, TranscriptTail } from './sources/transcripts.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

/** The server always binds to loopback (ADR-003). */
const HOST = '127.0.0.1';

export interface ServerOptions extends StoreOptions {
  port?: number;
  /** Extra browser origins allowed besides the server's own (e.g. the Vite dev server). */
  allowedOrigins?: string[];
  /** Built web app to serve at `/`. */
  webRoot?: string;
  /** Transcript directory to tail, or `false` to disable. Default: `~/.claude/projects`. */
  projectsDir?: string | false;
}

export interface RunningServer {
  url: string;
  port: number;
  store: SessionStore;
  close(): Promise<void>;
}

export function defaultProjectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const store = new SessionStore(options);
  let port = options.port ?? DEFAULT_PORT;
  const guard = createGuard(() => port, options.allowedOrigins);

  const server = createServer(
    createRequestHandler({
      guard,
      webRoot: options.webRoot,
      onHook: (payload) => {
        const event = normalizeHook(payload);
        if (event) store.apply(event, 'hook');
      },
    }),
  );

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  const socket = attachWebSocket(server, { store, guard, serverVersion: version });

  const projectsDir = options.projectsDir ?? defaultProjectsDir();
  const tail = projectsDir
    ? new TranscriptTail({ projectsDir, onEvent: (event) => store.apply(event, 'transcript') })
    : null;
  void tail?.start().catch(() => undefined);

  const ticker = setInterval(() => store.tick(), 15_000);
  ticker.unref();

  return {
    url: `http://${HOST}:${port}`,
    port,
    store,
    close: () => {
      clearInterval(ticker);
      tail?.stop();
      socket.close();
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
