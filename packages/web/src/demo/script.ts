/**
 * `?demo`: a scripted kitchen with fake sessions, so the page works without the server.
 * Deterministic and loops every `DEMO_LOOP_MS`: `demoFrame(t)` is a pure function of time.
 */
import {
  PROTOCOL_VERSION,
  type AgentRef,
  type CookKind,
  type CookState,
  type ServerMessage,
  type SessionView,
  type SubagentView,
} from 'orderup-shared';

export const DEMO_LOOP_MS = 15_000;

interface Segment {
  at: number;
  state: CookState;
  tool?: string;
  target?: string;
}

interface CommisScript {
  id: string;
  type: string;
  from: number;
  to: number;
  segments: Segment[];
}

interface CookScript {
  id: string;
  kind: CookKind;
  agent: AgentRef | null;
  cwd: string;
  repo: string | null;
  /** Present from `arrive` (inclusive) to `leave` (exclusive), in loop ms. */
  arrive?: number;
  leave?: number;
  baseTokens: number;
  /** Tokens per working second. */
  rate: number;
  segments: Segment[];
  commis?: CommisScript[];
}

const SCRIPT: readonly CookScript[] = [
  {
    id: 'demo-orderup',
    kind: 'observed',
    agent: null,
    cwd: '/home/chef/code/orderup',
    repo: 'orderup',
    baseTokens: 182_000,
    rate: 2_400,
    segments: [
      { at: 0, state: 'working', tool: 'Edit', target: 'packages/web/src/scene/cook.ts' },
      { at: 2_000, state: 'working', tool: 'Bash', target: 'npm test' },
      { at: 4_000, state: 'working', tool: 'Read', target: 'docs/architecture.md' },
      { at: 5_000, state: 'waiting', tool: 'Bash', target: 'git push -u origin feat/web' },
      { at: 8_000, state: 'working', tool: 'Write', target: 'packages/web/src/demo/script.ts' },
      { at: 11_000, state: 'done' },
    ],
    commis: [
      {
        id: 'demo-orderup-explore',
        type: 'Explore',
        from: 1_000,
        to: 6_500,
        segments: [
          { at: 1_000, state: 'working', tool: 'Grep', target: 'SessionView' },
          { at: 3_500, state: 'working', tool: 'Read', target: 'packages/shared/src/protocol.ts' },
        ],
      },
    ],
  },
  {
    id: 'demo-pantry',
    kind: 'observed',
    agent: null,
    cwd: '/home/chef/code/pantry-api',
    repo: 'pantry-api',
    baseTokens: 54_000,
    rate: 1_800,
    segments: [
      { at: 0, state: 'idle' },
      { at: 4_000, state: 'working', tool: 'Bash', target: 'cargo build --release' },
      { at: 6_500, state: 'working', tool: 'Edit', target: 'src/routes/inventory.rs' },
      { at: 9_000, state: 'done' },
      { at: 12_500, state: 'idle' },
    ],
  },
  {
    id: 'demo-sourdough',
    kind: 'observed',
    agent: null,
    cwd: '/home/chef/code/sourdough',
    repo: 'sourdough',
    baseTokens: 910_000,
    rate: 3_100,
    segments: [
      { at: 0, state: 'working', tool: 'Task', target: 'Audit the starter recipes' },
      { at: 6_000, state: 'waiting' },
      { at: 9_000, state: 'working', tool: 'WebSearch', target: 'hydration ratio rye' },
      { at: 11_500, state: 'working', tool: 'Edit', target: 'recipes/rye.md' },
    ],
    commis: [
      {
        id: 'demo-sourdough-a',
        type: 'general-purpose',
        from: 500,
        to: 6_000,
        segments: [{ at: 500, state: 'working', tool: 'Glob', target: 'recipes/**/*.md' }],
      },
      {
        id: 'demo-sourdough-b',
        type: 'Explore',
        from: 1_500,
        to: 5_500,
        segments: [{ at: 1_500, state: 'working', tool: 'Read', target: 'recipes/levain.md' }],
      },
    ],
  },
  {
    id: 'demo-crew-basil',
    kind: 'crew',
    agent: {
      agentId: 'crew-sous-chef',
      role: 'sous-chef',
      persona: { name: 'Basil', hue: 150 },
    },
    cwd: '/home/chef/code/orderup',
    repo: 'orderup',
    baseTokens: 1_240_000,
    rate: 2_000,
    segments: [
      { at: 0, state: 'idle' },
      { at: 2_500, state: 'working', tool: 'Read', target: 'DECISIONS.md' },
      { at: 4_500, state: 'working', tool: 'Edit', target: 'packages/server/src/crew.ts' },
      { at: 7_500, state: 'done' },
      { at: 10_500, state: 'idle' },
    ],
  },
  {
    id: 'demo-notes',
    kind: 'observed',
    agent: null,
    cwd: '/home/chef/notes',
    repo: null,
    arrive: 1_500,
    leave: 13_500,
    baseTokens: 0,
    rate: 1_500,
    segments: [
      { at: 1_500, state: 'working', tool: 'Read', target: 'menu/autumn.md' },
      { at: 5_500, state: 'working', tool: 'Write', target: 'menu/autumn.md' },
      { at: 8_500, state: 'done' },
    ],
  },
];

