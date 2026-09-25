import type { SessionView } from 'orderup-shared';
import { describe, expect, it } from 'vitest';
import {
  assignSlots,
  besideChef,
  bubbleText,
  commisOffset,
  displayName,
  formatTokens,
  hashString,
  nearest,
  poseFor,
  shortTarget,
  stepToward,
  targetSpot,
  toolPose,
  turnToward,
} from '../src/logic/cook';
import { coffeeSpot, passSpot, stationSpot, zoneOf } from '../src/logic/layout';

const session = (over: Partial<SessionView> = {}): SessionView => ({
  sessionId: 's1',
  kind: 'observed',
  agent: null,
  cwd: '/home/me/code/orderup',
  repo: 'orderup',
  state: 'working',
  activity: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  subagents: [],
  startedAt: 0,
  updatedAt: 0,
  ...over,
});

describe('state → place', () => {
  it('working cooks go to their station', () => {
    expect(targetSpot('working', 3)).toEqual(stationSpot(3));
  });
  it('waiting and done cooks go to the pass', () => {
    expect(targetSpot('waiting', 3)).toEqual(passSpot(3));
    expect(targetSpot('done', 3)).toEqual(passSpot(3));
    expect(zoneOf(targetSpot('done', 3))).toBe('front');
  });
  it('idle cooks take a coffee break out back', () => {
    expect(targetSpot('idle', 3)).toEqual(coffeeSpot(3));
    expect(zoneOf(targetSpot('idle', 3))).toBe('patio');
  });
});

describe('state → animation', () => {
  it('maps each state to its pose', () => {
    expect(poseFor('waiting', null)).toBe('bell');
    expect(poseFor('done', null)).toBe('plate');
    expect(poseFor('idle', null)).toBe('sip');
    expect(poseFor('working', null)).toBe('stir');
  });
  it('varies the working pose by tool', () => {
    const at = (tool: string) => poseFor('working', { tool, target: null, since: 0 });
    expect(at('Edit')).toBe('chop');
    expect(at('Write')).toBe('chop');
    expect(at('Bash')).toBe('stir');
    expect(at('Read')).toBe('taste');
    expect(at('Grep')).toBe('taste');
    expect(at('WebSearch')).toBe('read');
    expect(at('Task')).toBe('direct');
    expect(at('mcp__github__create_issue')).toBe('stir');
    expect(toolPose(undefined)).toBe('stir');
  });
});

describe('bubbles and labels', () => {
  it('shows the file or command while working', () => {
    expect(bubbleText('working', { tool: 'Edit', target: 'src/a.ts', since: 0 })).toBe(
      'Edit · src/a.ts',
    );
    expect(bubbleText('working', { tool: 'Bash', target: 'npm test', since: 0 })).toBe(
      'Bash · npm test',
    );
    expect(bubbleText('working', { tool: 'TodoWrite', target: null, since: 0 })).toBe('TodoWrite');
    expect(bubbleText('working', null)).toBe('Cooking…');
  });
  it('rings, calls "Order up!" and rests', () => {
    expect(bubbleText('waiting', null)).toMatch(/pass/);
    expect(bubbleText('done', null)).toBe('Order up!');
    expect(bubbleText('idle', null)).toBeNull();
  });
  it('shortens long paths and commands', () => {
    expect(shortTarget('/home/me/code/orderup/packages/web/src/main.ts')).toBe('…/src/main.ts');
    expect(shortTarget('src/main.ts')).toBe('src/main.ts');
    const cmd = shortTarget('npm run build && npm test -- --reporter verbose --watch=false');
    expect(cmd!.length).toBeLessThanOrEqual(34);
    expect(cmd!.endsWith('…')).toBe(true);
    expect(shortTarget('   ')).toBeNull();
    expect(shortTarget(null)).toBeNull();
  });
  it('names cooks by persona, repo, then folder', () => {
    expect(displayName(session())).toBe('orderup');
    expect(displayName(session({ repo: null, cwd: '/tmp/scratch/' }))).toBe('scratch');
    expect(displayName(session({ repo: null, cwd: 'C:\\code\\pie' }))).toBe('pie');
    expect(
      displayName(
        session({
          kind: 'crew',
          agent: { agentId: 'a', role: 'sous-chef', persona: { name: 'Basil', hue: 120 } },
        }),
      ),
    ).toBe('Basil');
  });
  it('formats token counts for the ticket', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1_000)).toBe('1k');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(456_789)).toBe('457k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });
  it('hashes stably', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
});

describe('assignSlots', () => {
  it('keeps existing stations and fills the lowest free slot', () => {
    const a = assignSlots(new Map(), ['x', 'y', 'z']);
    expect([...a]).toEqual([
      ['x', 0],
      ['y', 1],
      ['z', 2],
    ]);
    const b = assignSlots(a, ['z', 'w']);
    expect(b.get('z')).toBe(2);
    expect(b.get('w')).toBe(0);
    expect(b.has('x')).toBe(false);
  });
});

describe('commis', () => {
  it('stand beside their chef, rotated with the chef', () => {
    const facingViewer = besideChef({ x: 0, z: 0, facing: 0 }, commisOffset(0));
    expect(facingViewer.x).toBeCloseTo(-0.8);
    const facingWall = besideChef({ x: 0, z: 0, facing: Math.PI }, commisOffset(0));
    expect(facingWall.x).toBeCloseTo(0.8);
    const offsets = Array.from({ length: 6 }, (_, i) => commisOffset(i));
    expect(new Set(offsets.map((o) => `${o.x},${o.z}`)).size).toBe(6);
  });
});

describe('motion helpers', () => {
  it('steps towards a target without overshooting', () => {
    expect(stepToward({ x: 0, z: 0 }, { x: 3, z: 4 }, 1)).toEqual({ x: 0.6, z: 0.8 });
    expect(stepToward({ x: 0, z: 0 }, { x: 0.1, z: 0 }, 1)).toEqual({ x: 0.1, z: 0 });
  });
  it('turns the short way round', () => {
    expect(turnToward(3, -3, 0.1)).toBeCloseTo(3.1);
    expect(turnToward(0, 0.05, 0.1)).toBe(0.05);
  });
  it('finds the nearest cook in range', () => {
    const cooks = [
      { id: 'a', x: 1, z: 0 },
      { id: 'b', x: 3, z: 0 },
    ];
    expect(nearest({ x: 0, z: 0 }, cooks, 2)).toBe('a');
    expect(nearest({ x: 2.9, z: 0 }, cooks, 2)).toBe('b');
    expect(nearest({ x: 10, z: 0 }, cooks, 2)).toBeNull();
  });
});
