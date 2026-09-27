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
  installHooks,
  supportsQuietAsync,
  uninstallHooks,
  type Io,
} from '../src/hooks.js';
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

    expect(await installHooks({ file, port: 7717, async: true, io })).toBe('installed');

    expect(io.asked).toHaveLength(1);
    expect(io.output()).toMatch(/^\+ .*orderup-hook/m);
    expect(readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8')).toBe(original);
    const text = readFileSync(file, 'utf8');
    const written = JSON.parse(text) as Record<string, unknown>;
    expect(written.model).toBe('opus');
    expect(hookStatus(written)).toEqual({ installed: true, complete: true, ports: [7717] });
    expect(text).toMatch(/^ {4}"model"/m);
  });

  it('writes nothing when the user declines', async () => {
    const file = settingsFile();
    const result = await installHooks({ file, port: 7717, async: true, io: fakeIo(false) });
    expect(result).toBe('cancelled');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(existsSync(`${file}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it('does not ask or write when the hooks are already there', async () => {
    const file = settingsFile();
    await installHooks({ file, port: 7717, async: true, io: fakeIo(true) });
    const after = readFileSync(file, 'utf8');
    const io = fakeIo(true);
    expect(await installHooks({ file, port: 7717, async: true, io })).toBe('unchanged');
    expect(io.asked).toHaveLength(0);
    expect(readFileSync(file, 'utf8')).toBe(after);
  });

  it('creates settings.json when missing, without a backup', async () => {
    const file = settingsFile(null);
    expect(await installHooks({ file, port: 7717, async: false, io: fakeIo() })).toBe('installed');
    expect(hookStatus(JSON.parse(readFileSync(file, 'utf8'))).complete).toBe(true);
    expect(existsSync(`${file}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it('uninstall removes only OrderUp hooks', async () => {
    const file = settingsFile();
    await installHooks({ file, port: 7717, async: true, io: fakeIo(true) });
    const io = fakeIo(true);

    expect(await uninstallHooks({ file, io })).toBe('removed');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(original));
    expect(io.output()).toMatch(/^- .*orderup-hook/m);
    expect(await uninstallHooks({ file, io: fakeIo(true) })).toBe('none');
  });

  it('refuses to touch a settings.json that is not valid JSON', async () => {
    const file = settingsFile('{ "model": ');
    await expect(installHooks({ file, port: 7717, async: true, io: fakeIo(true) })).rejects.toThrow(
      /not valid JSON/,
    );
    expect(readFileSync(file, 'utf8')).toBe('{ "model": ');
  });

  it.skipIf(process.platform === 'win32')('writes through a symlinked settings.json', async () => {
    const real = path.join(home, 'dotfiles', 'claude-settings.json');
    mkdirSync(path.dirname(real), { recursive: true });
    writeFileSync(real, original);
    const file = settingsFile(null);
    symlinkSync(real, file);

    await installHooks({ file, port: 7717, async: true, io: fakeIo(true) });

    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(hookStatus(JSON.parse(readFileSync(real, 'utf8'))).installed).toBe(true);
  });
});

describe('Claude Code version gate', () => {
  it('uses background hooks only on versions that run them silently', () => {
    expect(compareVersions('2.1.282', '2.1.119')).toBe(1);
    expect(compareVersions('2.1.9', '2.1.119')).toBe(-1);
    expect(supportsQuietAsync('2.1.119')).toBe(true);
    expect(supportsQuietAsync('2.1.75')).toBe(false);
    expect(supportsQuietAsync(null)).toBe(false);
  });
});
