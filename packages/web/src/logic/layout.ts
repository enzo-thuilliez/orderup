/**
 * Kitchen floor plan, in metres. Pure data and geometry, no three.js, so it can be unit-tested.
 *
 * Seen from above (x to the right, z towards the viewer):
 *
 *   z=-6  ┌──────── back counter (stations 5-9) ────────┐
 *         │  cooks face the wall                          door ─▶ patio (coffee break)
 *   z= 0  │  [isl 0] [isl 1] [isl 2] [isl 3] [isl 4]      │  cooks stand behind, facing +z
 *   z=4.2 │  ═════════════ the pass (bell, ticket rail) ═══│
 *   z= 7  └ dining side (open, no wall) ─────────────────┘
 */

export interface Point {
  x: number;
  z: number;
}

/** Axis-aligned box on the floor. */
export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const ROOM: Rect = { minX: -8, maxX: 8, minZ: -6, maxZ: 7 };
export const WALL_HEIGHT = 2.8;

export const DOOR = { x: ROOM.maxX, z: -3.5, width: 1.4, height: 2.2 } as const;
/** Just inside and just outside the back door. */
export const DOOR_IN: Point = { x: 7.3, z: DOOR.z };
export const DOOR_OUT: Point = { x: 8.8, z: DOOR.z };
/** Where cooks appear and vanish, past the edge of the patio. */
export const OFFSTAGE: Point = { x: 13.2, z: DOOR.z };

export const PATIO: Rect = { minX: ROOM.maxX, maxX: 12.6, minZ: -6, maxZ: -1 };
export const COFFEE_TABLE: Point = { x: 11.3, z: DOOR.z };
export const COFFEE_TABLE_RADIUS = 0.45;

export const ISLAND_XS = [-6, -3, 0, 3, 6] as const;
export const ISLAND = { z: 0, width: 1.9, depth: 1 } as const;
export const BACK_COUNTER = { z: -5.45, depth: 1.1, minX: -7.9, maxX: 7.9 } as const;
export const PASS = { z: 4.2, depth: 0.8, minX: -7, maxX: 7, height: 1.0 } as const;
export const BELL: Point = { x: 0, z: PASS.z };

/** Island cooks stand behind the island facing the pass; back-row cooks face the wall. */
const ISLAND_COOK_Z = -1.15;
const BACK_COOK_Z = BACK_COUNTER.z + BACK_COUNTER.depth / 2 + 0.55;
/** Cooks at the pass stand this far in front of it, facing the dining side. */
const PASS_COOK_Z = PASS.z - PASS.depth / 2 - 0.5;

export interface Spot extends Point {
  /** Heading in radians, three.js `rotation.y` for a model facing +z. */
  facing: number;
}

/** Ten stations: the islands first (faces towards the viewer), then the back counter. */
export const STATIONS: readonly Spot[] = [
  ...ISLAND_XS.map((x) => ({ x, z: ISLAND_COOK_Z, facing: 0 })),
  ...ISLAND_XS.map((x) => ({ x, z: BACK_COOK_Z, facing: Math.PI })),
];

/** Walkways through the island row: between islands and at both ends. */
export const ISLAND_GAPS: readonly number[] = [-7.45, -4.5, -1.5, 1.5, 4.5, 7.45];

/** Front of the kitchen (the pass side) starts past the islands. */
const FRONT_Z = ISLAND.z + ISLAND.depth / 2 + 0.05;
const AISLE_BACK_Z = ISLAND_COOK_Z;
const AISLE_FRONT_Z = ISLAND.z + ISLAND.depth / 2 + 0.6;

export function stationSpot(slot: number): Spot {
  const n = STATIONS.length;
  const base = STATIONS[mod(slot, n)]!;
  // Past ten cooks, share stations with a small sideways shift so nobody stacks exactly.
  const lap = Math.floor(slot / n);
  return { ...base, x: base.x + lap * 0.45 * (lap % 2 ? 1 : -1) };
}

export function passSpot(slot: number): Spot {
  const n = STATIONS.length;
  const lap = Math.floor(slot / n);
  const x = -6.3 + mod(slot, n) * 1.4 + lap * 0.35;
  return { x, z: PASS_COOK_Z, facing: 0 };
}

