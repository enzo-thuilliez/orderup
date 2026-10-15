import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from 'orderup-shared';
import { DisabledCrewController, type CrewController } from './crew/controller.js';
import { defaultTokenPath, generateToken, removeTokenFile, writeTokenFile } from './crew/token.js';
import { createGuard, createRequestHandler } from './http.js';
import { SessionStore, type StoreOptions } from './sessions/store.js';
import { normalizeHook } from './sources/hooks.js';
import { TranscriptTail } from './sources/transcripts.js';
import { attachWebSocket } from './ws.js';

export { reduce, type SessionEvent } from './sessions/machine.js';
export { SessionStore, type StoreChange } from './sessions/store.js';
export { normalizeHook } from './sources/hooks.js';
export {
  TicketSource,
  execGh,
  parseIssueList,
  type ExecFn,
  type TicketSourceOptions,
  type TicketsMessage,
} from './sources/tickets.js';
export { TranscriptParser, TranscriptTail } from './sources/transcripts.js';
export * from './persistence/index.js';
export {
  AGENT_FILE_MARKER,
  agentFileHash,
  agentFileName,
  agentsJson,
  agentsObject,
  renderAgentFile,
  STATION_DEFINITIONS,
  stationOfAgent,
  stationsHash,
  type AgentJson,
  type StationDefinition,
  type StationTool,
} from './crew/stations.js';
export {
  crewError,
  DisabledCrewController,
  type CrewController,
  type CrewRequest,
  type CrewResult,
} from './crew/controller.js';
export { CREW_RATE_LIMIT } from './crew/channel.js';
export { defaultTokenPath } from './crew/token.js';

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
  /**
   * `orderup --crew`: enables the authenticated command channel (ADR-015). The server writes a
   * fresh token to `commandTokenFile` and injects it into the kitchen page. Without it every
   * crew command gets `crew_disabled` and the server is the observer only.
   */
  crew?: boolean;
  /** Handles authorized crew commands. Default: `DisabledCrewController` until #19. */
  crewController?: CrewController;
  /** Default: `~/.orderup/command-token`. */
  commandTokenFile?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  store: SessionStore;
  /** Whether crew was enabled with `--crew`. */
  crew: boolean;
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
  const crewToken = options.crew === true ? generateToken() : null;
  const tokenFile = options.commandTokenFile ?? defaultTokenPath();

  const server = createServer(
    createRequestHandler({
      guard,
      webRoot: options.webRoot,
      commandToken: crewToken,
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

  // After listening, so a second OrderUp that loses the port never replaces the running one's
  // token. Crew refuses to start when the token cannot be stored readable by the user only.
  if (crewToken !== null) {
    try {
      writeTokenFile(tokenFile, crewToken);
    } catch (err) {
      await new Promise((resolve) => server.close(resolve));
      throw err;
    }
  }

  const socket = attachWebSocket(server, {
    store,
    guard,
    serverVersion: version,
    crewToken,
    crewController: options.crewController ?? new DisabledCrewController(),
  });

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
    crew: options.crew === true,
    close: () => {
      clearInterval(ticker);
      tail?.stop();
      socket.close();
      if (crewToken !== null) removeTokenFile(tokenFile, crewToken);
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
