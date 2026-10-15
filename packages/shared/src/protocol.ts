/**
 * OrderUp wire protocol between the local server and the kitchen (web).
 * See docs/architecture.md and ADR 008 for the observed/crew model.
 */

/** Default port of the local server. Baked into installed hooks: keep it stable (ADR 002). */
export const DEFAULT_PORT = 7717;

/** Bump on any breaking change to the messages below. */
export const PROTOCOL_VERSION = 1;

/** `GET /health`: lets the CLI find a running OrderUp and `orderup --doctor` check hooks. */
export interface HealthResponse {
  ok: true;
  protocol: number;
  /** Epoch ms of the last hook payload received (any event), or null since start. */
  lastHookAt: number | null;
}

/**
 * - `observed`: any Claude Code session on this machine. Read-only, zero tokens.
 * - `crew`: the head chef run by the server as the user's headless `claude` CLI, or one of its
 *   station subagents (ADR-015, ADR-016). Only the chef can be talked to. Costs tokens.
 */
export type CookKind = 'observed' | 'crew';

/**
 * - `working`: cooking at the station (tool calls)
 * - `waiting`: bell rings at the pass (needs user input or permission)
 * - `done`: plate at the pass, "Order up!" (turn finished)
 * - `idle`: coffee break out back (done and quiet for a while)
 */
export type CookState = 'working' | 'waiting' | 'idle' | 'done';

/** A persistent crew identity. One agent runs many sessions over time. */
export interface AgentRef {
  agentId: string;
  /** e.g. "sous-chef", "reviewer". */
  role: string;
  persona: {
    name: string;
    /** 0-360, drives apron and toque colours. */
    hue: number;
  };
}

