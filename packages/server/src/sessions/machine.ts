import type {
  CookState,
  CrewCookState,
  CrewRunStatus,
  SessionView,
  SubagentView,
  TokenUsage,
} from 'orderup-shared';
import { stationOfAgent } from '../crew/stations.js';

/**
 * Normalized input to the reducer. Produced by hook intake, the transcript tail and the
 * store's timers. `cwd` and `repo` are optional on every event so a session can be created
 * by whichever event arrives first.
 */
export type SessionEvent = {
  sessionId: string;
  /** Epoch ms. */
  at: number;
  cwd?: string;
  repo?: string | null;
} & (
  | { type: 'session.start' }
  | { type: 'prompt' }
  | {
      type: 'tool.start';
      tool: string;
      target: string | null;
      /** Set when the tool spawns a subagent (Task/Agent): a commis appears. */
      subagent?: { id: string; type: string | null };
    }
  | {
      type: 'tool.end';
      /** Set when a subagent tool call finishes: its commis leaves. */
      subagentId?: string;
    }
  | { type: 'waiting' }
  | { type: 'stop' }
  /** Absolute totals for the session, not a delta. */
  | { type: 'usage'; tokens: TokenUsage }
  | { type: 'idle' }
  | { type: 'end' }
  // Crew only (#19): fed by the crew runner's stream, never by hooks or transcripts.
  /** The session is the head chef's: it becomes a crew cook. */
  | { type: 'crew.claim' }
  /** A tool call inside a station subagent (`parent_tool_use_id`). */
  | { type: 'subagent.tool'; subagentId: string; tool: string; target: string | null }
  /** A station finished; it stays at its station, done or in error, until the run ends. */
  | { type: 'subagent.end'; subagentId: string; ok: boolean }
  /** The chef's run ended with this status. */
  | { type: 'crew.end'; status: CrewRunStatus }
);

export const EMPTY_TOKENS: TokenUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export function createSession(event: SessionEvent): SessionView {
  return {
    sessionId: event.sessionId,
    kind: 'observed',
    agent: null,
    cwd: event.cwd ?? '',
    repo: event.repo ?? null,
    state: 'idle',
    activity: null,
    tokens: EMPTY_TOKENS,
    subagents: [],
    startedAt: event.at,
    updatedAt: event.at,
  };
}

/**
 * Pure session reducer: `(session, event) → session`, or `null` when the session ends.
 * No timers, no I/O: the store decides when `idle` happens.
 */
export function reduce(prev: SessionView | undefined, event: SessionEvent): SessionView | null {
  const next = reduceState(prev, event);
  return next && next.kind === 'crew' ? withCrewState(next, event) : next;
}

/** Brigade state of a crew cook, from its cook state. */
const CREW_STATE: Record<CookState, CrewCookState> = {
  working: 'working',
  waiting: 'needs-you',
  done: 'done',
  idle: 'idle',
};

function crewSubagent(a: SubagentView): SubagentView {
  return {
    ...a,
    station: a.station ?? stationOfAgent(a.type ?? ''),
    crewState: a.crewState ?? CREW_STATE[a.state],
  };
}

/** Crew fields of a crew session: `head-chef`, its brigade state, its stations. */
function withCrewState(s: SessionView, event: SessionEvent): SessionView {
  const failed =
    event.type === 'crew.end' && event.status !== 'success' && event.status !== 'stopped';
  return {
    ...s,
    agent: null,
    station: 'head-chef',
    // A run that failed shows its error until the next one starts.
    crewState:
      failed || (s.crewState === 'error' && s.state === 'done') ? 'error' : CREW_STATE[s.state],
    subagents: s.subagents.map(crewSubagent),
  };
}

function reduceState(prev: SessionView | undefined, event: SessionEvent): SessionView | null {
  if (event.type === 'end') return null;

  const base = prev ?? createSession(event);
  const s: SessionView = {
    ...base,
    cwd: base.cwd || (event.cwd ?? ''),
    repo: base.repo ?? event.repo ?? null,
    updatedAt: Math.max(base.updatedAt, event.at),
  };

  switch (event.type) {
    case 'session.start':
      return s;
    case 'prompt':
      return { ...s, state: 'working', activity: null };
    case 'tool.start': {
      const { subagent } = event;
      const subagents =
        subagent && !s.subagents.some((a) => a.subagentId === subagent.id)
          ? [
              ...s.subagents,
              {
                subagentId: subagent.id,
                type: subagent.type,
                state: 'working' as const,
                activity: null,
              },
            ]
          : s.subagents;
      return {
        ...s,
        state: 'working',
        activity: { tool: event.tool, target: event.target, since: event.at },
        subagents,
      };
    }
    case 'tool.end': {
      const { subagentId } = event;
      const subagents = subagentId
        ? s.subagents.filter((a) => a.subagentId !== subagentId)
        : s.subagents;
      return { ...s, state: 'working', subagents };
    }
    case 'waiting':
      return { ...s, state: 'waiting' };
    case 'stop':
      return { ...s, state: 'done', activity: null, subagents: [] };
    case 'usage':
      return { ...s, tokens: event.tokens };
    case 'idle':
      return { ...s, state: 'idle', activity: null, subagents: [] };
    case 'crew.claim':
      return { ...s, kind: 'crew' };
    case 'subagent.tool': {
      const activity = { tool: event.tool, target: event.target, since: event.at };
      const subagents = s.subagents.map((a) =>
        a.subagentId === event.subagentId
          ? { ...a, state: 'working' as const, crewState: 'working' as const, activity }
          : a,
      );
      return { ...s, subagents };
    }
    case 'subagent.end': {
      const subagents = s.subagents.map((a) =>
        a.subagentId === event.subagentId
          ? {
              ...a,
              state: 'done' as const,
              crewState: event.ok ? ('done' as const) : ('error' as const),
              activity: null,
            }
          : a,
      );
      return { ...s, subagents };
    }
    case 'crew.end':
      return { ...s, state: 'done', activity: null, subagents: [] };
  }
}
