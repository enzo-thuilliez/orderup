/**
 * Session → cook mapping: where a cook stands, how it moves and what it says. Pure, no three.js.
 */
import type { Activity, CookState, SessionView, SubagentView, TokenUsage } from 'orderup-shared';
import { coffeeSpot, passSpot, stationSpot, type Point, type Spot } from './layout';

/** What the cook's arms are doing once it has arrived. */
export type Pose =
  | 'chop' // editing files
  | 'stir' // running commands
  | 'taste' // reading and searching
  | 'read' // web, todo lists: studying the recipe
  | 'direct' // handing work to a commis
  | 'bell' // waiting: ringing the bell at the pass
  | 'plate' // done: holding up a plate
  | 'sip'; // idle: coffee out back

const TOOL_POSES: Record<string, Pose> = {
  Edit: 'chop',
  MultiEdit: 'chop',
  Write: 'chop',
  NotebookEdit: 'chop',
  Bash: 'stir',
  BashOutput: 'stir',
  KillShell: 'stir',
  Read: 'taste',
  Grep: 'taste',
  Glob: 'taste',
  LS: 'taste',
  WebFetch: 'read',
  WebSearch: 'read',
  TodoWrite: 'read',
  Task: 'direct',
  Agent: 'direct',
};

export function toolPose(tool: string | null | undefined): Pose {
  return (tool && TOOL_POSES[tool]) || 'stir';
}

export function poseFor(state: CookState, activity: Activity | null): Pose {
  switch (state) {
    case 'working':
      return toolPose(activity?.tool);
    case 'waiting':
      return 'bell';
    case 'done':
      return 'plate';
    case 'idle':
      return 'sip';
  }
}

/** Where a cook in `state` goes: its station, the pass, or the coffee table out back. */
export function targetSpot(state: CookState, slot: number): Spot {
  switch (state) {
    case 'working':
      return stationSpot(slot);
    case 'waiting':
    case 'done':
      return passSpot(slot);
    case 'idle':
      return coffeeSpot(slot);
  }
}

/** Commis stand beside their chef: right, left, then behind. Offsets are in the chef's frame. */
const COMMIS_OFFSETS: readonly Point[] = [
  { x: -0.8, z: 0.05 },
  { x: 0.8, z: 0.05 },
  { x: -0.45, z: -0.7 },
  { x: 0.45, z: -0.7 },
];

export function commisOffset(index: number): Point {
  const base = COMMIS_OFFSETS[index % COMMIS_OFFSETS.length]!;
  const lap = Math.floor(index / COMMIS_OFFSETS.length);
  return { x: base.x * (1 + lap * 0.6), z: base.z - lap * 0.5 };
}

/** Rotate an offset from a cook's local frame (facing +z) into the world and add its position. */
export function besideChef(chef: Spot, offset: Point): Point {
  const c = Math.cos(chef.facing);
  const s = Math.sin(chef.facing);
  // three.js rotation.y: x' = x cos + z sin, z' = -x sin + z cos.
  return { x: chef.x + offset.x * c + offset.z * s, z: chef.z - offset.x * s + offset.z * c };
}

const MAX_BUBBLE = 34;

/** Short, readable target: the tail of a path, or the start of a command. */
export function shortTarget(target: string | null): string | null {
  if (!target) return null;
  const t = target.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const looksLikePath = !t.includes(' ') && t.includes('/');
  if (looksLikePath) {
    const parts = t.split('/').filter(Boolean);
    const tail = parts.slice(-2).join('/');
    return truncate(parts.length > 2 ? `…/${tail}` : tail, MAX_BUBBLE);
  }
  return truncate(t, MAX_BUBBLE);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Speech bubble above the cook, or null for none. */
export function bubbleText(state: CookState, activity: Activity | null): string | null {
  switch (state) {
    case 'working': {
      if (!activity) return 'Cooking…';
      const target = shortTarget(activity.target);
      return target ? `${activity.tool} · ${target}` : activity.tool;
    }
    case 'waiting':
      return 'Chef! Need you at the pass';
    case 'done':
      return 'Order up!';
    case 'idle':
      return null;
  }
}

export function subagentBubble(sub: SubagentView): string | null {
  return sub.state === 'working' ? bubbleText('working', sub.activity) : null;
}

/** Name tag: crew persona, else the repo, else the last folder of cwd. */
export function displayName(session: SessionView): string {
  if (session.agent) return session.agent.persona.name;
  if (session.repo) return session.repo;
  const parts = session.cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'cook';
}

export function totalTokens(t: TokenUsage): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim1(n / 1000)}k`;
  return `${trim1(n / 1_000_000)}M`;
}

function trim1(n: number): string {
  return (n >= 100 ? Math.round(n).toString() : n.toFixed(1)).replace(/\.0$/, '');
}

/** Stable small hash (FNV-1a) so a session keeps its apron colour across reloads. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Keep each cook at the station it already has; give newcomers the lowest free slot.
 * Returns a new map containing exactly `ids`.
 */
export function assignSlots(
  previous: ReadonlyMap<string, number>,
  ids: readonly string[],
): Map<string, number> {
  const next = new Map<string, number>();
  const used = new Set<number>();
  for (const id of ids) {
    const slot = previous.get(id);
    if (slot !== undefined && !used.has(slot)) {
      next.set(id, slot);
      used.add(slot);
    }
  }
  let free = 0;
  for (const id of ids) {
    if (next.has(id)) continue;
    while (used.has(free)) free++;
    next.set(id, free);
    used.add(free);
  }
  return next;
}

/** Id of the closest cook within `maxDistance`, or null. */
export function nearest<T extends Point & { id: string }>(
  from: Point,
  cooks: Iterable<T>,
  maxDistance: number,
): string | null {
  let best: string | null = null;
  let bestD = maxDistance;
  for (const c of cooks) {
    const d = Math.hypot(c.x - from.x, c.z - from.z);
    if (d <= bestD) {
      bestD = d;
      best = c.id;
    }
  }
  return best;
}

/** Move `pos` towards `target` by at most `maxStep`. */
export function stepToward(pos: Point, target: Point, maxStep: number): Point {
  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const d = Math.hypot(dx, dz);
  if (d <= maxStep || d === 0) return { x: target.x, z: target.z };
  return { x: pos.x + (dx / d) * maxStep, z: pos.z + (dz / d) * maxStep };
}

/** Turn `current` towards `target` (radians) by at most `maxStep`, the short way round. */
export function turnToward(current: number, target: number, maxStep: number): number {
  let delta = target - current;
  delta = Math.atan2(Math.sin(delta), Math.cos(delta));
  if (Math.abs(delta) <= maxStep) return target;
  return current + Math.sign(delta) * maxStep;
}