/** What the cook is doing right now. */
export interface Activity {
  /** Claude Code tool name, e.g. "Edit", "Bash". */
  tool: string;
  /** File path or command, truncated for display. */
  target: string | null;
  /** Epoch ms. */
  since: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A commis cook: a subagent working for its chef. */
export interface SubagentView {
  subagentId: string;
  /** Subagent type, e.g. "Explore", when known. */
  type: string | null;
  state: CookState;
  activity: Activity | null;
  /**
   * Crew only: the station of a chef's subagent, from its `agent_type` (`orderup-hot` → `hot`).
   * `null` for a crew subagent that is not an OrderUp station (shown as an unassigned commis).
   * Absent for observed sessions.
   */
  station?: WorkStation | null;
  /** Crew only: what the cook is doing in brigade terms. Absent for observed sessions. */
  crewState?: CrewCookState;
}

export interface SessionView {
  sessionId: string;
  kind: CookKind;
  /** Crew identity. Always null for observed sessions. */
  agent: AgentRef | null;
  /** Crew only: `head-chef` for the chef session (ADR-016). Absent for observed sessions. */
  station?: Station;
  /** Crew only: what the cook is doing in brigade terms. Absent for observed sessions. */
  crewState?: CrewCookState;
  /** Working directory of the session. */
  cwd: string;
  /** Git repository name for `cwd`, or null outside a repo. */
  repo: string | null;
  state: CookState;
  activity: Activity | null;
  tokens: TokenUsage;
  subagents: SubagentView[];
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms. */
  updatedAt: number;
}

/** Server → client. A `snapshot` follows `hello`, then incremental updates. */
export type ServerMessage =
  | { type: 'hello'; protocol: number; serverVersion: string }
  | { type: 'snapshot'; sessions: SessionView[] }
  | { type: 'session.upsert'; session: SessionView }
  | { type: 'session.remove'; sessionId: string }
  | { type: 'command.result'; id: string; ok: true }
  | { type: 'command.result'; id: string; ok: false; error: CommandError };

/**
 * Client → server commands. Reserved: until crew lands (V1) the server answers every
 * command with `not_implemented`. Observed sessions never accept commands.
 */
export type Command =
  | { name: 'crew.message'; agentId: string; text: string }
  | { name: 'crew.spawn'; role: string; cwd: string };

export type CommandError = 'not_implemented' | 'unknown_agent' | 'invalid';

export interface ClientMessage {
  type: 'command';
  /** Client-chosen id, echoed in `command.result`. */
  id: string;
  command: Command;
}

/** Points at a GitHub issue. */
export interface TicketRef {
  /** "owner/name". */
  repo: string;
  number: number;
}

/** An order ticket: a GitHub issue on the rail. */
export interface Ticket extends TicketRef {
  title: string;
  labels: string[];
  url: string;
}

// ─── Crew (V1): head chef and brigade, ADR-015 and ADR-016 ──────────────────────────────

/**
 * Fixed stations, by stable wire id (ADR-016 point 2). Never renamed. The subagent name of a
 * station is `orderup-<id>`; `head-chef` is the main session, not a subagent.
 */
export const STATIONS = ['head-chef', 'hot', 'garde-manger', 'commis', 'pastry', 'dish'] as const;

export type Station = (typeof STATIONS)[number];

/** The only crew identity the user can address. */
export const HEAD_CHEF = 'head-chef' as const satisfies Station;

/** A station the head chef dispatches work to. */
export type WorkStation = Exclude<Station, typeof HEAD_CHEF>;

export function isStation(value: unknown): value is Station {
  return typeof value === 'string' && (STATIONS as readonly string[]).includes(value);
}

/**
 * What a crew cook is doing, in brigade terms:
 * - `idle`: nothing to do
 * - `working`: tool calls at the station
 * - `talking-to-chef`: reporting back to, or being dispatched by, the head chef
 * - `needs-you`: blocked on the user (permission, unmerged branch, ...)
 * - `done`: finished its part
 * - `error`: the run or the subagent failed
 */
export type CrewCookState = 'idle' | 'working' | 'talking-to-chef' | 'needs-you' | 'done' | 'error';

/** What started a chef run (ADR-016 point 9, `runs.trigger`). */
export type ChefRunTrigger = 'talk' | 'assign' | 'send-back';

export type CrewRunStatus = 'success' | 'error' | 'stopped' | 'usage_cap_reached';

/** Usage of one chef run, stations included. `costUsd` is API-equivalent (notional on a subscription). */
export interface CrewRunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// ─── Report cards (ADR-016 point 5) ──────────────────────────────────────────────────────

export const REPORT_SCHEMA_VERSION = 1;

/**
 * The fenced `json` block the head chef ends a task with, schema version 1. The runner
 * parses it from the run's final result.
 */
export interface ReportBlock {
  schema: typeof REPORT_SCHEMA_VERSION;
  taskId: string;
  ticket: TicketRef | null;
  /** Stations that worked on the task, never `head-chef`. */
  stations: WorkStation[];
  /** Plain text, at most 600 characters. */
  summary: string;
  prUrl: string | null;
  /** Repo-relative paths. */
  filesChanged: string[];
  /** Station branches the chef could not merge into the task branch; empty otherwise. */
  unmerged: string[];
}

/**
 * - `cooking`: the task started (`assign`, or a `send-back` that resumes it)
 * - `ready`: the run ended; the bell rings
 * - `read`: the user opened the card
 * - `approved`: the user approved the work (records the decision, starts no run)
 * - `sent-back`: the user sent it back to the chef with a comment
 */
export type CardStatus = 'cooking' | 'ready' | 'read' | 'approved' | 'sent-back';

interface ReportCardBase {
  /** Card id, used by `approve` and `send-back`. */
  id: string;
  /** Task the card reports on, chosen by the server. One card per task. */
  taskId: string;
  ticket: TicketRef | null;
  status: CardStatus;
  /** How the last chef run for this task ended; `null` while the first one is cooking. Not `success` → error badge. */
  runStatus: CrewRunStatus | null;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  updatedAt: number;
}

/**
 * A card on the whiteboard at the pass. When the chef's report block is missing, duplicated,
 * not valid JSON, fails the schema or names another `taskId`, the card is `malformed` and
 * keeps the chef's raw final text, so nothing is lost. A non-empty `report.unmerged` shows a
 * "needs you" badge.
 */
export type ReportCard = ReportCardBase &
  (
    | {
        malformed: false;
        /** The last valid report block; `null` until the chef reports. */
        report: ReportBlock | null;
      }
    | {
        malformed: true;
        report: null;
        /** The chef's raw final message. */
        rawText: string;
      }
  );

// ─── Commands: to the head chef only (ADR-016 point 6) ───────────────────────────────────

interface CrewCommandBase {
  /** Client-chosen id, echoed in the reply. */
  requestId: string;
  /** Per-start command channel token (ADR-015). */
  token: string;
  /** Every command goes to the head chef. No other station can be addressed. */
  to: typeof HEAD_CHEF;
}

/**
 * Client → server crew commands. They supersede the reserved V0 `Command` and are sent as
 * top-level messages. The server answers each one with an `ack` or an `error`. Validate
 * untrusted input with `parseCrewCommand`.
 */
export type CrewCommand =
  | (CrewCommandBase & { type: 'talk'; text: string })
  | (CrewCommandBase & { type: 'assign'; ticket: TicketRef })
  | (CrewCommandBase & { type: 'stop' })
  | (CrewCommandBase & { type: 'approve'; cardId: string })
  | (CrewCommandBase & { type: 'send-back'; cardId: string; comment: string });

export type CrewCommandType = CrewCommand['type'];

export const CREW_COMMAND_TYPES = [
  'talk',
  'assign',
  'stop',
  'approve',
  'send-back',
] as const satisfies readonly CrewCommandType[];

export type CrewErrorCode =
  | 'unauthorized'
  /** The command addressed a station other than `head-chef`. */
  | 'chef_only'
  | 'unknown_card'
  /** The card's status does not allow this action. */
  | 'invalid_card_status'
  | 'busy'
  /** Too many crew commands on this connection: at most 10 per second. */
  | 'rate_limited'
  | 'usage_cap_reached'
  | 'crew_disabled'
  | 'invalid_command';

/** Server → client acknowledgement, typed by the command it answers. */
export type CrewAck =
  | { type: 'ack'; requestId: string; command: 'talk'; runId: string }
  | { type: 'ack'; requestId: string; command: 'assign'; runId: string; cardId: string }
  /** `runId` is the run that was stopped, or `null` when nothing was running. */
  | { type: 'ack'; requestId: string; command: 'stop'; runId: string | null }
  | { type: 'ack'; requestId: string; command: 'approve'; cardId: string }
  | { type: 'ack'; requestId: string; command: 'send-back'; cardId: string; runId: string };

export interface CrewError {
  type: 'error';
  requestId: string;
  /** `null` when the command was too malformed to tell. */
  command: CrewCommandType | null;
  code: CrewErrorCode;
  message: string;
}

/** Server → client reply to a `CrewCommand`, matched by `requestId`. */
export type CrewCommandReply = CrewAck | CrewError;

export type ParseCrewCommandResult =
  | { ok: true; command: CrewCommand }
  | { ok: false; command: CrewCommandType | null; code: CrewErrorCode; message: string };

/**
 * `<meta name>` the server adds to the kitchen page it serves with `--crew`, holding the
 * command token. The page reads it and attaches the token to every crew command.
 */
export const COMMAND_TOKEN_META = 'orderup-command-token';

const COMMAND_FIELDS: Record<CrewCommandType, readonly string[]> = {
  talk: ['text'],
  assign: ['ticket'],
  stop: [],
  approve: ['cardId'],
  'send-back': ['cardId', 'comment'],
};

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Checks the shape of an untrusted crew command. A command addressed to any station other
 * than the head chef is rejected with `chef_only`; any other mistake, including unknown fields
 * such as a legacy `memberId`, is `invalid_command`. It does not check the token's value.
 */
export function parseCrewCommand(value: unknown): ParseCrewCommandResult {
  const fail = (
    command: CrewCommandType | null,
    code: CrewErrorCode,
    message: string,
  ): ParseCrewCommandResult => ({ ok: false, command, code, message });

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(null, 'invalid_command', 'command must be an object');
  }
  const v = value as Record<string, unknown>;
  const type = (CREW_COMMAND_TYPES as readonly unknown[]).includes(v.type)
    ? (v.type as CrewCommandType)
    : null;
  if (!type) return fail(null, 'invalid_command', 'unknown command type');

