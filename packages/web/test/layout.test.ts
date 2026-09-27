import { describe, expect, it } from 'vitest';
import {
  BELL,
  COFFEE_SPOT_COUNT,
  DOOR_IN,
  DOOR_OUT,
  ISLAND,
  ISLAND_GAPS,
  ISLAND_XS,
  OBSTACLES,
  STATIONS,
  coffeeSpot,
  passSpot,
  route,
  slide,
  stationSpot,
  walkable,
  zoneOf,
  type Point,
} from '../src/logic/layout';

/** True if the segment a→b passes through the island row outside a gap. */
function crossesIslands(a: Point, b: Point): boolean {
  const half = ISLAND.depth / 2;
  if ((a.z < -half && b.z < -half) || (a.z > half && b.z > half)) return false;
  // Sample the segment inside the island band.
  for (let i = 0; i <= 50; i++) {
    const t = i / 50;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    if (Math.abs(z - ISLAND.z) > half) continue;
    if (ISLAND_XS.some((ix) => Math.abs(x - ix) < ISLAND.width / 2)) return true;
  }
  return false;
}

function walk(from: Point, to: Point): Point[] {
  return [from, ...route(from, to)];
}

describe('layout', () => {
  it('has ten distinct stations, islands first', () => {
    expect(STATIONS).toHaveLength(10);
    const keys = new Set(STATIONS.map((s) => `${s.x},${s.z}`));
    expect(keys.size).toBe(10);
    expect(stationSpot(0).facing).toBe(0);
    expect(stationSpot(5).facing).toBeCloseTo(Math.PI);
  });

  it('shifts overflow cooks so they do not stack', () => {
    expect(stationSpot(10).x).not.toBe(stationSpot(0).x);
    expect(passSpot(10).x).not.toBe(passSpot(0).x);
  });

  it('puts every pass spot in front of the pass, facing out', () => {
    for (let i = 0; i < 10; i++) {
      const p = passSpot(i);
      expect(zoneOf(p)).toBe('front');
      expect(p.facing).toBe(0);
      expect(p.z).toBeLessThan(BELL.z);
    }
  });

  it('puts coffee spots on the patio, facing the table', () => {
    for (let i = 0; i < COFFEE_SPOT_COUNT; i++) {
      const s = coffeeSpot(i);
      expect(zoneOf(s)).toBe('patio');
      expect(walkable(s, 0.1)).toBe(true);
    }
  });

  it('classifies zones', () => {
    expect(zoneOf(stationSpot(0))).toBe('back');
    expect(zoneOf(stationSpot(7))).toBe('back');
    expect(zoneOf(passSpot(3))).toBe('front');
    expect(zoneOf(DOOR_OUT)).toBe('patio');
    expect(zoneOf(DOOR_IN)).toBe('back');
  });
});

describe('route', () => {
  it('goes straight within a zone', () => {
    expect(route(stationSpot(0), stationSpot(6))).toEqual([stationSpot(6)]);
  });

  it('goes round the islands through a gap', () => {
    for (let s = 0; s < 10; s++) {
      const path = walk(stationSpot(s), passSpot(s));
      expect(path.length).toBe(4);
      expect(ISLAND_GAPS).toContain(path[1]!.x);
      for (let i = 1; i < path.length; i++)
        expect(crossesIslands(path[i - 1]!, path[i]!)).toBe(false);
    }
  });

  it('goes out through the back door to the patio and back in', () => {
    const out = route(passSpot(2), coffeeSpot(0));
    expect(out.slice(-3)).toEqual([DOOR_IN, DOOR_OUT, coffeeSpot(0)]);
    const back = route(coffeeSpot(0), stationSpot(1));
    expect(back.slice(0, 2)).toEqual([DOOR_OUT, DOOR_IN]);
    expect(back.at(-1)).toEqual(stationSpot(1));
    for (const path of [walk(passSpot(2), coffeeSpot(0)), walk(coffeeSpot(0), passSpot(8))]) {
      for (let i = 1; i < path.length; i++)
        expect(crossesIslands(path[i - 1]!, path[i]!)).toBe(false);
    }
  });
});

describe('walkable / slide', () => {
  it('keeps the walker inside the kitchen and out of furniture', () => {
    expect(walkable({ x: 0, z: 2 })).toBe(true);
    expect(walkable({ x: 0, z: 6 })).toBe(true); // dining side
    expect(walkable({ x: -9, z: 0 })).toBe(false); // through the left wall
    expect(walkable({ x: 0, z: -7 })).toBe(false); // through the back wall
    expect(walkable({ x: 0, z: 0 })).toBe(false); // on an island
    expect(walkable({ x: 1.5, z: 0 })).toBe(true); // in a gap
    expect(OBSTACLES.length).toBeGreaterThan(5);
  });

  it('only lets the walker through the wall at the door', () => {
    expect(walkable({ x: 8, z: -3.5 })).toBe(true);
    expect(walkable({ x: 8, z: 2 })).toBe(false);
    expect(walkable({ x: 9.5, z: -2 })).toBe(true); // patio
  });

  it('slides along walls instead of stopping', () => {
    const next = slide({ x: 0, z: 6.5 }, { x: 0.5, z: 7.5 });
    expect(next).toEqual({ x: 0.5, z: 6.5 });
    expect(slide({ x: 0, z: 2 }, { x: 0, z: 0 })).toEqual({ x: 0, z: 2 });
  });
});
