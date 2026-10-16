import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionView } from 'orderup-shared';
import { reduce, type SessionEvent } from './machine.js';

export type EventSource = 'hook' | 'transcript' | 'crew';

export type StoreChange =
  { type: 'upsert'; session: SessionView } | { type: 'remove'; sessionId: string };

export interface StoreOptions {
  /** `done` → `idle` (coffee break) after this long without events. */
  idleAfterMs?: number;
  /** `working` → `idle` after this long without events (terminal closed without SessionEnd). */
  staleAfterMs?: number;
  /** Idle sessions walk out and are dropped after this long. Default: {@link LEAVE_AFTER_MS}. */
  leaveAfterMs?: number;
  /**
   * Sessions in a matching cwd are never shown. Default: anything under `os.tmpdir()`. Crew
   * sessions are always shown: the runner chose their cwd.
   */
  ignoreCwd?: (cwd: string) => boolean;
  repoOf?: (cwd: string) => string | null;
  now?: () => number;
}

const MINUTE = 60_000;

/** An observed cook idle for this long walks out. A new event brings them back. */
export const LEAVE_AFTER_MS = 10 * MINUTE;

/**
 * Holds live sessions, feeds events through the reducer and tells subscribers what changed.
 *
 * When a session has sent at least one hook event, hooks own its state: transcript events
 * for it only contribute token usage (ADR-001).
 *
 * A session the crew runner claims (`crew` source) is a crew cook: from then on only the
 * runner's stream drives it, and hook and transcript events for it are dropped. The chef
 * runs the user's own CLI, so their hooks fire for it too, and its stations' hook events
 * carry the chef's session id. While its run is active (`crew.claim` to `crew.end`) no timer
 * applies to it: a chef waiting on a quiet background station never goes stale or walks out.
 */
export class SessionStore {
  readonly #sessions = new Map<string, SessionView>();
  readonly #hooked = new Set<string>();
  /** Sessions claimed by the crew runner. */
  readonly #crew = new Set<string>();
  /** Crew sessions whose run is still active: no timers. */
  readonly #crewRunning = new Set<string>();
  readonly #listeners = new Set<(change: StoreChange) => void>();
  /** During `applyAll`: each touched session as it was before the batch. */
  #batch: Map<string, SessionView | undefined> | null = null;
  readonly #repoCache = new Map<string, string | null>();
  readonly #idleAfterMs: number;
  readonly #staleAfterMs: number;
  readonly #leaveAfterMs: number;
  readonly #ignoreCwd: (cwd: string) => boolean;
  readonly #repoOf: (cwd: string) => string | null;
  readonly #now: () => number;

  constructor(options: StoreOptions = {}) {
    this.#idleAfterMs = options.idleAfterMs ?? 5 * MINUTE;
    this.#staleAfterMs = options.staleAfterMs ?? 30 * MINUTE;
    this.#leaveAfterMs = options.leaveAfterMs ?? LEAVE_AFTER_MS;
    this.#ignoreCwd = options.ignoreCwd ?? isUnderTmpdir;
    this.#repoOf = options.repoOf ?? gitRepoName;
    this.#now = options.now ?? Date.now;
  }

  apply(event: SessionEvent, source: EventSource): void {
    this.applyAll([event], source);
  }

  /** Applies events in order, then tells subscribers only the net change per session. */
  applyAll(events: SessionEvent[], source: EventSource): void {
    const batch = new Map<string, SessionView | undefined>();
    this.#batch = batch;
    try {
      for (const event of events) this.#applyOne(event, source);
    } finally {
      this.#batch = null;
      for (const [sessionId, before] of batch) {
        this.#notify(sessionId, before, this.#sessions.get(sessionId));
      }
    }
  }