  if (v.to !== HEAD_CHEF) {
    return isStation(v.to)
      ? fail(type, 'chef_only', 'commands go to the head chef only')
      : fail(type, 'invalid_command', '`to` must be "head-chef"');
  }
  if (!isNonEmptyString(v.requestId)) return fail(type, 'invalid_command', 'missing requestId');
  if (!isNonEmptyString(v.token)) return fail(type, 'invalid_command', 'missing token');

  const allowed = new Set(['type', 'requestId', 'token', 'to', ...COMMAND_FIELDS[type]]);
  const extra = Object.keys(v).find((k) => !allowed.has(k));
  if (extra !== undefined) return fail(type, 'invalid_command', `unexpected field: ${extra}`);

  const base = { requestId: v.requestId, token: v.token, to: HEAD_CHEF } as const;
  switch (type) {
    case 'talk':
      if (!isNonEmptyString(v.text)) return fail(type, 'invalid_command', 'missing text');
      return { ok: true, command: { ...base, type, text: v.text } };
    case 'assign': {
      const t = v.ticket as Record<string, unknown> | null;
      if (
        typeof t !== 'object' ||
        t === null ||
        typeof t.repo !== 'string' ||
        !/^[^/\s]+\/[^/\s]+$/.test(t.repo) ||
        !Number.isSafeInteger(t.number) ||
        (t.number as number) < 1
      ) {
        return fail(type, 'invalid_command', 'ticket must be { repo: "owner/name", number }');
      }
      return {
        ok: true,
        command: { ...base, type, ticket: { repo: t.repo, number: t.number as number } },
      };
    }
    case 'stop':
      return { ok: true, command: { ...base, type } };
    case 'approve':
      if (!isNonEmptyString(v.cardId)) return fail(type, 'invalid_command', 'missing cardId');
      return { ok: true, command: { ...base, type, cardId: v.cardId } };
    case 'send-back':
      if (!isNonEmptyString(v.cardId)) return fail(type, 'invalid_command', 'missing cardId');
      if (!isNonEmptyString(v.comment)) return fail(type, 'invalid_command', 'missing comment');
      return { ok: true, command: { ...base, type, cardId: v.cardId, comment: v.comment } };
  }
}

