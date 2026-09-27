/**
 * State → animation: which motion a cook plays, what it carries, which effects are on, and the
 * one-shot cues fired on arrival. Pure, no three.js: `scene/cooks.ts` feeds it time and state.
 */
import type { Activity, CookState } from 'orderup-shared';
import { hashString, poseFor, type Pose } from './cook';

/** Everything a figure can play: a pose at a spot, walking between spots, or an idle extra. */
export type Motion =
  | Pose
  | 'walk'
  | 'stretch' // idle: arms up, lean back
  | 'gaze' // idle: looks around the patio
  | 'help'; // commis: hands something to its chef

export type Carry = 'plate' | 'mug' | null;

/** Steam rises from the pot or board while a cook is working at its station. */
const STEAMY: ReadonlySet<Motion> = new Set<Motion>(['chop', 'stir', 'taste']);

export interface AnimInput {
  state: CookState;
  activity: Activity | null;
  walking: boolean;
  /** Seconds since the cook arrived at its spot for this state, or null while on the way. */
  arrivedFor: number | null;
  /** Per-cook seed, so idle cooks don't move in sync. */
  seed: number;
  /** Scene time in seconds. */
  t: number;
  reduced: boolean;
}

export interface AnimPlan {
  motion: Motion;
  carry: Carry;
  steam: boolean;
  /** "!" over the head. */
  alert: boolean;
  /** Speech bubble visible (the "Order up!" call waits until the plate is at the pass). */
  bubble: boolean;
  /** Extra height of the whole figure (a hop), metres. */
  hop: number;
}

export function planFor(i: AnimInput): AnimPlan {
  const carry: Carry = i.state === 'done' ? 'plate' : i.state === 'idle' ? 'mug' : null;
  const arrived = !i.walking && i.arrivedFor !== null;
  let motion: Motion = i.walking ? 'walk' : poseFor(i.state, i.activity);
  if (!i.walking && i.state === 'idle' && !i.reduced) motion = idleAct(i.seed, i.t);
  return {
    motion,
    carry,
    steam: arrived && i.state === 'working' && STEAMY.has(motion) && !i.reduced,
    alert: i.state === 'waiting',
    bubble: i.state !== 'done' || arrived,
    hop: i.reduced || !arrived ? 0 : hopFor(i.state, i.arrivedFor!, i.t),
  };
}

/** Waiting cooks bounce with each ring; a finished cook hops once as it calls "Order up!". */
export function hopFor(state: CookState, arrivedFor: number, t: number): number {
  if (state === 'waiting') {
    const c = t % BELL_PERIOD;
    return c < 0.4 ? Math.sin((c / 0.4) * Math.PI) * 0.06 : 0;
  }
  if (state === 'done' && arrivedFor < ORDER_UP_HOP) {
    return Math.sin((arrivedFor / ORDER_UP_HOP) * Math.PI) * 0.14;
  }
  return 0;
}

/** Seconds per bell cycle, shared with the arm tap and the bell dome. */
export const BELL_PERIOD = 1.2;
const ORDER_UP_HOP = 0.45;

// --- Idle: small random variations -----------------------------------------------------------

const IDLE_ACTS = ['sip', 'sip', 'sip', 'stretch', 'gaze'] as const;
export type IdleAct = (typeof IDLE_ACTS)[number];

/**
 * What an idle cook does at time `t`. Time is cut into beats whose length depends on the seed
 * (4–7 s), and each beat picks an act from a hash of (seed, beat): mostly sipping, sometimes a
 * stretch or a look around. Deterministic, so it can be tested, but no two cooks line up.
 */
export function idleAct(seed: number, t: number): IdleAct {
  const beat = idleBeat(seed);
  const offset = (seed % 997) / 997;
  const n = Math.floor(t / beat + offset);
  return IDLE_ACTS[hashString(`${seed}:${n}`) % IDLE_ACTS.length]!;
}

export function idleBeat(seed: number): number {
  return 4 + (seed % 31) / 10;
}

// --- Commis ----------------------------------------------------------------------------------

/** Seconds a new commis takes to pop in, and a leaving one waves before it shrinks away. */
export const POP_SECONDS = 0.35;
export const WAVE_OUT_SECONDS = 0.9;
export const SHRINK_SECONDS = 0.3;

/** Back-out easing: 0 → 1 with a small overshoot, for pops. */
export function popScale(age: number, duration = POP_SECONDS): number {
  if (age <= 0) return 0;
  if (age >= duration) return 1;
  const x = age / duration - 1;
  const k = 2.2;
  return 1 + (k + 1) * x * x * x + k * x * x;
}

