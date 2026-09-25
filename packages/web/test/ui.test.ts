import { PROTOCOL_VERSION, type SessionView } from 'orderup-shared';
import { describe, expect, it } from 'vitest';
import { limbsFor } from '../src/scene/figure';
import { hudText } from '../src/ui/hud';
import { duration, panelModel } from '../src/ui/panel';

const session: SessionView = {
  sessionId: 's1',
  kind: 'observed',
  agent: null,
  cwd: '/home/me/code/orderup',
  repo: 'orderup',
  state: 'working',
  activity: { tool: 'Edit', target: 'packages/web/src/main.ts', since: 10_000 },
  tokens: { input: 1_200, output: 300, cacheRead: 40_000, cacheWrite: 500 },
  subagents: [
    {
      subagentId: 'a',
      type: 'Explore',
      state: 'working',
      activity: { tool: 'Grep', target: 'SessionView', since: 0 },
    },
    { subagentId: 'b', type: null, state: 'done', activity: null },
  ],
  startedAt: 0,
  updatedAt: 0,
};

describe('panelModel', () => {
  it('describes an observed cook live', () => {
    const m = panelModel(session, 75_000);
    expect(m.title).toBe('orderup');
    expect(m.subtitle).toBe('Observed · orderup');
    expect(m.activity).toEqual({ tool: 'Edit', target: 'packages/web/src/main.ts', for: '1m 05s' });
    expect(m.tokens[0]).toEqual({ label: 'Total', value: '42k' });
    expect(m.commis).toEqual([
      { name: 'Explore', doing: 'Grep · SessionView' },
      { name: 'commis', doing: 'done' },
    ]);
    expect(m.uptime).toBe('1m 15s');
  });

  it('describes a crew cook', () => {
    const m = panelModel(
      {
        ...session,
        kind: 'crew',
        agent: { agentId: 'x', role: 'sous-chef', persona: { name: 'Basil', hue: 150 } },
        activity: null,
        state: 'idle',
      },
      0,
    );
    expect(m.kind).toBe('crew');
    expect(m.title).toBe('Basil');
    expect(m.subtitle).toBe('Crew · sous-chef');
    expect(m.activity).toBeNull();
    expect(m.stateText).toMatch(/coffee/);
  });

  it('formats durations', () => {
    expect(duration(-5)).toBe('0s');
    expect(duration(59_999)).toBe('59s');
    expect(duration(3_600_000 + 10 * 60_000)).toBe('1h 10m');
  });
});

describe('hudText', () => {
  it('invites a session when the kitchen is empty', () => {
    expect(hudText('open', 0).notice).toMatch(/Claude Code session/);
    expect(hudText('open', 2)).toEqual({ status: 'Live · 2 cooks', notice: null });
    expect(hudText('open', 1).status).toBe('Live · 1 cook');
  });
  it('explains how to start the server while disconnected', () => {
    expect(hudText('connecting', 0).notice).toMatch(/\?demo/);
    expect(hudText('closed', 3)).toEqual({ status: 'Reconnecting… · 3 cooks', notice: null });
  });
  it('flags a protocol mismatch', () => {
    const t = hudText('incompatible', 0, { serverProtocol: PROTOCOL_VERSION + 1 });
    expect(t.notice).toContain(`v${PROTOCOL_VERSION + 1}`);
  });
  it('labels the demo', () => {
    expect(hudText('demo', 4).status).toMatch(/Demo/);
  });
});

describe('limbsFor', () => {
  it('swings legs only while walking', () => {
    expect(limbsFor('walk', 0.2, false).legSwing).not.toBe(0);
    expect(limbsFor('chop', 0.2, false).legSwing).toBe(0);
  });
  it('lifts the arms forward to work and to carry a plate', () => {
    expect(limbsFor('chop', 0, false).rightX).toBeLessThan(-1);
    expect(limbsFor('plate', 0, false).leftX).toBeLessThan(-1.3);
  });
  it('raises the arm high to wave, whatever the pose', () => {
    for (const pose of ['sip', 'stir', 'bell'] as const) {
      expect(limbsFor(pose, 1, true).rightZ).toBeLessThan(-2);
    }
  });
});