// ─── Peek (ADR-016 point 7) ──────────────────────────────────────────────────────────────

/** One of the last assistant messages of a cook. Never user prompts or `Agent` call prompts. */
export interface PeekMessage {
  /** Epoch ms. */
  at: number;
  text: string;
}

/**
 * Read-only view of a crew cook, built in memory from hook events and transcripts. Holds no
 * prompt text: a chef's dispatch to a station is shown by its `Agent` call's short
 * `description` only.
 */
export interface CookPeek {
  /** The chef's session. */
  sessionId: string;
  /** The subagent's `agentId`; `null` for the head chef itself. */
  subagentId: string | null;
  /** `null` for a subagent that is not an OrderUp station (unassigned commis). */
  station: Station | null;
  state: CrewCookState;
  /** Current tool and target. */
  activity: Activity | null;
  /** Paths from `tool_input`, most recent first. */
  filesTouched: string[];
  /** The last few assistant messages, oldest first. */
  lastMessages: PeekMessage[];
  /** For a station: the `description` of the `Agent` call that dispatched it. */
  dispatch: string | null;
  /** Epoch ms. */
  updatedAt: number;
}

// ─── Crew events ─────────────────────────────────────────────────────────────────────────

/** Server → client crew progress, broadcast to every client. */
export type CrewEvent =
  | {
      type: 'crew.run.started';
      runId: string;
      /** The chef's session. */
      sessionId: string;
      trigger: ChefRunTrigger;
      /** `null` for a `talk` until it ends with a report block. */
      taskId: string | null;
    }
  /** Streamed text of the chef's reply. */
  | { type: 'crew.message.delta'; runId: string; text: string }
  | { type: 'crew.run.ended'; runId: string; status: CrewRunStatus; usage: CrewRunUsage }
  | {
      type: 'crew.budget.exceeded';
      /** The run that was killed, or `null` when a run was refused before it started. */
      runId: string | null;
      capUsd: number;
      spentUsd: number;
    }
  | { type: 'crew.card.created'; card: ReportCard }
  | { type: 'crew.card.updated'; card: ReportCard }
  | { type: 'crew.peek'; peek: CookPeek }
  | {
      type: 'crew.tickets';
      /** Open issues of the brigade's repos, the last good list when a poll fails. */
      tickets: Ticket[];
      status: TicketSourceStatus;
      /** Short reason when `status` is not `ok`, else `null`. */
      message: string | null;
      /** Epoch ms of the last successful poll, or `null` before the first one. */
      updatedAt: number | null;
    };

/**
 * Health of the GitHub ticket source (`gh issue list`):
 * - `ok`: the last poll succeeded
 * - `gh-missing`: the `gh` CLI is not installed or not on PATH
 * - `unauthenticated`: `gh` is not logged in
 * - `error`: anything else (network, timeout, unexpected output)
 */
export type TicketSourceStatus = 'ok' | 'gh-missing' | 'unauthenticated' | 'error';

/** Every crew message the server may send. Kept apart from `ServerMessage` until V1 wires it. */
export type CrewServerMessage = CrewCommandReply | CrewEvent;
