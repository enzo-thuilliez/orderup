import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from 'orderup-shared';
import {
  DisabledCrewController,
  RunnerCrewController,
  type CrewController,
} from './crew/controller.js';
import { CrewCooks } from './crew/cooks.js';
import { CrewRunner, type RunnerOptions } from './crew/runner.js';
import { defaultTokenPath, generateToken, removeTokenFile, writeTokenFile } from './crew/token.js';
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
  STATION_ALLOW_RULES,
  type AgentJson,
  type StationDefinition,
  type StationTool,
} from './crew/stations.js';
export { buildChefSystemPrompt } from './crew/chef-prompt.js';
export { CrewCooks } from './crew/cooks.js';
export {
  assignPrompt,
  crewError,
  DisabledCrewController,
  newTaskId,
  RunnerCrewController,
  type CrewController,
  type CrewRequest,
  type CrewResult,
} from './crew/controller.js';
export { CREW_RATE_LIMIT } from './crew/channel.js';
export { defaultTokenPath } from './crew/token.js';
export {
  agentIdOfWorktree,
  buildChefArgs,
  buildChefEnv,
  chefSettingsJson,
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
   * `orderup --crew`: enables the authenticated command channel (ADR-015). The server writes a
   * fresh token to `commandTokenFile` and injects it into the kitchen page. It also opens the
   * crew database and a `CrewRunner`, driven by a `RunnerCrewController`. Without it every
   * crew command gets `crew_disabled`, the server is the observer only and never opens the
   * database.
   */
  crew?: boolean;
  /**
   * Handles authorized crew commands. Default with `--crew`: a `RunnerCrewController` over the
   * runner. Ignored without `--crew`: every command then gets `crew_disabled`.
   */
  crewController?: CrewController;
  /** Default: `~/.orderup/command-token`. */
  commandTokenFile?: string;
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

  let crewDb: ReturnType<typeof openDatabase> | null = null;
  let runner: CrewRunner | null = null;
  let crewController: CrewController = new DisabledCrewController();
  if (crewToken !== null) {
    try {
      crewDb = openDatabase(options.dbPath);
    } catch (err) {
      removeTokenFile(tokenFile, crewToken);
      await new Promise((resolve) => server.close(resolve));
      throw err;
    }
    const repository = new Repository(crewDb);
    // The chef and its stations appear in the kitchen as crew cooks.
    const cooks = new CrewCooks(store);
    const onEvent = options.runner?.onEvent;
    runner = new CrewRunner({
      ...options.runner,
      repository,
      onEvent: (event) => {
        cooks.onRunnerEvent(event);
        onEvent?.(event);
      },
    });
    crewController = options.crewController ?? new RunnerCrewController(runner, repository);
  }

  const socket = attachWebSocket(server, {
    store,
    guard,
    serverVersion: version,
    crewToken,
    crewController,
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
    runner,
    close: async () => {
      clearInterval(ticker);
      tail?.stop();
      // No orphans (ADR-015): every chef process and its group is gone before we return.
      await runner?.stopAll();
      crewDb?.close();
      socket.close();
      if (crewToken !== null) removeTokenFile(tokenFile, crewToken);
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