/** Tokens only move in steps, so a working cook sends a few upserts per second, not one per tick. */
const TOKEN_STEP_MS = 500;

/** Sessions at `t` ms into the loop. `base` is the epoch ms at which this loop started. */
export function demoFrame(t: number, base = 0): SessionView[] {
  const lt = ((t % DEMO_LOOP_MS) + DEMO_LOOP_MS) % DEMO_LOOP_MS;
  const sessions: SessionView[] = [];
  for (const cook of SCRIPT) {
    if (cook.arrive !== undefined && lt < cook.arrive) continue;
    if (cook.leave !== undefined && lt >= cook.leave) continue;
    const seg = segmentAt(cook.segments, lt);
    const worked = Math.floor(workingMs(cook.segments, lt) / TOKEN_STEP_MS) * TOKEN_STEP_MS;
    const total = cook.baseTokens + Math.round((cook.rate * worked) / 1000);
    const subagents: SubagentView[] = (cook.commis ?? [])
      .filter((c) => lt >= c.from && lt < c.to)
      .map((c) => {
        const s = segmentAt(c.segments, lt);
        return {
          subagentId: c.id,
          type: c.type,
          state: s.state,
          activity: activityOf(s, base),
        };
      });
    sessions.push({
      sessionId: cook.id,
      kind: cook.kind,
      agent: cook.agent,
      cwd: cook.cwd,
      repo: cook.repo,
      state: seg.state,
      activity: activityOf(seg, base),
      tokens: {
        input: Math.round(total * 0.3),
        output: Math.round(total * 0.1),
        cacheRead: Math.round(total * 0.55),
        cacheWrite: Math.round(total * 0.05),
      },
      subagents,
      startedAt: base - 42 * 60_000 + (cook.arrive ?? 0),
      updatedAt: base + seg.at,
    });
  }
  return sessions;
}

function segmentAt(segments: readonly Segment[], t: number): Segment {
  let current = segments[0]!;
  for (const s of segments) if (s.at <= t) current = s;
  return current;
}

function workingMs(segments: readonly Segment[], t: number): number {
  let total = 0;
  segments.forEach((s, i) => {
    if (s.state !== 'working' || s.at > t) return;
    const end = Math.min(t, segments[i + 1]?.at ?? Infinity);
    total += end - s.at;
  });
  return total;
}

function activityOf(seg: Segment, base: number): SessionView['activity'] {
  if (!seg.tool || (seg.state !== 'working' && seg.state !== 'waiting')) return null;
  return { tool: seg.tool, target: seg.target ?? null, since: base + seg.at };
}

/** The upserts and removes that turn `prev` into `next`. */
export function diffSessions(
  prev: readonly SessionView[],
  next: readonly SessionView[],
): ServerMessage[] {
  const before = new Map(prev.map((s) => [s.sessionId, JSON.stringify(s)]));
  const out: ServerMessage[] = [];
  const seen = new Set<string>();
  for (const s of next) {
    seen.add(s.sessionId);
    if (before.get(s.sessionId) !== JSON.stringify(s))
      out.push({ type: 'session.upsert', session: s });
  }
  for (const s of prev) {
    if (!seen.has(s.sessionId)) out.push({ type: 'session.remove', sessionId: s.sessionId });
  }
  return out;
}

/** Plays the script as if it came from the server: hello, snapshot, then diffs. */
export class DemoFeed {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prev: SessionView[] = [];

  constructor(
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly tickMs = 200,
  ) {}

  start(): void {
    const start = this.now();
    this.prev = demoFrame(0, start);
    this.onMessage({ type: 'hello', protocol: PROTOCOL_VERSION, serverVersion: 'demo' });
    this.onMessage({ type: 'snapshot', sessions: this.prev });
    this.timer = setInterval(() => {
      const elapsed = this.now() - start;
      const loopStart = start + Math.floor(elapsed / DEMO_LOOP_MS) * DEMO_LOOP_MS;
      const next = demoFrame(elapsed, loopStart);
      for (const msg of diffSessions(this.prev, next)) this.onMessage(msg);
      this.prev = next;
    }, this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function isDemo(search: string): boolean {
  return new URLSearchParams(search).has('demo');
}
