import { spawn } from 'node:child_process';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { startServer, type RunningServer } from 'orderup-server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FORWARDER_BUDGET_MS,
  forwarderHook,
  forwarderNode,
  forwarderPort,
  forwarderScript,
  shellQuote,
  type HookCommand,
} from '../src/forwarder.js';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/**
 * Runs a hook the way Claude Code does (exec form directly, shell form through `sh -c`),
 * with an empty PATH: the absolute node path must be enough, as under nvm.
 */
function runHook(hook: HookCommand, payload: string): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: '' };
    const child = hook.args
      ? spawn(hook.command, hook.args, { stdio: 'pipe', env })
      : spawn('/bin/sh', ['-c', hook.command], { stdio: 'pipe', env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(payload);
  });
}

const payload = JSON.stringify({
  session_id: 'fwd-1',
  hook_event_name: 'PreToolUse',
  cwd: '/code/app',
  tool_name: 'Bash',
  tool_input: { command: 'echo \'quotes\' "and" $HOME `ticks`' },
});

describe.skipIf(process.platform === 'win32').each([
  { form: 'exec form', execForm: true },
  { form: 'shell form', execForm: false },
])('hook forwarder ($form)', ({ execForm }) => {
  const hook = (port: number) => forwarderHook({ port, node: process.execPath, execForm });
  let server: RunningServer | undefined;
  let blackHole: Server | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
    blackHole?.close();
    blackHole = undefined;
  });

  it('delivers the payload to a running OrderUp, silently, without PATH', async () => {
    server = await startServer({ port: 0, projectsDir: false });
    const run = await runHook(hook(server.port), payload);
    expect(run).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(server.store.get('fwd-1')).toMatchObject({
      state: 'working',
      activity: { tool: 'Bash', target: 'echo \'quotes\' "and" $HOME `ticks`' },
    });
  });

  it('exits 0 quickly and silently when OrderUp is not running', async () => {
    const probe = await startServer({ port: 0, projectsDir: false });
    const port = probe.port;
    await probe.close();
    const run = await runHook(hook(port), payload);
    expect(run).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(run.ms).toBeLessThan(1000);
  });

  it('gives up within its budget when the port never answers', async () => {
    const hole = createServer(() => undefined);
    blackHole = hole;
    await new Promise<void>((resolve) => hole.listen(0, '127.0.0.1', resolve));
    const run = await runHook(hook((hole.address() as AddressInfo).port), payload);
    expect(run).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(run.ms).toBeLessThan(FORWARDER_BUDGET_MS + 1000);
  }, 10_000);
});

describe('forwarder entries', () => {
  it('reads back the port and node of both forms', () => {
    for (const node of ['/usr/bin/node', "/Users/Jo O'Brien/.nvm/versions/node/v22/bin/node"]) {
      for (const execForm of [true, false]) {
        const hook = forwarderHook({ port: 8123, node, execForm });
        expect(forwarderPort(hook)).toBe(8123);
        expect(forwarderNode(hook)).toBe(node);
      }
    }
    expect(forwarderNode({ command: `node -e '${forwarderScript(7717)}'` })).toBe('node');
    expect(forwarderNode({ command: 'say done' })).toBeNull();
  });

  it('needs no quoting inside its single-quoted script', () => {
    expect(forwarderScript(7717)).not.toMatch(/['"]/);
  });

  it('quotes only what needs it', () => {
    expect(shellQuote('/usr/local/bin/node')).toBe('/usr/local/bin/node');
    expect(shellQuote('C:\\Program Files\\nodejs\\node.exe')).toBe(
      "'C:\\Program Files\\nodejs\\node.exe'",
    );
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
