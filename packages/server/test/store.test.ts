import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gitRepoName,
  isUnderTmpdir,
  LEAVE_AFTER_MS,
  SessionStore,
  type StoreChange,
} from '../src/sessions/store.js';
import { TranscriptTail } from '../src/sources/transcripts.js';

const MIN = 60_000;

function setup() {
  let now = 0;
  const store = new SessionStore({
    now: () => now,
    repoOf: () => 'repo',
    ignoreCwd: (cwd) => cwd.startsWith('/tmp/'),
  });
  const changes: StoreChange[] = [];
  store.subscribe((c) => changes.push(c));
  return { store, changes, setNow: (t: number) => (now = t) };
}

describe('SessionStore', () => {
  it('emits upserts and resolves the repo from cwd', () => {
    const { store, changes } = setup();
    store.apply({ sessionId: 's1', at: 0, cwd: '/code/app', type: 'prompt' }, 'hook');
    expect(changes).toEqual([
      { type: 'upsert', session: expect.objectContaining({ state: 'working', repo: 'repo' }) },
    ]);
  });

  it('does not emit when nothing but updatedAt changed', () => {
    const { store, changes } = setup();
    store.apply({ sessionId: 's1', at: 0, type: 'prompt' }, 'hook');
    store.apply({ sessionId: 's1', at: 5, type: 'tool.end' }, 'hook');
    expect(changes).toHaveLength(1);
  });

  it('lets hooks own state once seen; transcripts still update tokens', () => {
    const { store } = setup();
    store.apply({ sessionId: 's1', at: 0, type: 'prompt' }, 'hook');
    store.apply({ sessionId: 's1', at: 1, type: 'stop' }, 'transcript');
    expect(store.get('s1')?.state).toBe('working');

    const tokens = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    store.apply({ sessionId: 's1', at: 2, type: 'usage', tokens }, 'transcript');
    expect(store.get('s1')?.tokens).toEqual(tokens);
  });

  it('uses transcript state for sessions without hooks', () => {
    const { store } = setup();
    store.apply({ sessionId: 's1', at: 0, type: 'prompt' }, 'transcript');
    store.apply({ sessionId: 's1', at: 1, type: 'stop' }, 'transcript');
    expect(store.get('s1')?.state).toBe('done');
  });

  it('sends done cooks on a coffee break after 5 minutes, then out after 10 more', () => {
    const { store, changes, setNow } = setup();
    store.apply({ sessionId: 's1', at: 0, type: 'stop' }, 'hook');

    store.tick(4 * MIN);
    expect(store.get('s1')?.state).toBe('done');

    setNow(5 * MIN);
    store.tick(5 * MIN);
    expect(store.get('s1')?.state).toBe('idle');

    store.tick(5 * MIN + LEAVE_AFTER_MS - 1);
    expect(store.get('s1')?.state).toBe('idle');

    store.tick(5 * MIN + LEAVE_AFTER_MS);
    expect(store.get('s1')).toBeUndefined();
    expect(changes.at(-1)).toEqual({ type: 'remove', sessionId: 's1' });
  });

  it('lets an idle cook walk out after 10 minutes and brings them back on a new event', () => {
    const { store, changes, setNow } = setup();
    store.apply({ sessionId: 's1', at: 0, type: 'session.start' }, 'hook');
    expect(store.get('s1')?.state).toBe('idle');

    store.tick(LEAVE_AFTER_MS);
    expect(store.get('s1')).toBeUndefined();
    expect(changes.at(-1)).toEqual({ type: 'remove', sessionId: 's1' });

    setNow(LEAVE_AFTER_MS + MIN);
    store.apply({ sessionId: 's1', at: LEAVE_AFTER_MS + MIN, type: 'prompt' }, 'hook');
    expect(store.get('s1')?.state).toBe('working');
    expect(changes.at(-1)).toMatchObject({ type: 'upsert', session: { sessionId: 's1' } });
  });

  it('runs every overdue timer at once when ticks were missed', () => {
    const { store } = setup();
    store.apply({ sessionId: 's1', at: 0, type: 'prompt' }, 'hook');
    // working → idle at 30 min, then out at 40 min.
    store.tick(40 * MIN - 1);
    expect(store.get('s1')?.state).toBe('idle');
    store.tick(40 * MIN);
    expect(store.get('s1')).toBeUndefined();
  });

  it('never stores or broadcasts a session whose timers ran out before it arrived', () => {
    const { store, changes, setNow } = setup();
    setNow(60 * MIN);
    store.apply({ sessionId: 'old', at: 0, type: 'prompt' }, 'transcript');
    store.apply({ sessionId: 'old', at: 10 * MIN, type: 'stop' }, 'transcript');
    expect(store.get('old')).toBeUndefined();
    expect(changes).toEqual([]);
  });

  it('broadcasts only the net change of a batch', () => {
    const { store, changes, setNow } = setup();
    setNow(20 * MIN);
    store.applyAll(
      [
        { sessionId: 'gone', at: 0, type: 'prompt' },
        { sessionId: 'gone', at: 1 * MIN, type: 'stop' },
        { sessionId: 'kept', at: 19 * MIN, type: 'prompt' },
        { sessionId: 'kept', at: 19 * MIN, type: 'tool.end' },
      ],
      'transcript',
    );
    expect(store.get('gone')).toBeUndefined();
    expect(changes).toEqual([
      { type: 'upsert', session: expect.objectContaining({ sessionId: 'kept', state: 'working' }) },
    ]);
  });

  it('ignores sessions whose cwd is a throwaway dir, whichever event brings the cwd', () => {
    const { store, changes } = setup();
    store.apply({ sessionId: 't', at: 0, cwd: '/tmp/scratch', type: 'prompt' }, 'hook');
    expect(store.get('t')).toBeUndefined();

    store.apply({ sessionId: 'late', at: 0, type: 'prompt' }, 'hook');
    store.apply({ sessionId: 'late', at: 1, cwd: '/tmp/x', type: 'tool.end' }, 'hook');
    expect(store.get('late')).toBeUndefined();
    expect(changes.map((c) => c.type)).toEqual(['upsert', 'remove']);
  });

  it('turns stale working sessions idle after 30 minutes but leaves waiting ones', () => {
    const { store } = setup();
    store.apply({ sessionId: 'w', at: 0, type: 'prompt' }, 'hook');
    store.apply({ sessionId: 'b', at: 0, type: 'waiting' }, 'hook');
    store.tick(30 * MIN);
    expect(store.get('w')?.state).toBe('idle');
    expect(store.get('b')?.state).toBe('waiting');
  });

  it('removes a session on end and forgets that hooks owned it', () => {
    const { store, changes } = setup();
    store.apply({ sessionId: 's1', at: 0, type: 'prompt' }, 'hook');
    store.apply({ sessionId: 's1', at: 1, type: 'end' }, 'hook');
    expect(changes.at(-1)).toEqual({ type: 'remove', sessionId: 's1' });

    store.apply({ sessionId: 's1', at: 2, type: 'prompt' }, 'transcript');
    expect(store.get('s1')?.state).toBe('working');
  });

  it('keeps going when a subscriber throws', () => {
    const { store } = setup();
    store.subscribe(() => {
      throw new Error('boom');
    });
    expect(() => store.apply({ sessionId: 's1', at: 0, type: 'prompt' }, 'hook')).not.toThrow();
  });
});

