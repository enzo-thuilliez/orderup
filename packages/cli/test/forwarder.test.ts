import { spawn } from 'node:child_process';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { startServer, type RunningServer } from 'orderup-server';
import { afterEach, describe, expect, it } from 'vitest';
import { FORWARDER_BUDGET_MS, forwarderCommand, forwarderPort } from '../src/forwarder.js';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs the hook command through a shell, as Claude Code does, with `payload` on stdin. */
function runHook(port: number, payload: string): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', forwarderCommand(port)], { stdio: 'pipe' });
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

describe.skipIf(process.platform === 'win32')('hook forwarder', () => {
  let server: RunningServer | undefined;
  let blackHole: Server | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
    blackHole?.close();
    blackHole = undefined;
  });

  it('delivers the payload to a running OrderUp, silently', async () => {
    server = await startServer({ port: 0, projectsDir: false });
    const run = await runHook(server.port, payload);
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
    const run = await runHook(port, payload);
    expect(run).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(run.ms).toBeLessThan(1000);
  });

  it('gives up within its budget when the port never answers', async () => {
    const hole = createServer(() => undefined);
    blackHole = hole;
    await new Promise<void>((resolve) => hole.listen(0, '127.0.0.1', resolve));
    const run = await runHook((hole.address() as AddressInfo).port, payload);
    expect(run).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(run.ms).toBeLessThan(FORWARDER_BUDGET_MS + 1000);
  }, 10_000);

  it('records its port and needs no quoting beyond one pair of single quotes', () => {
    expect(forwarderPort(forwarderCommand(8123))).toBe(8123);
    const script = forwarderCommand(7717).slice("node -e '".length, -1);
    expect(script).not.toMatch(/['"]/);
  });
});
