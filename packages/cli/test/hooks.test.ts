import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareVersions,
  hookOptions,
  installHooks,
  uninstallHooks,
  type Io,
} from '../src/hooks.js';
import { versionManagerOf } from '../src/node-path.js';
import { BACKUP_SUFFIX, hookStatus, settingsPath } from '../src/settings.js';

/** Every test runs against a throwaway HOME: the real ~/.claude is never touched. */
let home: string;
const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orderup-home-')));
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  if (saved.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
  rmSync(home, { recursive: true, force: true });
});

function fakeIo(answer?: boolean): Io & { output: () => string; asked: string[] } {
  let output = '';
  const asked: string[] = [];
  return {
    out: (text) => void (output += text),
    confirm:
      answer === undefined
        ? undefined
        : (question) => {
            asked.push(question);
            return Promise.resolve(answer);
          },
    output: () => output,
    asked,
  };
}

const original = `{
    "model": "opus",
    "hooks": {
        "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }]
    }
}
`;

/** `settings.json` inside the temporary HOME, holding `original` unless `content` is null. */
function settingsFile(content: string | null = original): string {
  const file = settingsPath();
  expect(file.startsWith(home)).toBe(true);
  mkdirSync(path.dirname(file), { recursive: true });
  if (content !== null) writeFileSync(file, content);
  return file;
}

