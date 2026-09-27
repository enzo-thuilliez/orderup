import { DEFAULT_PORT } from 'orderup-shared';
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/args.js';
import { browserLaunch } from '../src/browser.js';
import { formatDiff } from '../src/diff.js';

describe('parseCliArgs', () => {
  it('defaults to port 7717 and opening the browser', () => {
    expect(parseCliArgs([])).toMatchObject({
      port: DEFAULT_PORT,
      open: true,
      demo: false,
      installHooks: false,
      uninstallHooks: false,
    });
  });

  it('reads every documented flag', () => {
    expect(parseCliArgs(['--port', '8123', '--no-open', '--demo'])).toMatchObject({
      port: 8123,
      open: false,
      demo: true,
    });
    expect(parseCliArgs(['--install-hooks']).installHooks).toBe(true);
    expect(parseCliArgs(['--uninstall-hooks']).uninstallHooks).toBe(true);
    expect(parseCliArgs(['-h']).help).toBe(true);
    expect(parseCliArgs(['-v']).version).toBe(true);
  });

  it('rejects bad ports, unknown flags and contradictory hook flags', () => {
    for (const port of ['0', '70000', 'abc', '1.5', '']) {
      expect(() => parseCliArgs(['--port', port])).toThrow(/invalid --port/);
    }
    expect(() => parseCliArgs(['--nope'])).toThrow();
    expect(() => parseCliArgs(['--install-hooks', '--uninstall-hooks'])).toThrow();
  });
});

describe('browserLaunch', () => {
  const url = 'http://127.0.0.1:7717/?demo';

  it('opens the Windows browser from WSL', () => {
    expect(browserLaunch(url, { platform: 'linux', wsl: true })).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    });
  });

  it('uses the native opener elsewhere', () => {
    expect(browserLaunch(url, { platform: 'linux', wsl: false }).command).toBe('xdg-open');
    expect(browserLaunch(url, { platform: 'darwin', wsl: false }).command).toBe('open');
    expect(browserLaunch(url, { platform: 'win32', wsl: false }).command).toBe('rundll32');
  });
});

describe('formatDiff', () => {
  it('shows added and removed lines with context', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const after = 'a\nb\nc\nd\nE\nf\ng\nh\ni\n';
    expect(formatDiff(before, after, { context: 1 })).toBe(
      ['  …', '  d', '- e', '+ E', '  f', '  …', '  h', '+ i', ''].join('\n'),
    );
  });

  it('is empty when nothing changes, and all additions for a new file', () => {
    expect(formatDiff('x\n', 'x\n')).toBe('');
    expect(formatDiff('', '{\n}\n')).toBe('+ {\n+ }\n');
  });
});
