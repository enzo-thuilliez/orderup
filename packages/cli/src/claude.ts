import { execFile } from 'node:child_process';
import { compareVersions } from './hooks.js';

/**
 * Subprocesses crew setup needs: the user's `claude` CLI and `git`. Each one is read-only, has
 * a short timeout, and never sends a prompt: no LLM call happens here (AGENTS.md).
 */

/**
 * First Claude Code release crew supports: the first with
 * `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (ADR-016 Follow-ups, #21). `agent_id` / `agent_type`
 * on hooks (2.1.69), `isolation: worktree` (2.1.50) and `SubagentStop` fields (2.0.42) are
 * all older.
 */
export const CREW_MIN_CLAUDE_VERSION = '2.1.217';

export function supportsCrew(version: string | null): boolean {
  return version !== null && compareVersions(version, CREW_MIN_CLAUDE_VERSION) >= 0;
}

/**
 * - `loggedIn` true / false: `claude auth status` exited 0 / 1, as documented.
 * - `loggedIn` null: unknown (no answer, another exit code, or not run).
 */
export interface AuthStatus {
  loggedIn: boolean | null;
  /** `authMethod` from the JSON output (e.g. `claude.ai`, `api_key`), when given. */
  method?: string;
}

/**
 * Asks `claude auth status`, the documented non-interactive check (CLI reference: "Exits with
 * code 0 if logged in, 1 if not"). Only the `authMethod` field is read from its output; no
 * account detail or credential is kept.
 */
export function claudeAuthStatus(): Promise<AuthStatus> {
  return new Promise((resolve) => {
    const child = execFile(
      'claude',
      ['auth', 'status'],
      { timeout: 5000, windowsHide: true, shell: process.platform === 'win32' },
      (err, stdout) => {
        const code: unknown = err ? (err as { code?: unknown }).code : 0;
        if (code !== 0 && code !== 1) return resolve({ loggedIn: null });
        let method: string | undefined;
        try {
          const parsed = JSON.parse(stdout) as { authMethod?: unknown };
          if (typeof parsed.authMethod === 'string') method = parsed.authMethod;
        } catch {
          // Not JSON: the exit code alone answers.
        }
        resolve(method ? { loggedIn: code === 0, method } : { loggedIn: code === 0 });
      },
    );
    child.stdin?.end();
  });
}

/** Top level of the git work tree containing `dir`, or null if it isn't in one. */
export function gitToplevel(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: dir, timeout: 3000, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
}
