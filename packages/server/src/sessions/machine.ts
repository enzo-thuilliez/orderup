import type { SessionView, TokenUsage } from 'orderup-shared';

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
  }
}
