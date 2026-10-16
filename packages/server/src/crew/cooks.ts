import type { SessionStore } from '../sessions/store.js';
import { isSubagentTool } from '../sources/hooks.js';
import type { RunnerEvent } from './runner.js';

/**
 * Turns crew runner events into crew cooks in the session store (#19): the head chef's
 * session, and its stations as subagents with their `station`. The runner's stream is their
 * only source; the store then ignores hook and transcript events for those sessions.
 *
 * A station is keyed by the `Agent` call that started it, like an observed commis. It stays
 * at its station until the run ends: a background station's `Agent` result comes back at
 * once, and it is done only at its `system/task_notification` (probe case a).
 */
export class CrewCooks {
  readonly #runs = new Map<string, { cwd: string; repo: string; sessionId: string | null }>();

  constructor(
    private readonly store: SessionStore,
    private readonly now: () => number = Date.now,
  ) {}

  onRunnerEvent(event: RunnerEvent): void {
    switch (event.type) {
      case 'run.started':
        this.#runs.set(event.runId, { cwd: event.cwd, repo: event.repo, sessionId: null });
        return;
      case 'run.session': {
        const run = this.#runs.get(event.runId);
        if (!run) return;
        run.sessionId = event.sessionId;
        const base = { sessionId: event.sessionId, at: this.now(), cwd: run.cwd, repo: run.repo };
        this.store.apply({ ...base, type: 'crew.claim' }, 'crew');
        this.store.apply({ ...base, type: 'prompt' }, 'crew');
        return;
      }
      case 'run.tool': {
        const sessionId = this.#sessionOf(event.runId);
        if (!sessionId) return;
        const at = this.now();
        if (event.parentToolUseId !== null) {
          this.store.apply(
            {
              sessionId,
              at,
              type: 'subagent.tool',
              subagentId: event.parentToolUseId,
              tool: event.name,
              target: event.target,
            },
            'crew',
          );
          return;
        }
        const isAgent = isSubagentTool(event.name);
        this.store.apply(
          {
            sessionId,
            at,
            type: 'tool.start',
            tool: event.name,
            target: event.target,
            ...(isAgent
              ? { subagent: { id: event.toolUseId, type: event.subagentType ?? null } }
              : {}),
          },
          'crew',
        );
        return;
      }
      case 'run.subagent.ended': {
        const sessionId = this.#sessionOf(event.runId);
        if (!sessionId) return;
        this.store.apply(
          {
            sessionId,
            at: this.now(),
            type: 'subagent.end',
            subagentId: event.toolUseId,
            ok: event.status === 'completed',
          },
          'crew',
        );
        return;
      }
      case 'run.usage': {
        const sessionId = this.#sessionOf(event.runId);
        if (sessionId) {
          this.store.apply(
            { sessionId, at: this.now(), type: 'usage', tokens: event.tokens },
            'crew',
          );
        }
        return;
      }
      case 'run.ended': {
        const sessionId = this.#sessionOf(event.runId);
        this.#runs.delete(event.runId);
        if (sessionId) {
          this.store.apply(
            { sessionId, at: this.now(), type: 'crew.end', status: event.status },
            'crew',
          );
        }
        return;
      }
      default:
        return;
    }
  }

  #sessionOf(runId: string): string | null {
    return this.#runs.get(runId)?.sessionId ?? null;
  }
}
