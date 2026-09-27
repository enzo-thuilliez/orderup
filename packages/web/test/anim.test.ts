import type { Activity, CookState } from 'orderup-shared';
import { describe, expect, it } from 'vitest';
import {
  BELL_PERIOD,
  POP_SECONDS,
  SHRINK_SECONDS,
  STEAM_PUFFS,
  WAVE_OUT_SECONDS,
  blendInto,
  commisMotion,
  commisPhase,
  commisScale,
  hopFor,
  idleAct,
  idleBeat,
  planFor,
  popScale,
  smoothing,
  steamPuff,
  stepTrack,
  type AnimInput,
  type Track,
} from '../src/logic/anim';

const act = (tool: string): Activity => ({ tool, target: null, since: 0 });

const input = (over: Partial<AnimInput> = {}): AnimInput => ({
  state: 'working',
  activity: null,
  walking: false,
  arrivedFor: 5,
  seed: 1234,
  t: 10,
  reduced: false,
  ...over,
});

describe('state → animation plan', () => {
  it('working: tool pose at the station, with steam', () => {
    const edit = planFor(input({ activity: act('Edit') }));
    expect(edit).toMatchObject({ motion: 'chop', carry: null, steam: true, alert: false, hop: 0 });
    expect(planFor(input({ activity: act('Bash') })).motion).toBe('stir');
    expect(planFor(input({ activity: act('Read') })).motion).toBe('taste');
  });

  it('working: no steam over a recipe card, a commis briefing, or on the way', () => {
    expect(planFor(input({ activity: act('WebSearch') })).steam).toBe(false);
    expect(planFor(input({ activity: act('Task') })).steam).toBe(false);
    expect(planFor(input({ walking: true, arrivedFor: null })).steam).toBe(false);
  });

  it('waiting: rings the bell, shows "!" and bounces', () => {
    const p = planFor(input({ state: 'waiting', t: 0.2 }));
    expect(p).toMatchObject({ motion: 'bell', alert: true, bubble: true, steam: false });
    expect(p.hop).toBeGreaterThan(0);
    // The "!" is up from the moment the state changes, even on the way to the pass.
    expect(planFor(input({ state: 'waiting', walking: true, arrivedFor: null })).alert).toBe(true);
  });

  it('done: carries the plate, and only calls "Order up!" at the pass', () => {
    const walking = planFor(input({ state: 'done', walking: true, arrivedFor: null }));
    expect(walking).toMatchObject({ motion: 'walk', carry: 'plate', bubble: false, hop: 0 });
    const arrived = planFor(input({ state: 'done', arrivedFor: 0.2 }));
    expect(arrived).toMatchObject({ motion: 'plate', carry: 'plate', bubble: true });
    expect(arrived.hop).toBeGreaterThan(0);
    expect(planFor(input({ state: 'done', arrivedFor: 3 })).hop).toBe(0);
  });

  it('idle: coffee in hand, with sips, stretches and looks around', () => {
    const seen = new Set<string>();
    for (let t = 0; t < 200; t += 0.5) {
      const p = planFor(input({ state: 'idle', t }));
      expect(p.carry).toBe('mug');
      seen.add(p.motion);
    }
    expect([...seen].sort()).toEqual(['gaze', 'sip', 'stretch']);
  });

  it('walks between spots in every state', () => {
    for (const state of ['working', 'waiting', 'done', 'idle'] as CookState[]) {
      expect(planFor(input({ state, walking: true, arrivedFor: null })).motion).toBe('walk');
    }
  });

  it('reduced motion: no steam, no hops, no idle extras', () => {
    const reduced = (over: Partial<AnimInput>) => planFor(input({ ...over, reduced: true }));
    expect(reduced({ activity: act('Edit') }).steam).toBe(false);
    expect(reduced({ state: 'waiting', t: 0.2 }).hop).toBe(0);
    expect(reduced({ state: 'done', arrivedFor: 0.2 }).hop).toBe(0);
    for (let t = 0; t < 100; t += 1) expect(reduced({ state: 'idle', t }).motion).toBe('sip');
    // State stays readable: the "!" and the bubble remain.
    expect(reduced({ state: 'waiting' }).alert).toBe(true);
  });
});

