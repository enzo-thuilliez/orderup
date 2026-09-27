import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { settingsPath } from '../packages/cli/src/settings.js';
import { assertTempHome } from './home-guard.js';

const tmp = '/tmp';
const realHome = '/home/cook';

describe('test HOME guard', () => {
  it('holds for this very test run', () => {
    expect(() => assertTempHome()).not.toThrow();
    expect(settingsPath().startsWith(os.tmpdir()) || settingsPath().startsWith('/tmp')).toBe(true);
    expect(settingsPath()).not.toBe(path.join(os.userInfo().homedir, '.claude', 'settings.json'));
  });

  it('accepts temporary directories', () => {
    expect(() => assertTempHome({ HOME: '/tmp/orderup-x' }, tmp, realHome)).not.toThrow();
    expect(() =>
      assertTempHome({ HOME: '/tmp/a', CLAUDE_CONFIG_DIR: '/tmp/a/.claude' }, tmp, realHome),
    ).not.toThrow();
  });

  it('fails on the real HOME, a non-temp HOME, or a real CLAUDE_CONFIG_DIR', () => {
    expect(() => assertTempHome({ HOME: realHome }, tmp, realHome)).toThrow(/HOME=\/home\/cook/);
    expect(() => assertTempHome({ HOME: '/srv/elsewhere' }, tmp, realHome)).toThrow(/not a temp/);
    expect(() => assertTempHome({ HOME: '/tmp' }, tmp, realHome)).toThrow();
    expect(() => assertTempHome({}, tmp, realHome)).toThrow(/not set/);
    expect(() =>
      assertTempHome({ HOME: '/tmp/a', CLAUDE_CONFIG_DIR: '/home/cook/.claude' }, tmp, realHome),
    ).toThrow(/CLAUDE_CONFIG_DIR/);
  });
});
