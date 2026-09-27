import type { CookState, ServerMessage } from 'orderup-shared';
import { describe, expect, it } from 'vitest';
import { DEMO_LOOP_MS, demoFrame, diffSessions, isDemo } from '../src/demo/script';
import { applyMessage, initialState } from '../src/net/store';

describe('demoFrame', () => {
  it('is deterministic and loops', () => {
    expect(demoFrame(3_210, 0)).toEqual(demoFrame(3_210, 0));
    expect(demoFrame(3_210 + DEMO_LOOP_MS, 0)).toEqual(demoFrame(3_210, 0));
  });

  it('covers every state, commis, crew and a cook arriving and leaving', () => {
    const states = new Set<CookState>();
    const ids = new Set<string>();
    let commis = 0;
    let crew = 0;
    const counts: number[] = [];
    for (let t = 0; t < DEMO_LOOP_MS; t += 250) {
      const frame = demoFrame(t, 0);
      counts.push(frame.length);
      for (const s of frame) {
        states.add(s.state);
        ids.add(s.sessionId);
        commis += s.subagents.length;
        if (s.kind === 'crew') crew++;
        expect(s.kind === 'crew').toBe(s.agent !== null);
      }
    }
    expect([...states].sort()).toEqual(['done', 'idle', 'waiting', 'working']);
    expect(commis).toBeGreaterThan(0);
    expect(crew).toBeGreaterThan(0);
    expect(Math.min(...counts)).toBeLessThan(Math.max(...counts));
    expect(ids.size).toBeGreaterThanOrEqual(4);
  });

  it('only ever grows tokens within a loop', () => {
    let prev = new Map<string, number>();
    for (let t = 0; t < DEMO_LOOP_MS; t += 100) {
      const next = new Map(
        demoFrame(t, 0).map((s) => [s.sessionId, s.tokens.input + s.tokens.output]),
      );
      for (const [id, n] of next) expect(n).toBeGreaterThanOrEqual(prev.get(id) ?? 0);
      prev = next;
    }
  });
});

describe('diffSessions', () => {
  it('replays the demo exactly through the store reducer', () => {
    let prev = demoFrame(0, 0);
    let state = applyMessage(initialState('demo'), { type: 'snapshot', sessions: prev });
    for (let t = 200; t < DEMO_LOOP_MS * 2; t += 200) {
      const next = demoFrame(t, Math.floor(t / DEMO_LOOP_MS) * DEMO_LOOP_MS);
      state = diffSessions(prev, next).reduce(applyMessage, state);
      expect([...state.sessions.values()]).toEqual(next);
      prev = next;
    }
  });

  it('emits nothing when nothing changed', () => {
    const f = demoFrame(1_000, 0);
    expect(diffSessions(f, f)).toEqual([]);
    const removed: ServerMessage[] = diffSessions(f, f.slice(1));
    expect(removed).toEqual([{ type: 'session.remove', sessionId: f[0]!.sessionId }]);
  });
});

describe('isDemo', () => {
  it('reads ?demo', () => {
    expect(isDemo('?demo')).toBe(true);
    expect(isDemo('?demo=1&x')).toBe(true);
    expect(isDemo('?x=demo')).toBe(false);
    expect(isDemo('')).toBe(false);
  });
});
