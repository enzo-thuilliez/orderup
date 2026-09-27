import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from 'orderup-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatReport, runDoctor, type Check } from '../src/doctor.js';
import { forwarderScript } from '../src/forwarder.js';
import { installHooks, type Io } from '../src/hooks.js';
import { settingsPath } from '../src/settings.js';

/** Every test runs against a throwaway HOME: the real ~/.claude is never touched. */
let home: string;
let server: RunningServer | undefined;
const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orderup-home-')));
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  process.env.HOME = saved.HOME;
  if (saved.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
  rmSync(home, { recursive: true, force: true });
});

const quiet: Io = { out: () => undefined };
const CLAUDE = '2.1.282';

function file(): string {
  const f = settingsPath();
  expect(f.startsWith(home)).toBe(true);
  mkdirSync(path.dirname(f), { recursive: true });
  return f;
}

async function freePort(): Promise<number> {
  const probe = await startServer({ port: 0, projectsDir: false });
  await probe.close();
  return probe.port;
}

const level = (checks: Check[], name: string) =>
  checks.filter((c) => c.name === name).map((c) => c.level);

describe.skipIf(process.platform === 'win32')('orderup --doctor (temporary HOME)', () => {
  it('fails without hooks and says how to fix it', async () => {
    const report = await runDoctor({ file: file(), port: await freePort(), claude: CLAUDE });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'hooks')).toMatchObject({
      level: 'FAIL',
      detail: expect.stringContaining('orderup --install-hooks'),
    });
    expect(level(report.checks, 'server')).toEqual(['warn']);
  });

  it('checks the whole chain, including a live event through the installed hook', async () => {
    server = await startServer({ port: 0, projectsDir: false });
    const f = file();
    await installHooks({ file: f, port: server.port, claude: CLAUDE, io: quiet });

    const first = await runDoctor({ file: f, port: server.port, claude: CLAUDE });
    expect(first.checks.map((c) => [c.name, c.level])).toEqual([
      ['claude', 'ok'],
      ['hooks', 'ok'],
      ['node', 'ok'],
      ['server', 'ok'],
      ['events', 'warn'],
      ['delivery', 'ok'],
    ]);
    expect(first.ok).toBe(true);
    // The doctor's own test event is ignored by the kitchen.
    expect(server.store.snapshot()).toEqual([]);

    const second = await runDoctor({ file: f, port: server.port, claude: CLAUDE });
    expect(second.checks.find((c) => c.name === 'events')?.detail).toMatch(
      /^last hook event \d+ s ago$/,
    );
  });

  it('fails when the node the hooks run is gone', async () => {
    const f = file();
    const gone = path.join(home, '.nvm/versions/node/v20.0.0/bin/node');
    await installHooks({ file: f, port: await freePort(), claude: CLAUDE, node: gone, io: quiet });
    const report = await runDoctor({ file: f, port: 7717, claude: CLAUDE });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'node')?.detail).toContain(`${gone} doesn't exist`);
  });

  it('flags a hook that runs but delivers nothing', async () => {
    server = await startServer({ port: 0, projectsDir: false });
    const f = file();
    await installHooks({
      file: f,
      port: server.port,
      claude: CLAUDE,
      node: '/bin/true',
      io: quiet,
    });
    const report = await runDoctor({ file: f, port: server.port, claude: CLAUDE });
    expect(level(report.checks, 'delivery')).toEqual(['FAIL']);
    expect(report.ok).toBe(false);
  });

  it('warns about hooks that rely on PATH or an older format', async () => {
    const f = file();
    const port = await freePort();
    writeFileSync(
      f,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: `node -e '${forwarderScript(port)}'` }] }],
        },
      }),
    );
    const bare = await runDoctor({ file: f, port, claude: CLAUDE });
    expect(bare.checks.find((c) => c.name === 'node')?.level).toMatch(/warn|FAIL/);

    await installHooks({ file: f, port, claude: null, io: quiet });
    const old = await runDoctor({ file: f, port, claude: CLAUDE });
    expect(old.checks.find((c) => c.name === 'hooks' && c.level === 'warn')?.detail).toContain(
      'orderup --install-hooks',
    );
  });

  it('prints a plain-text report', async () => {
    const report = await runDoctor({ file: file(), port: await freePort(), claude: null });
    const text = formatReport(report);
    expect(text).toMatch(/^OrderUp doctor\n\n {2}warn {2}claude {4}/);
    expect(text).toMatch(/ {2}FAIL {2}hooks {5}no OrderUp hooks/);
    expect(text).toMatch(/1 problem found\.\n$/);
    expect(text).not.toContain('\x1b[');
  });
});
