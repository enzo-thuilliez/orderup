import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitRepoName, SessionStore, type StoreChange } from '../src/sessions/store.js';

const MIN = 60_000;

function setup() {
  let now = 0;
  const store = new SessionStore({ now: () => now, repoOf: () => 'repo' });
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

  it('sends done cooks on a coffee break after 5 minutes, then home after 2 hours', () => {
    const { store, changes, setNow } = setup();
    store.apply({ sessionId: 's1', at: 0, type: 'stop' }, 'hook');

    store.tick(4 * MIN);
    expect(store.get('s1')?.state).toBe('done');

    setNow(5 * MIN);
    store.tick(5 * MIN);
    expect(store.get('s1')?.state).toBe('idle');

    store.tick(5 * MIN + 120 * MIN);
    expect(store.get('s1')).toBeUndefined();
    expect(changes.at(-1)).toEqual({ type: 'remove', sessionId: 's1' });
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