export type CommisPhase = 'pop' | 'follow' | 'wave' | 'shrink' | 'gone';

/** Lifecycle of a commis from its age and, once it has been told to leave, time since then. */
export function commisPhase(age: number, leftFor: number | null, reduced: boolean): CommisPhase {
  if (leftFor !== null) {
    if (reduced) return 'gone';
    if (leftFor < WAVE_OUT_SECONDS) return 'wave';
    return leftFor < WAVE_OUT_SECONDS + SHRINK_SECONDS ? 'shrink' : 'gone';
  }
  return !reduced && age < POP_SECONDS ? 'pop' : 'follow';
}

/** Scale factor (0–1) for a commis in its lifecycle, before the commis size is applied. */
export function commisScale(age: number, leftFor: number | null, reduced: boolean): number {
  const phase = commisPhase(age, leftFor, reduced);
  switch (phase) {
    case 'pop':
      return popScale(age);
    case 'follow':
    case 'wave':
      return 1;
    case 'shrink':
      return 1 - (leftFor! - WAVE_OUT_SECONDS) / SHRINK_SECONDS;
    case 'gone':
      return 0;
  }
}

export interface CommisInput {
  subState: CookState;
  subActivity: Activity | null;
  chefState: CookState;
  walking: boolean;
  /** Told to leave: puts its tools down to wave goodbye. */
  leaving: boolean;
}

/**
 * A commis walks after its chef, does its own tool pose while it works, and otherwise helps:
 * hands things over at the station, and mirrors its chef at the pass or on break.
 */
export function commisMotion(c: CommisInput): Motion {
  if (c.leaving) return 'gaze';
  if (c.walking) return 'walk';
  if (c.subState === 'working') return poseFor('working', c.subActivity);
  if (c.chefState === 'working') return 'help';
  const chef = poseFor(c.chefState, null);
  // The bell and the plate are the chef's; the commis cheers them on instead.
  return chef === 'bell' || chef === 'plate' ? 'help' : chef;
}

// --- Transitions -----------------------------------------------------------------------------

/** Per-cook animation memory: current state, and when it arrived at that state's spot. */
export interface Track {
  state: CookState;
  arrivedAt: number | null;
}

export type Cue = 'orderUp' | 'ring';

/**
 * Advance a cook's track by one frame. A new state clears the arrival; arriving at the spot
 * stamps it and fires the state's cue once ("Order up!" at the pass, the first ring of the bell).
 */
export function stepTrack(
  prev: Track | null,
  state: CookState,
  walking: boolean,
  t: number,
): { track: Track; cues: Cue[] } {
  const changed = !prev || prev.state !== state;
  let arrivedAt = changed ? null : prev.arrivedAt;
  const cues: Cue[] = [];
  if (walking) {
    arrivedAt = null;
  } else if (arrivedAt === null) {
    arrivedAt = t;
    if (state === 'done') cues.push('orderUp');
    if (state === 'waiting') cues.push('ring');
  }
  return { track: { state, arrivedAt }, cues };
}

// --- Blending --------------------------------------------------------------------------------

/** Frame-rate independent smoothing factor: how far to move towards a target this frame. */
export function smoothing(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Move every numeric field of `current` towards `target` by `alpha` (0–1), in place. */
export function blendInto<T extends object>(current: T, target: T, alpha: number): T {
  const c = current as Record<string, number>;
  const tg = target as Record<string, number>;
  for (const k of Object.keys(tg)) c[k] = c[k]! + (tg[k]! - c[k]!) * alpha;
  return current;
}

// --- Steam -----------------------------------------------------------------------------------

export const STEAM_PUFFS = 3;
const STEAM_LIFE = 1.8;

export interface Puff {
  /** Height above the pot, metres. */
  y: number;
  /** Sideways drift, metres. */
  dx: number;
  scale: number;
}

/** Puff `i` of a cook's steam at time `t`: rises, drifts, swells then fades out by shrinking. */
export function steamPuff(i: number, t: number, seed: number): Puff {
  const life = (t / STEAM_LIFE + i / STEAM_PUFFS + (seed % 100) / 100) % 1;
  return {
    y: life * 0.7,
    dx: Math.sin(life * 5 + i * 2.1 + seed) * 0.05,
    scale: Math.sin(life * Math.PI) * (0.11 + 0.04 * ((i + seed) % 2)),
  };
}