/** Coffee spots on two half-rings around the table, all on the door side of it. */
const COFFEE_SPOTS: readonly Spot[] = (() => {
  const spots: Spot[] = [];
  const rings = [
    { r: 1.1, n: 4 },
    { r: 1.9, n: 6 },
  ];
  for (const { r, n } of rings) {
    for (let i = 0; i < n; i++) {
      // Angles from 110° to 250° measured from +x: the half facing the door.
      const a = ((110 + (140 * i) / (n - 1)) * Math.PI) / 180;
      const x = COFFEE_TABLE.x + Math.cos(a) * r;
      const z = COFFEE_TABLE.z + Math.sin(a) * r;
      spots.push({ x, z, facing: headingTo({ x, z }, COFFEE_TABLE) });
    }
  }
  return spots;
})();

export function coffeeSpot(slot: number): Spot {
  return COFFEE_SPOTS[mod(slot, COFFEE_SPOTS.length)]!;
}

export const COFFEE_SPOT_COUNT = COFFEE_SPOTS.length;

export type Zone = 'back' | 'front' | 'patio';

export function zoneOf(p: Point): Zone {
  if (p.x > ROOM.maxX - 0.1) return 'patio';
  return p.z >= FRONT_Z ? 'front' : 'back';
}

/**
 * Waypoints from `from` to `to` (last one is `to`) that avoid the islands and walls: back and
 * front of the kitchen connect through the island gaps, the patio through the back door.
 */
export function route(from: Point, to: Point): Point[] {
  const a = zoneOf(from);
  const b = zoneOf(to);
  if (a === b) return [to];
  if (a === 'patio') return [DOOR_OUT, DOOR_IN, ...route(DOOR_IN, to)];
  if (b === 'patio') return [...route(from, DOOR_IN), DOOR_OUT, to];
  const gx = nearestGap((from.x + to.x) / 2);
  const back = { x: gx, z: AISLE_BACK_Z };
  const front = { x: gx, z: AISLE_FRONT_Z };
  return a === 'back' ? [back, front, to] : [front, back, to];
}

function nearestGap(x: number): number {
  let best = ISLAND_GAPS[0]!;
  for (const g of ISLAND_GAPS) if (Math.abs(g - x) < Math.abs(best - x)) best = g;
  return best;
}

/** Furniture the walker can't pass through. */
export const OBSTACLES: readonly Rect[] = [
  ...ISLAND_XS.map((x) => centered(x, ISLAND.z, ISLAND.width, ISLAND.depth)),
  {
    minX: BACK_COUNTER.minX,
    maxX: BACK_COUNTER.maxX,
    minZ: ROOM.minZ,
    maxZ: BACK_COUNTER.z + BACK_COUNTER.depth / 2,
  },
  {
    minX: PASS.minX,
    maxX: PASS.maxX,
    minZ: PASS.z - PASS.depth / 2,
    maxZ: PASS.z + PASS.depth / 2,
  },
  centered(COFFEE_TABLE.x, COFFEE_TABLE.z, COFFEE_TABLE_RADIUS * 2, COFFEE_TABLE_RADIUS * 2),
];

/** Personal radius of the first-person walker. */
export const WALKER_RADIUS = 0.3;

/** Whether the walker (a circle of `WALKER_RADIUS`) can stand at `p`. */
export function walkable(p: Point, r = WALKER_RADIUS): boolean {
  const inRoom = inside(p, inset(ROOM, r));
  const inPatio = inside(p, inset(PATIO, r));
  const inDoor =
    Math.abs(p.z - DOOR.z) <= DOOR.width / 2 - r && p.x >= ROOM.maxX - 1 && p.x <= ROOM.maxX + 1;
  if (!inRoom && !inPatio && !inDoor) return false;
  return !OBSTACLES.some((o) => inside(p, grow(o, r)));
}

/** Move from `from` towards `to`, sliding along walls and counters instead of stopping dead. */
export function slide(from: Point, to: Point): Point {
  if (walkable(to)) return to;
  const xOnly = { x: to.x, z: from.z };
  if (walkable(xOnly)) return xOnly;
  const zOnly = { x: from.x, z: to.z };
  if (walkable(zOnly)) return zOnly;
  return from;
}

export function headingTo(from: Point, to: Point): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function inside(p: Point, r: Rect): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;
}

function inset(r: Rect, d: number): Rect {
  return { minX: r.minX + d, maxX: r.maxX - d, minZ: r.minZ + d, maxZ: r.maxZ - d };
}

function grow(r: Rect, d: number): Rect {
  return inset(r, -d);
}

function centered(x: number, z: number, w: number, d: number): Rect {
  return { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 };
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
