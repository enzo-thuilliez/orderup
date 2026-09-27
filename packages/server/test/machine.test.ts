import type { SessionView } from 'orderup-shared';
import { describe, expect, it } from 'vitest';
import { reduce, type SessionEvent } from '../src/sessions/machine.js';

type EventInput = SessionEvent extends infer E
  ? E extends SessionEvent
    ? Omit<E, 'sessionId' | 'at'> & { at?: number }
    : never
  : never;

/** Replays events for one session, returning every intermediate view. */
function run(...events: EventInput[]): (SessionView | null)[] {
  let session: SessionView | undefined;
  return events.map((e, i) => {
    const next = reduce(session, { sessionId: 's1', at: e.at ?? 1000 + i, ...e } as SessionEvent);
    session = next ?? undefined;
    return next;
  });
}

describe('reduce', () => {
  it('creates an observed session from the first event, with cwd and repo', () => {
    const [s] = run({ type: 'session.start', cwd: '/code/app', repo: 'app' });
    expect(s).toMatchObject({
      sessionId: 's1',
      kind: 'observed',
      agent: null,
      cwd: '/code/app',
      repo: 'app',
      state: 'idle',
      subagents: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('walks working → waiting → working → done', () => {
    const states = run(
      { type: 'prompt' },
      { type: 'tool.start', tool: 'Edit', target: 'src/a.ts' },
      { type: 'waiting' },
      { type: 'tool.end' },
      { type: 'stop' },
    ).map((s) => s?.state);
    expect(states).toEqual(['working', 'working', 'waiting', 'working', 'done']);
  });

  it('shows the current tool and clears it when the turn ends', () => {
    const [, cooking, done] = run(
      { type: 'prompt' },
      { type: 'tool.start', tool: 'Bash', target: 'npm test', at: 5000 },
      { type: 'stop' },
    );
    expect(cooking?.activity).toEqual({ tool: 'Bash', target: 'npm test', since: 5000 });
    expect(done?.activity).toBeNull();
  });

  it('adds a commis for a subagent tool call and removes it when the call ends', () => {
    const [, withCommis, withoutCommis] = run(
      { type: 'prompt' },
      {
        type: 'tool.start',
        tool: 'Task',
        target: 'explore',
        subagent: { id: 't1', type: 'Explore' },
      },
      { type: 'tool.end', subagentId: 't1' },
    );
    expect(withCommis?.subagents).toEqual([
      { subagentId: 't1', type: 'Explore', state: 'working', activity: null },
    ]);
    expect(withoutCommis?.subagents).toEqual([]);
  });

  it('does not duplicate a commis for the same subagent id', () => {
    const [, , s] = run(
      { type: 'prompt' },
      { type: 'tool.start', tool: 'Task', target: null, subagent: { id: 't1', type: null } },
      { type: 'tool.start', tool: 'Task', target: null, subagent: { id: 't1', type: null } },
    );
    expect(s?.subagents).toHaveLength(1);
  });

  it('sends commis home when the turn stops', () => {
    const [, , s] = run(
      { type: 'prompt' },
      { type: 'tool.start', tool: 'Agent', target: null, subagent: { id: 't1', type: null } },
      { type: 'stop' },
    );
    expect(s?.subagents).toEqual([]);
  });

  it('replaces token totals without changing state', () => {
    const tokens = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 };
    const [, s] = run({ type: 'stop' }, { type: 'usage', tokens });
    expect(s?.tokens).toEqual(tokens);
    expect(s?.state).toBe('done');
  });

  it('goes idle and returns null on end', () => {
    const [, idle, ended] = run({ type: 'stop' }, { type: 'idle' }, { type: 'end' });
    expect(idle?.state).toBe('idle');
    expect(ended).toBeNull();
  });

  it('keeps the first cwd and repo, and never moves updatedAt backwards', () => {
    const [, s] = run(
      { type: 'prompt', cwd: '/a', repo: 'a', at: 2000 },
      { type: 'tool.end', cwd: '/b', repo: 'b', at: 1500 },
    );
    expect(s).toMatchObject({ cwd: '/a', repo: 'a', updatedAt: 2000, startedAt: 2000 });
  });

  it('ignores end for an unknown session', () => {
    expect(reduce(undefined, { sessionId: 'x', at: 1, type: 'end' })).toBeNull();
  });
});