  #applyOne(event: SessionEvent, source: EventSource): void {
    if (source === 'crew') {
      this.#crew.add(event.sessionId);
      if (event.type === 'crew.claim') this.#crewRunning.add(event.sessionId);
      else if (event.type === 'crew.end') this.#crewRunning.delete(event.sessionId);
    } else if (this.#crew.has(event.sessionId)) {
      return;
    } else if (source === 'hook') {
      this.#hooked.add(event.sessionId);
    } else if (this.#hooked.has(event.sessionId) && event.type !== 'usage') {
      return;
    }
    this.#commit(event);
  }

  /** Runs the timers: coffee breaks, stale sessions, cooks walking out. */
  tick(now = this.#now()): void {
    for (const s of [...this.#sessions.values()]) {
      this.#store(s.sessionId, s, this.#settle(s, now));
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
    const cwd = prev?.cwd || event.cwd;
    if (cwd && !this.#crew.has(event.sessionId) && this.#ignoreCwd(cwd)) {
      // Throwaway repo under the temp dir: never shown.
      this.#store(event.sessionId, prev, null);
      return;
    }
    const withRepo =
      event.cwd !== undefined && event.repo === undefined && !prev?.repo
        ? { ...event, repo: this.#cachedRepo(event.cwd) }
        : event;
    const next = reduce(prev, withRepo);
    // Timers already due (a transcript replayed at startup) run before anyone sees the session,
    // so a long-gone cook is never broadcast.
    this.#store(event.sessionId, prev, next && this.#settle(next, this.#now()));
  }

  #store(sessionId: string, prev: SessionView | undefined, next: SessionView | null): void {
    if (next === null) {
      this.#hooked.delete(sessionId);
      this.#crew.delete(sessionId);
      this.#crewRunning.delete(sessionId);
      this.#sessions.delete(sessionId);
    } else {
      this.#sessions.set(sessionId, next);
    }
    if (!this.#batch) this.#notify(sessionId, prev, next ?? undefined);
    else if (!this.#batch.has(sessionId)) this.#batch.set(sessionId, prev);
  }

  #notify(sessionId: string, prev: SessionView | undefined, next: SessionView | undefined): void {
    if (!next) {
      if (prev) this.#emit({ type: 'remove', sessionId });
    } else if (!prev || !sameView(prev, next)) {
      this.#emit({ type: 'upsert', session: next });
    }
  }

  /** Applies every timer due by `now`, each at the time it fell due. */
  #settle(session: SessionView, now: number): SessionView | null {
    let s: SessionView | null = session;
    for (let timer = this.#timer(s); s && timer && timer.at <= now; timer = s && this.#timer(s)) {
      s = reduce(s, { sessionId: s.sessionId, at: timer.at, type: timer.type });
    }
    return s;
  }

  /**
   * The next timer for a session, or null when it never times out (`waiting`, or a crew
   * session whose run is active).
   */
  #timer(s: SessionView): { type: 'idle' | 'end'; at: number } | null {
    if (this.#crewRunning.has(s.sessionId)) return null;
    switch (s.state) {
      case 'done':
        return { type: 'idle', at: s.updatedAt + this.#idleAfterMs };
      case 'working':
        return { type: 'idle', at: s.updatedAt + this.#staleAfterMs };
      case 'idle':
        return { type: 'end', at: s.updatedAt + this.#leaveAfterMs };
      case 'waiting':
        return null;
    }
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

const TMP_DIRS = tmpDirs();

/** Whether `cwd` is under the OS temp dir, symlinks resolved (macOS `/var` → `/private/var`). */
export function isUnderTmpdir(cwd: string): boolean {
  const dir = path.resolve(cwd);
  return TMP_DIRS.some((tmp) => dir === tmp || dir.startsWith(tmp + path.sep));
}

function tmpDirs(): string[] {
  const tmp = path.resolve(os.tmpdir());
  let real = tmp;
  try {
    real = realpathSync(tmp);
  } catch {
    // Keep the unresolved path.
  }
  return [...new Set([tmp, real])];
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
