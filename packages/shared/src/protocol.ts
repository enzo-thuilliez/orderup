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
 * - `crew`: a persistent role run by the server via the Claude Agent SDK. Can be talked to, costs tokens.
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
}

export interface SessionView {
  sessionId: string;
  kind: CookKind;
  /** Crew identity. Always null for observed sessions. */
  agent: AgentRef | null;
  /** `CrewMember.id` running this session. Absent for observed sessions. */
  crewMemberId?: string;
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

/** A crew member's configuration: who they are and what they may do (V1, ADR-015). */
export interface CrewMember {
  id: string;
  name: string;
  /** e.g. "sous-chef", "reviewer". */
  role: string;
  /** One line, e.g. "Careful reviewer who asks for tests." */
  persona: string;
  /** Absolute path the member works in. */
  workingDir: string;
  /** Claude model id. */
  model: string;
  /** Claude Code tool names the member may use, e.g. ["Read", "Grep"]. */
  allowedTools: string[];
  /** API-equivalent USD per day (notional on a subscription). 0 disables the cap. */
  dailyUsageCapUsd: number;
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

/**
 * Client → server crew commands (V1, ADR-015). They supersede the reserved V0 `Command`
 * and are sent as top-level messages. The server answers each one with `ack` or `error`.
 */
export type CrewCommand =
  | { type: 'talk'; requestId: string; token: string; memberId: string; text: string }
  | { type: 'assign'; requestId: string; token: string; memberId: string; ticket: TicketRef }
  | { type: 'stop'; requestId: string; token: string; memberId: string };

export type CrewCommandType = CrewCommand['type'];

export type CrewErrorCode =
  | 'unauthorized'
  | 'unknown_member'
  | 'busy'
  | 'usage_cap_reached'
  | 'crew_disabled'
  | 'invalid_command';

/** Server → client reply to a `CrewCommand`, matched by `requestId`. */
export type CrewCommandReply =
  | { type: 'ack'; requestId: string }
  | { type: 'error'; requestId: string; code: CrewErrorCode; message: string };

export type CrewRunStatus = 'success' | 'error' | 'stopped' | 'usage_cap_reached';

/** Usage of one crew run. `costUsd` is API-equivalent (notional on a subscription). */
export interface CrewRunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Server → client progress of a crew run, broadcast to every client. */
export type CrewEvent =
  | { type: 'crew.run.started'; memberId: string; runId: string; sessionId: string }
  | { type: 'crew.message.delta'; memberId: string; runId: string; text: string }
  | {
      type: 'crew.run.ended';
      memberId: string;
      runId: string;
      status: CrewRunStatus;
      usage: CrewRunUsage;
    };

/** Every crew message the server may send. Kept apart from `ServerMessage` until V1 wires it. */
export type CrewServerMessage = CrewCommandReply | CrewEvent;
