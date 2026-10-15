import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from 'orderup-shared';
import { CrewRunner, type RunnerOptions } from './crew/runner.js';
import { createGuard, createRequestHandler } from './http.js';
import { openDatabase, Repository } from './persistence/index.js';
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
  buildChefArgs,
  buildChefEnv,
  CrewRunner,
  MAX_CONCURRENT_RUNS,
  MAX_SUBAGENT_SPAWN_DEPTH,
  MAX_TURNS,
  MIN_BUDGET_USD,
  type RunnerEvent,
  type RunnerOptions,
  type StartRunOptions,
  type StartRunRefusal,
  type StartRunResult,
} from './crew/runner.js';
export { parseStreamLine, type StreamEvent } from './crew/stream.js';
export {
  chefWorktreePath,
  defaultBranch,
  ensureChefWorktree,
  hooksDir,
  installPushGuard,
  isValidTaskId,
  PRE_PUSH_HOOK,
  removeChefWorktree,
  taskBranch,
  type ChefWorktree,
} from './crew/worktree.js';

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
   * `orderup --crew`: crew is enabled for this run (ADR-015). It opens the crew database and
   * a `CrewRunner`, which nothing starts runs on yet (#20). Without it the server is the
   * observer only and never opens the database.
   */
  crew?: boolean;
  /** Crew only: the database file (default `~/.orderup/orderup.db`). */
  dbPath?: string;
  /** Crew only: runner options such as the `claude` binary, for tests. */
  runner?: Omit<RunnerOptions, 'repository'>;
}

export interface RunningServer {
  url: string;
  port: number;
  store: SessionStore;
  /** Whether crew was enabled with `--crew`. */
  crew: boolean;
  /** The crew runner, or null without `--crew`. `close()` stops all its runs. */
  runner: CrewRunner | null;
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

  const crewDb = options.crew ? openDatabase(options.dbPath) : null;
  const runner = crewDb
    ? new CrewRunner({ ...options.runner, repository: new Repository(crewDb) })
    : null;

  return {
    url: `http://${HOST}:${port}`,
    port,
    store,
    crew: options.crew === true,
    runner,
    close: async () => {
      clearInterval(ticker);
      tail?.stop();
      // No orphans (ADR-015): every chef process and its group is gone before we return.
      await runner?.stopAll();
      crewDb?.close();
      socket.close();
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
