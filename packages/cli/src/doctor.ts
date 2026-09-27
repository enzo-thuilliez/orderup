import { spawn, type SpawnOptions } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PORT, type HealthResponse } from 'orderup-shared';
import { hookOptions } from './hooks.js';
import { versionManagerOf } from './node-path.js';
import { hookStatus, ourHooks, readSettings, withOurHooks } from './settings.js';

export type Level = 'ok' | 'warn' | 'FAIL';

export interface Check {
  name: string;
  level: Level;
  detail: string;
}

export interface DoctorReport {
  checks: Check[];
  /** No check failed. Warnings don't count. */
  ok: boolean;
}

/** Hook event name no Claude Code sends: the server accepts it and changes nothing. */
export const DOCTOR_EVENT = 'OrderUpDoctor';

const REINSTALL = 'Fix: orderup --install-hooks';

export async function fetchHealth(port: number): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    const body = (await res.json()) as Partial<HealthResponse>;
    if (body.ok !== true) return null;
    return { ok: true, protocol: body.protocol ?? 0, lastHookAt: body.lastHookAt ?? null };
  } catch {
    return null;
  }
}

function executable(file: string): boolean {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name: string): string | null {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix);
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

/** Is the Node binary an installed hook runs still there? */
export function nodeCheck(node: string): Check {
  if (!/[\\/]/.test(node)) {
    const found = onPath(node);
    if (!found)
      return { name: 'node', level: 'FAIL', detail: `\`${node}\` is not on PATH. ${REINSTALL}` };
    return {
      name: 'node',
      level: 'warn',
      detail:
        `hooks run \`${node}\` from PATH (${found} here), but Claude Code may run hooks ` +
        `without your shell's PATH. ${REINSTALL} pins an absolute path`,
    };
  }
  if (!executable(node)) {
    return {
      name: 'node',
      level: 'FAIL',
      detail: `${node} doesn't exist: hooks are failing silently. ${REINSTALL}`,
    };
  }
  const manager = versionManagerOf(node);
  return {
    name: 'node',
    level: 'ok',
    detail: manager
      ? `${node} (${manager}: re-run orderup --install-hooks after switching Node versions)`
      : node,
  };
}

interface HookRun {
  code: number | null;
  error?: string;
}

/** Runs an installed hook entry the way Claude Code does, with `payload` on stdin. */
function runHook(hook: Record<string, unknown>, payload: string): Promise<HookRun> {
  return new Promise((resolve) => {
    const command = String(hook.command);
    const options: SpawnOptions = { stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 };
    const child = Array.isArray(hook.args)
      ? spawn(command, hook.args.map(String), options)
      : spawn(command, { ...options, shell: true });
    child.once('error', (err) => resolve({ code: null, error: err.message }));
    child.once('close', (code) => resolve({ code }));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(payload);
  });
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

/**
 * Checks the whole hook chain: the settings entries, the Node they run, the server they post
 * to, recent events, and a live test event sent through the installed command.
 */
export async function runDoctor(options: {
  file: string;
  /** Port to check when no hooks are installed. */
  port: number;
  /** Installed Claude Code version, from detectClaudeVersion(). */
  claude: string | null;
  now?: () => number;
}): Promise<DoctorReport> {
  const { file, claude, now = Date.now } = options;
  const checks: Check[] = [];
  const add = (name: string, level: Level, detail: string) => {
    checks.push({ name, level, detail });
  };
  const done = (): DoctorReport => ({ checks, ok: checks.every((c) => c.level !== 'FAIL') });

  if (claude) add('claude', 'ok', `Claude Code ${claude}`);
  else
    add('claude', 'warn', '`claude` not on PATH: hooks get installed in the most compatible form');

  let settings;
  try {
    settings = (await readSettings(file)).settings;
  } catch (err) {
    add('hooks', 'FAIL', `can't read ${file}: ${(err as Error).message}`);
    return done();
  }
  const status = hookStatus(settings);
  const entries = ourHooks(settings);
  if (!status.installed) {
    add('hooks', 'FAIL', `no OrderUp hooks in ${file}. ${REINSTALL}`);
  } else {
    const first = entries[0]!.hook;
    const form = Array.isArray(first.args) ? 'exec form' : 'shell form';
    const mode = entries.some(({ hook }) => hook.async === true) ? 'background' : 'synchronous';
    if (status.complete)
      add('hooks', 'ok', `${entries.length} events in ${file}, ${form}, ${mode}`);
    else add('hooks', 'warn', `missing for ${status.missing.join(', ')}. ${REINSTALL}`);

    const [port] = status.ports;
    const [node] = status.nodes;
    if (status.ports.length > 1) {
      add(
        'hooks',
        'warn',
        `hooks post to ports ${status.ports.join(', ')}. ${REINSTALL} --port <n>`,
      );
    } else if (status.complete && status.nodes.length === 1 && port !== undefined && node) {
      const expected = withOurHooks(settings, hookOptions(port, claude, node));
      if (JSON.stringify(expected) !== JSON.stringify(settings)) {
        add('hooks', 'warn', `not in the form this Claude Code would get. ${REINSTALL}`);
      }
    }
    for (const node of status.nodes) checks.push(nodeCheck(node));
  }

  const port = status.ports[0] ?? options.port;
  const url = `http://127.0.0.1:${port}`;
  const health = await fetchHealth(port);
  if (!health) {
    const start = port === DEFAULT_PORT ? 'orderup' : `orderup --port ${port}`;
    add('server', 'warn', `OrderUp isn't running at ${url}. Start it with: ${start}`);
    return done();
  }
  add('server', 'ok', `OrderUp is running at ${url}`);

  if (health.lastHookAt === null) {
    add(
      'events',
      'warn',
      'no hook event since OrderUp started. Use any Claude Code session, then re-run',
    );
  } else {
    add('events', 'ok', `last hook event ${ago(now() - health.lastHookAt)} ago`);
  }

  const probe = entries.find(({ event }) => event === 'PreToolUse') ?? entries[0];
  if (!probe) return done();
  const sentAt = now();
  const run = await runHook(
    probe.hook,
    JSON.stringify({ session_id: 'orderup-doctor', hook_event_name: DOCTOR_EVENT }),
  );
  const after = await fetchHealth(port);
  if (after?.lastHookAt != null && after.lastHookAt >= sentAt) {
    add(
      'delivery',
      'ok',
      `a test event sent through the installed hook arrived (${now() - sentAt} ms)`,
    );
  } else {
    const why = run.error ?? `hook exited with code ${run.code}`;
    add('delivery', 'FAIL', `a test event sent through the installed hook never arrived (${why})`);
  }
  return done();
}

export function formatReport({ checks, ok }: DoctorReport): string {
  const lines = checks.map((c) => `  ${c.level.padEnd(5)} ${c.name.padEnd(9)} ${c.detail}`);
  const count = (level: Level) => checks.filter((c) => c.level === level).length;
  const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
  const summary = !ok
    ? `${plural(count('FAIL'), 'problem')} found.`
    : count('warn')
      ? `No problems, ${plural(count('warn'), 'warning')}.`
      : 'All good.';
  return `OrderUp doctor\n\n${lines.join('\n')}\n\n${summary}\n`;
}
