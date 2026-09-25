/**
 * OrderUp wire protocol between the local server and the kitchen (web).
 * See docs/architecture.md and ADR 008 for the observed/crew model.
 */

/** Default port of the local server. Baked into installed hooks: keep it stable (ADR 002). */
export const DEFAULT_PORT = 7717;

/** Bump on any breaking change to the messages below. */
export const PROTOCOL_VERSION = 1;

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
