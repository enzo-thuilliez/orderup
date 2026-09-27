/**
 * The kitchen's view of the server: connection status plus every live session.
 * `applyMessage` is a pure reducer over `ServerMessage`s (snapshot, then diffs).
 */
import { PROTOCOL_VERSION, type ServerMessage, type SessionView } from 'orderup-shared';

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'incompatible' | 'demo';

export interface KitchenState {
  status: ConnectionStatus;
  serverVersion: string | null;
  /** Protocol version announced by the server, when it differs from ours. */
  serverProtocol: number | null;
  sessions: ReadonlyMap<string, SessionView>;
}

export function initialState(status: ConnectionStatus = 'connecting'): KitchenState {
  return { status, serverVersion: null, serverProtocol: null, sessions: new Map() };
}

export function applyMessage(state: KitchenState, msg: ServerMessage): KitchenState {
  switch (msg.type) {
    case 'hello': {
      if (msg.protocol !== PROTOCOL_VERSION) {
        return {
          ...state,
          status: 'incompatible',
          serverVersion: msg.serverVersion,
          serverProtocol: msg.protocol,
          sessions: new Map(),
        };
      }
      return { ...state, serverVersion: msg.serverVersion, serverProtocol: null };
    }
    case 'snapshot': {
      if (state.status === 'incompatible') return state;
      return { ...state, sessions: new Map(msg.sessions.map((s) => [s.sessionId, s])) };
    }
    case 'session.upsert': {
      if (state.status === 'incompatible') return state;
      const sessions = new Map(state.sessions);
      sessions.set(msg.session.sessionId, msg.session);
      return { ...state, sessions };
    }
    case 'session.remove': {
      if (!state.sessions.has(msg.sessionId)) return state;
      const sessions = new Map(state.sessions);
      sessions.delete(msg.sessionId);
      return { ...state, sessions };
    }
    case 'command.result':
      return state;
  }
}

export function withStatus(state: KitchenState, status: ConnectionStatus): KitchenState {
  // A version mismatch sticks: reconnecting to the same server won't fix it.
  if (state.status === 'incompatible' && status !== 'demo') return state;
  return state.status === status ? state : { ...state, status };
}

const MESSAGE_TYPES = new Set<string>([
  'hello',
  'snapshot',
  'session.upsert',
  'session.remove',
  'command.result',
]);

/** Parse a WebSocket frame. Returns null for anything that isn't a well-formed server message. */
export function parseMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(data) || typeof data.type !== 'string' || !MESSAGE_TYPES.has(data.type)) {
    return null;
  }
  switch (data.type) {
    case 'hello':
      return typeof data.protocol === 'number' ? (data as unknown as ServerMessage) : null;
    case 'snapshot':
      return Array.isArray(data.sessions) && data.sessions.every(isSession)
        ? (data as unknown as ServerMessage)
        : null;
    case 'session.upsert':
      return isSession(data.session) ? (data as unknown as ServerMessage) : null;
    case 'session.remove':
      return typeof data.sessionId === 'string' ? (data as unknown as ServerMessage) : null;
    default:
      return typeof data.id === 'string' ? (data as unknown as ServerMessage) : null;
  }
}

const STATES = new Set(['working', 'waiting', 'idle', 'done']);

function isSession(v: unknown): v is SessionView {
  return (
    isObject(v) &&
    typeof v.sessionId === 'string' &&
    typeof v.state === 'string' &&
    STATES.has(v.state) &&
    typeof v.cwd === 'string' &&
    isObject(v.tokens) &&
    Array.isArray(v.subagents)
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
