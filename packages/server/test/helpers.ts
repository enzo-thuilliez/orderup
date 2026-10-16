import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage } from 'orderup-shared';
import { WebSocket } from 'ws';

export interface RawResponse {
  status: number;
  body: string;
}

/** Plain node:http request, so tests can set Host and Origin freely. */
export function rawRequest(
  port: number,
  {
    method = 'GET',
    path = '/',
    headers = {},
    body,
  }: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

export function postHook(port: number, payload: unknown): Promise<RawResponse> {
  return rawRequest(port, {
    method: 'POST',
    path: '/hook',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function waitFor<T>(check: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Opens a kitchen socket and records every server message. */
export async function connect(
  port: number,
  origin = `http://127.0.0.1:${port}`,
): Promise<{ ws: WebSocket; messages: ServerMessage[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  const messages: ServerMessage[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages };
}

/** The fake `claude` CLI the crew tests spawn (fixtures/fake-claude.js). */
export const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));

/** What the fake writes to `$FAKE_CLAUDE_LOG/<pid>.json` for each run. */
export interface FakeLog {
  args: string[];
  cwd: string;
  env: Record<string, string | null>;
  pid: number;
  prompt: string;
  grandchild: number | null;
}

export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = GIT_ENV): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}

export function tmp(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A repo with one commit on `main`, pushed to a bare `origin` whose HEAD is `main`. */
export function tempRepo(): { repo: string; origin: string } {
  const origin = path.join(tmp('orderup-origin-'), 'origin.git');
  git(os.tmpdir(), ['init', '--bare', '-b', 'main', origin]);
  const repo = path.join(tmp('orderup-repo-'), 'kitchen');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['commit', '--allow-empty', '-m', 'init']);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-q', 'origin', 'main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);
  return { repo, origin };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
