import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SessionView } from 'orderup-shared';
import { reduce, type SessionEvent } from './machine.js';

export type EventSource = 'hook' | 'transcript';

export type StoreChange =
  { type: 'upsert'; session: SessionView } | { type: 'remove'; sessionId: string };

export interface StoreOptions {
  /** `done` → `idle` (coffee break) after this long without events. */
  idleAfterMs?: number;
  /** `working` → `idle` after this long without events (terminal closed without SessionEnd). */
  staleAfterMs?: number;
  /** Idle sessions are forgotten (cook goes home) after this long. */
  forgetAfterMs?: number;
  repoOf?: (cwd: string) => string | null;
  now?: () => number;
}

const MINUTE = 60_000;

/**
 * Holds live sessions, feeds events through the reducer and tells subscribers what changed.
 *
 * When a session has sent at least one hook event, hooks own its state: transcript events
 * for it only contribute token usage (ADR-001).
 */
export class SessionStore {
  readonly #sessions = new Map<string, SessionView>();
  readonly #hooked = new Set<string>();
  readonly #listeners = new Set<(change: StoreChange) => void>();
  readonly #repoCache = new Map<string, string | null>();
  readonly #idleAfterMs: number;
  readonly #staleAfterMs: number;
  readonly #forgetAfterMs: number;
  readonly #repoOf: (cwd: string) => string | null;
  readonly #now: () => number;

  constructor(options: StoreOptions = {}) {
    this.#idleAfterMs = options.idleAfterMs ?? 5 * MINUTE;
    this.#staleAfterMs = options.staleAfterMs ?? 30 * MINUTE;
    this.#forgetAfterMs = options.forgetAfterMs ?? 120 * MINUTE;
    this.#repoOf = options.repoOf ?? gitRepoName;
    this.#now = options.now ?? Date.now;
  }

  apply(event: SessionEvent, source: EventSource): void {
    if (source === 'hook') {
      this.#hooked.add(event.sessionId);
    } else if (this.#hooked.has(event.sessionId) && event.type !== 'usage') {
      return;
    }
    this.#commit(event);
  }

  /** Runs the timers: coffee breaks, stale sessions, cooks going home. */
  tick(now = this.#now()): void {
    for (const s of [...this.#sessions.values()]) {
      const quiet = now - s.updatedAt;
      if (s.state === 'done' && quiet >= this.#idleAfterMs) {
        this.#commit({ sessionId: s.sessionId, at: now, type: 'idle' });
      } else if (s.state === 'working' && quiet >= this.#staleAfterMs) {
        this.#commit({ sessionId: s.sessionId, at: now, type: 'idle' });
      } else if (s.state === 'idle' && quiet >= this.#forgetAfterMs) {
        this.#commit({ sessionId: s.sessionId, at: now, type: 'end' });
      }
    }
  }

  snapshot(): SessionView[] {
    return [...this.#sessions.values()];
  }

  get(sessionId: string): SessionView | undefined {
    return this.#sessions.get(sessionId);
  }

  subscribe(listener: (change: StoreChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #commit(event: SessionEvent): void {
    const prev = this.#sessions.get(event.sessionId);
    const withRepo =
      event.cwd !== undefined && event.repo === undefined && !prev?.repo
        ? { ...event, repo: this.#cachedRepo(event.cwd) }
        : event;
    const next = reduce(prev, withRepo);

    if (next === null) {
      this.#hooked.delete(event.sessionId);
      if (prev && this.#sessions.delete(event.sessionId)) {
        this.#emit({ type: 'remove', sessionId: event.sessionId });
      }
      return;
    }
    this.#sessions.set(next.sessionId, next);
    if (!prev || !sameView(prev, next)) this.#emit({ type: 'upsert', session: next });
  }

  #cachedRepo(cwd: string): string | null {
    if (!cwd) return null;
    let repo = this.#repoCache.get(cwd);
    if (repo === undefined) {
      repo = this.#repoOf(cwd);
      this.#repoCache.set(cwd, repo);
    }
    return repo;
  }

  #emit(change: StoreChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch {
        // A broken subscriber must not stop the kitchen.
      }
    }
  }
}

/** Ignores `updatedAt` so pure timestamp bumps don't flood the WebSocket. */
function sameView(a: SessionView, b: SessionView): boolean {
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
}

/** Name of the git repository containing `cwd` (worktrees included), or null. */
export function gitRepoName(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return path.basename(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