describe('hook installer (temporary HOME)', () => {
  it('resolves settings.json inside HOME, or CLAUDE_CONFIG_DIR when set', () => {
    expect(settingsPath()).toBe(path.join(home, '.claude', 'settings.json'));
    process.env.CLAUDE_CONFIG_DIR = path.join(home, 'alt');
    expect(settingsPath()).toBe(path.join(home, 'alt', 'settings.json'));
  });

  it('shows a diff, asks, backs up, then merges', async () => {
    const file = settingsFile();
    const io = fakeIo(true);

    expect(await installHooks({ file, port: 7717, claude: '2.1.282', io })).toBe('installed');

    expect(io.asked).toHaveLength(1);
    expect(io.output()).toMatch(/^\+ .*orderup-hook/m);
    expect(readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8')).toBe(original);
    const text = readFileSync(file, 'utf8');
    const written = JSON.parse(text) as Record<string, unknown>;
    expect(written.model).toBe('opus');
    expect(hookStatus(written)).toEqual({
      installed: true,
      complete: true,
      missing: [],
      ports: [7717],
      nodes: [process.execPath],
    });
    expect(text).toMatch(/^ {4}"model"/m);
  });

  it('writes nothing when the user declines', async () => {
    const file = settingsFile();
    const result = await installHooks({ file, port: 7717, claude: '2.1.282', io: fakeIo(false) });
    expect(result).toBe('cancelled');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(existsSync(`${file}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it('does not ask or write when the hooks are already there', async () => {
    const file = settingsFile();
    await installHooks({ file, port: 7717, claude: '2.1.282', io: fakeIo(true) });
    const after = readFileSync(file, 'utf8');
    const io = fakeIo(true);
    expect(await installHooks({ file, port: 7717, claude: '2.1.282', io })).toBe('unchanged');
    expect(io.asked).toHaveLength(0);
    expect(readFileSync(file, 'utf8')).toBe(after);
  });

  it('creates settings.json when missing, without a backup', async () => {
    const file = settingsFile(null);
    expect(await installHooks({ file, port: 7717, claude: null, io: fakeIo() })).toBe('installed');
    expect(hookStatus(JSON.parse(readFileSync(file, 'utf8'))).complete).toBe(true);
    expect(existsSync(`${file}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it('uninstall removes only OrderUp hooks', async () => {
    const file = settingsFile();
    await installHooks({ file, port: 7717, claude: '2.1.282', io: fakeIo(true) });
    const io = fakeIo(true);

    expect(await uninstallHooks({ file, io })).toBe('removed');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(original));
    expect(io.output()).toMatch(/^- .*orderup-hook/m);
    expect(await uninstallHooks({ file, io: fakeIo(true) })).toBe('none');
  });

  it('refuses to touch a settings.json that is not valid JSON', async () => {
    const file = settingsFile('{ "model": ');
    await expect(
      installHooks({ file, port: 7717, claude: '2.1.282', io: fakeIo(true) }),
    ).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{ "model": ');
  });

  it.skipIf(process.platform === 'win32')('writes through a symlinked settings.json', async () => {
    const real = path.join(home, 'dotfiles', 'claude-settings.json');
    mkdirSync(path.dirname(real), { recursive: true });
    writeFileSync(real, original);
    const file = settingsFile(null);
    symlinkSync(real, file);

    await installHooks({ file, port: 7717, claude: '2.1.282', io: fakeIo(true) });

    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(hookStatus(JSON.parse(readFileSync(real, 'utf8'))).installed).toBe(true);
  });
});

describe('Claude Code version gate', () => {
  it('uses background and exec-form hooks only on versions known to support them', () => {
    expect(compareVersions('2.1.282', '2.1.119')).toBe(1);
    expect(compareVersions('2.1.9', '2.1.119')).toBe(-1);
    const node = '/usr/bin/node';
    expect(hookOptions(7717, '2.1.282', node)).toEqual({
      port: 7717,
      node,
      async: true,
      execForm: true,
    });
    expect(hookOptions(7717, '2.1.119', node)).toMatchObject({ async: true, execForm: false });
    expect(hookOptions(7717, '2.1.75', node)).toMatchObject({ async: false, execForm: false });
    expect(hookOptions(7717, null, node)).toMatchObject({ async: false, execForm: false });
  });
});

describe('node path (temporary HOME)', () => {
  it('pins the node running OrderUp by default', async () => {
    const file = settingsFile();
    await installHooks({ file, port: 7717, claude: '2.1.282', io: fakeIo(true) });
    expect(hookStatus(JSON.parse(readFileSync(file, 'utf8'))).nodes).toEqual([process.execPath]);
  });

  it('warns when that node belongs to a version manager, and reinstall updates it', async () => {
    const file = settingsFile();
    const nvm = path.join(home, '.nvm/versions/node/v22.13.0/bin/node');
    const io = fakeIo(true);
    await installHooks({ file, port: 7717, claude: '2.1.282', node: nvm, io });
    expect(io.output()).toMatch(/managed by nvm.*orderup --install-hooks/s);

    const next = path.join(home, '.nvm/versions/node/v24.20.0/bin/node');
    const again = fakeIo(true);
    expect(await installHooks({ file, port: 7717, claude: '2.1.282', node: next, io: again })).toBe(
      'installed',
    );
    const status = hookStatus(JSON.parse(readFileSync(file, 'utf8')));
    expect(status).toMatchObject({ complete: true, nodes: [next], ports: [7717] });
  });

  it('does not warn for a system-wide node', async () => {
    const io = fakeIo(true);
    await installHooks({
      file: settingsFile(),
      port: 7717,
      claude: null,
      node: '/usr/bin/node',
      io,
    });
    expect(io.output()).not.toMatch(/managed by/);
  });

  it('recognises common version managers', () => {
    const cases: [string, string | null][] = [
      ['/home/a/.nvm/versions/node/v22.13.0/bin/node', 'nvm'],
      ['C:\\Users\\a\\AppData\\Roaming\\nvm\\v22.13.0\\node.exe', 'nvm'],
      ['/home/a/.local/share/fnm/node-versions/v22.13.0/installation/bin/node', 'fnm'],
      ['/run/user/1000/fnm_multishells/123_456/bin/node', 'fnm'],
      ['/Users/a/.volta/tools/image/node/22.13.0/bin/node', 'volta'],
      ['/home/a/.asdf/installs/nodejs/22.13.0/bin/node', 'asdf'],
      ['/home/a/.local/share/mise/installs/node/22/bin/node', 'mise'],
      ['/usr/bin/node', null],
      ['/opt/homebrew/bin/node', null],
      ['C:\\Program Files\\nodejs\\node.exe', null],
    ];
    for (const [node, manager] of cases) expect(versionManagerOf(node), node).toBe(manager);
  });
});
