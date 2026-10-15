import { beforeEach, describe, expect, it, vi } from 'vitest';

type Callback = (err: (Error & { code?: unknown }) | null, stdout: string) => void;
const execFile = vi.fn();

// Every subprocess is mocked: no real claude or git runs in tests.
vi.mock('node:child_process', () => ({ execFile }));

const { claudeAuthStatus, gitToplevel, supportsCrew } = await import('../src/claude.js');

function answer(err: (Error & { code?: unknown }) | null, stdout = '') {
  execFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Callback) => {
    cb(err, stdout);
    return { stdin: { end: () => undefined } };
  });
}

const exit = (code: unknown) => Object.assign(new Error('exit'), { code });

beforeEach(() => execFile.mockReset());

describe('claudeAuthStatus', () => {
  it('runs `claude auth status` and reads the documented exit codes', async () => {
    answer(null, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'x@y.z' }));
    expect(await claudeAuthStatus()).toEqual({ loggedIn: true, method: 'claude.ai' });
    expect(execFile.mock.calls[0]!.slice(0, 2)).toEqual(['claude', ['auth', 'status']]);

    answer(exit(1), JSON.stringify({ loggedIn: false, authMethod: 'none' }));
    expect(await claudeAuthStatus()).toEqual({ loggedIn: false, method: 'none' });

    answer(exit(1), 'Not logged in');
    expect(await claudeAuthStatus()).toEqual({ loggedIn: false });
  });

  it('answers unknown on anything else', async () => {
    answer(exit('ENOENT'));
    expect(await claudeAuthStatus()).toEqual({ loggedIn: null });
    answer(exit(2));
    expect(await claudeAuthStatus()).toEqual({ loggedIn: null });
    answer(exit(null));
    expect(await claudeAuthStatus()).toEqual({ loggedIn: null });
  });
});

describe('gitToplevel', () => {
  it('returns the work tree top, or null outside a repo', async () => {
    answer(null, '/work/repo\n');
    expect(await gitToplevel('/work/repo/src')).toBe('/work/repo');
    expect(execFile.mock.calls[0]!.slice(0, 3)).toEqual([
      'git',
      ['rev-parse', '--show-toplevel'],
      expect.objectContaining({ cwd: '/work/repo/src' }),
    ]);
    answer(exit(128));
    expect(await gitToplevel('/tmp')).toBeNull();
  });
});

describe('supportsCrew', () => {
  it('needs Claude Code 2.1.217 or later', () => {
    expect(supportsCrew('2.1.217')).toBe(true);
    expect(supportsCrew('2.2.0')).toBe(true);
    expect(supportsCrew('2.1.216')).toBe(false);
    expect(supportsCrew(null)).toBe(false);
  });
});