describe('stale transcripts at startup', () => {
  let tail: TranscriptTail | undefined;
  afterEach(() => tail?.stop());

  it('does not broadcast 10 stale sessions, only the live one', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orderup-stale-'));
    mkdirSync(path.join(dir, 'p'));
    const now = Date.now();
    const line = (sessionId: string, minutesAgo: number, entry: object) =>
      JSON.stringify({
        sessionId,
        cwd: `/code/${sessionId}`,
        timestamp: new Date(now - minutesAgo * MIN).toISOString(),
        ...entry,
      });
    const prompt = { type: 'user', message: { content: 'hi' } };
    const endTurn = (id: string) => ({
      type: 'assistant',
      message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
    });
    const write = (sessionId: string, lines: string[]) =>
      writeFileSync(path.join(dir, 'p', `${sessionId}.jsonl`), lines.join('\n') + '\n');

    // Files touched within the hour, so the tail reads them all at startup.
    for (let i = 0; i < 5; i++) {
      // Finished 16+ minutes ago: coffee break at 5 min, out 10 min later.
      write(`done-${i}`, [
        line(`done-${i}`, 20 + i, prompt),
        line(`done-${i}`, 16 + i, endTurn('m')),
      ]);
      // Mid-turn 41+ minutes ago: stale at 30 min, out 10 min later.
      write(`gone-${i}`, [line(`gone-${i}`, 41 + i, prompt)]);
    }
    write('live', [line('live', 1, prompt)]);

    const store = new SessionStore({ repoOf: () => null });
    const seen = new Set<string>();
    store.subscribe((c) => seen.add(c.type === 'upsert' ? c.session.sessionId : c.sessionId));
    tail = new TranscriptTail({
      projectsDir: dir,
      onEvents: (e) => store.applyAll(e, 'transcript'),
    });
    await tail.start();

    expect([...seen]).toEqual(['live']);
    expect(store.snapshot().map((s) => s.sessionId)).toEqual(['live']);
  });
});

describe('isUnderTmpdir', () => {
  it('matches the temp dir and below, and nothing else', () => {
    const tmp = os.tmpdir();
    expect(isUnderTmpdir(tmp)).toBe(true);
    expect(isUnderTmpdir(path.join(tmp, 'repo', 'src'))).toBe(true);
    expect(isUnderTmpdir(`${tmp}-other`)).toBe(false);
    expect(isUnderTmpdir('/code/app')).toBe(false);
  });
});

describe('gitRepoName', () => {
  it('finds the repository root above cwd', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orderup-repo-'));
    const repo = path.join(root, 'kitchen');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
    expect(gitRepoName(path.join(repo, 'src', 'deep'))).toBe('kitchen');
  });

  it('returns null outside a repository', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orderup-norepo-'));
    expect(gitRepoName(dir)).toBeNull();
  });
});