describe('hops', () => {
  it('bounces once per bell period while waiting', () => {
    expect(hopFor('waiting', 1, 0.2)).toBeCloseTo(hopFor('waiting', 1, 0.2 + BELL_PERIOD * 3));
    expect(hopFor('waiting', 1, BELL_PERIOD - 0.1)).toBe(0);
  });
  it('never sinks below the floor', () => {
    for (let t = 0; t < 5; t += 0.01) {
      for (const s of ['working', 'waiting', 'done', 'idle'] as CookState[]) {
        expect(hopFor(s, t, t)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('idle variations', () => {
  it('is deterministic for a cook', () => {
    expect(idleAct(42, 17.3)).toBe(idleAct(42, 17.3));
  });
  it('holds an act for a whole beat', () => {
    const seed = 777;
    const beat = idleBeat(seed);
    expect(beat).toBeGreaterThanOrEqual(4);
    expect(beat).toBeLessThanOrEqual(7);
    let changes = 0;
    let prev = idleAct(seed, 0);
    for (let t = 0; t < beat * 20; t += 0.05) {
      const a = idleAct(seed, t);
      if (a !== prev) changes++;
      prev = a;
    }
    expect(changes).toBeLessThanOrEqual(21);
  });
  it('mostly sips', () => {
    let sips = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) if (idleAct(99, i * 7.3) === 'sip') sips++;
    expect(sips / n).toBeGreaterThan(0.45);
    expect(sips / n).toBeLessThan(0.75);
  });
  it("doesn't keep cooks in sync", () => {
    let same = 0;
    const n = 400;
    for (let i = 0; i < n; i++) if (idleAct(1, i * 1.7) === idleAct(2, i * 1.7)) same++;
    expect(same).toBeLessThan(n * 0.8);
  });
});

describe('transitions', () => {
  const run = (steps: [CookState, boolean, number][]) => {
    let track: Track | null = null;
    const cues: string[][] = [];
    for (const [state, walking, t] of steps) {
      const r = stepTrack(track, state, walking, t);
      track = r.track;
      cues.push(r.cues);
    }
    return { track: track!, cues };
  };

  it('stamps arrival when the walk ends', () => {
    const { track } = run([
      ['done', true, 0],
      ['done', true, 1],
      ['done', false, 2],
      ['done', false, 3],
    ]);
    expect(track).toEqual({ state: 'done', arrivedAt: 2 });
  });

  it('calls "Order up!" once, on arrival at the pass', () => {
    const { cues } = run([
      ['working', false, 0],
      ['done', true, 1],
      ['done', false, 2],
      ['done', false, 3],
    ]);
    expect(cues).toEqual([[], [], ['orderUp'], []]);
  });

  it('rings on arrival when waiting', () => {
    const { cues } = run([
      ['waiting', true, 0],
      ['waiting', false, 1],
    ]);
    expect(cues[1]).toEqual(['ring']);
  });

  it('resets on a state change, even without walking (waiting → done at the pass)', () => {
    const { track, cues } = run([
      ['waiting', false, 0],
      ['done', false, 4],
    ]);
    expect(track.arrivedAt).toBe(4);
    expect(cues).toEqual([['ring'], ['orderUp']]);
  });

  it('a cook already in place when the page loads arrives on the first frame', () => {
    expect(stepTrack(null, 'working', false, 7)).toEqual({
      track: { state: 'working', arrivedAt: 7 },
      cues: [],
    });
  });
});

describe('commis lifecycle', () => {
  it('pops in with an overshoot, then stays at full size', () => {
    expect(commisPhase(0, null, false)).toBe('pop');
    expect(commisScale(0, null, false)).toBe(0);
    let peak = 0;
    for (let a = 0; a <= POP_SECONDS; a += 0.01) peak = Math.max(peak, popScale(a));
    expect(peak).toBeGreaterThan(1);
    expect(commisPhase(POP_SECONDS + 0.01, null, false)).toBe('follow');
    expect(commisScale(10, null, false)).toBe(1);
  });

  it('waves, then shrinks, then is gone', () => {
    expect(commisPhase(10, 0, false)).toBe('wave');
    expect(commisScale(10, 0.5, false)).toBe(1);
    expect(commisPhase(10, WAVE_OUT_SECONDS + 0.1, false)).toBe('shrink');
    const mid = commisScale(10, WAVE_OUT_SECONDS + SHRINK_SECONDS / 2, false);
    expect(mid).toBeCloseTo(0.5);
    expect(commisPhase(10, WAVE_OUT_SECONDS + SHRINK_SECONDS, false)).toBe('gone');
  });

  it('reduced motion: appears and leaves at once', () => {
    expect(commisPhase(0, null, true)).toBe('follow');
    expect(commisScale(0, null, true)).toBe(1);
    expect(commisPhase(10, 0, true)).toBe('gone');
  });

  it('follows, works its own tool, and helps its chef', () => {
    const m = (over: Partial<Parameters<typeof commisMotion>[0]>) =>
      commisMotion({
        subState: 'working',
        subActivity: act('Grep'),
        chefState: 'working',
        walking: false,
        leaving: false,
        ...over,
      });
    expect(m({ walking: true })).toBe('walk');
    expect(m({})).toBe('taste');
    expect(m({ subState: 'done' })).toBe('help');
    expect(m({ subState: 'done', chefState: 'waiting' })).toBe('help');
    expect(m({ subState: 'done', chefState: 'idle' })).toBe('sip');
    // Leaving: tools down (no prop in a gaze) so the wave reads.
    expect(m({ leaving: true })).toBe('gaze');
  });
});

describe('blending', () => {
  it('smoothing is frame-rate independent', () => {
    const once = smoothing(12, 1 / 30);
    const twice = 1 - (1 - smoothing(12, 1 / 60)) ** 2;
    expect(twice).toBeCloseTo(once);
    expect(smoothing(12, 0)).toBe(0);
  });
  it('moves every field towards the target', () => {
    const a = { x: 0, y: 10 };
    blendInto(a, { x: 10, y: 0 }, 0.25);
    expect(a).toEqual({ x: 2.5, y: 7.5 });
  });
});

describe('steam', () => {
  it('puffs rise, stay small and are staggered', () => {
    const ys = new Set<number>();
    for (let i = 0; i < STEAM_PUFFS; i++) {
      for (let t = 0; t < 4; t += 0.1) {
        const p = steamPuff(i, t, 5);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(0.7);
        expect(p.scale).toBeGreaterThanOrEqual(0);
        expect(p.scale).toBeLessThanOrEqual(0.15);
      }
      ys.add(Math.round(steamPuff(i, 1, 5).y * 100));
    }
    expect(ys.size).toBe(STEAM_PUFFS);
  });
});
