import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TicketSource,
  parseIssueList,
  type ExecFn,
  type TicketSourceOptions,
} from '../src/sources/tickets.js';

const issues = (repo: string) =>
  JSON.stringify([
    {
      number: 3,
      title: 'Old one',
      labels: [],
      url: `https://github.com/${repo}/issues/3`,
      updatedAt: '2026-10-01T10:00:00Z',
    },
    {
      number: 7,
      title: 'Fresh one',
      labels: [{ id: 'L1', name: 'v1', color: 'ff0000' }, { name: 'area:server' }],
      url: `https://github.com/${repo}/issues/7`,
      updatedAt: '2026-10-10T10:00:00Z',
    },
  ]);

const execError = (props: Record<string, unknown>) =>
  Object.assign(new Error('Command failed'), props);

function setup(exec: ExecFn, options: Partial<TicketSourceOptions> = {}) {
  const log = vi.fn<(line: string) => void>();
  const onChange = vi.fn();
  const source = new TicketSource({ repos: ['acme/app'], exec, log, onChange, ...options });
  return { source, log, onChange };
}

describe('parseIssueList', () => {
  it('maps gh JSON to tickets, most recently updated first', () => {
    expect(parseIssueList(issues('acme/app'), 'acme/app')).toEqual([
      {
        repo: 'acme/app',
        number: 7,
        title: 'Fresh one',
        labels: ['v1', 'area:server'],
        url: 'https://github.com/acme/app/issues/7',
      },
      {
        repo: 'acme/app',
        number: 3,
        title: 'Old one',
        labels: [],
        url: 'https://github.com/acme/app/issues/3',
      },
    ]);
  });

  it('skips malformed items and keeps extra fields off the ticket', () => {
    const out = parseIssueList(
      JSON.stringify([
        null,
        { number: 'x', title: 't', url: 'u' },
        { number: 1, title: 't', url: 'u', labels: 'nope', body: 'secret' },
      ]),
      'acme/app',
    );
    expect(out).toEqual([{ repo: 'acme/app', number: 1, title: 't', labels: [], url: 'u' }]);
  });
});

describe('TicketSource', () => {
  it('runs gh without a shell, with args as an array and a timeout', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '[]' }));
    const { source } = setup(exec, { repos: ['acme/app', 'acme/web'], timeoutMs: 5000 });
    await source.poll();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(
      1,
      'gh',
      [
        'issue',
        'list',
        '--repo',
        'acme/app',
        '--state',
        'open',
        '--json',
        'number,title,labels,url,updatedAt',
      ],
      expect.objectContaining({ timeout: 5000 }),
    );
    expect(exec.mock.calls[1]![1]).toContain('acme/web');
  });

  it('exposes the open issues of every repo in state', async () => {
    const exec: ExecFn = async (_file, args) => ({ stdout: issues(args[3]!) });
    const { source, onChange, log } = setup(exec, { repos: ['acme/app', 'acme/web'] });
    await source.poll();
    expect(source.status).toBe('ok');
    expect(source.tickets.map((t) => `${t.repo}#${t.number}`)).toEqual([
      'acme/app#7',
      'acme/app#3',
      'acme/web#7',
      'acme/web#3',
    ]);
    const msg = source.snapshot();
    expect(msg).toMatchObject({ type: 'crew.tickets', status: 'ok', message: null });
    expect(msg.updatedAt).toEqual(expect.any(Number));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(msg);
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects repos that are not "owner/name"', () => {
    const exec: ExecFn = async () => ({ stdout: '[]' });
    for (const repo of ['acme', '--help/x', 'a/b/c', 'acme/ app']) {
      expect(() => new TicketSource({ repos: [repo], exec })).toThrow(TypeError);
    }
  });

  it.each([
    ['gh-missing', execError({ code: 'ENOENT' })],
    ['unauthenticated', execError({ code: 4, stderr: 'To get started with GitHub CLI...' })],
    ['unauthenticated', execError({ code: 1, stderr: 'You are not logged in. Run gh auth login' })],
    ['error', execError({ code: 1, stderr: 'error connecting to api.github.com' })],
    ['error', execError({ killed: true, signal: 'SIGTERM' })],
  ] as const)('reports %s and keeps the last good list', async (status, err) => {
    let fail = false;
    const exec: ExecFn = async () => {
      if (fail) throw err;
      return { stdout: issues('acme/app') };
    };
    const { source, log } = setup(exec);
    await source.poll();
    const good = source.tickets;
    const goodAt = source.snapshot().updatedAt;

    fail = true;
    await source.poll();
    expect(source.status).toBe(status);
    expect(source.tickets).toEqual(good);
    const msg = source.snapshot();
    expect(msg.message).toEqual(expect.any(String));
    expect(msg.message!.length).toBeLessThan(80);
    expect(msg.message).not.toContain('api.github.com');
    expect(msg.updatedAt).toBe(goodAt);
    expect(log).toHaveBeenCalledOnce();
  });

  it('reports bad JSON as error', async () => {
    const { source } = setup(async () => ({ stdout: '<html>rate limited</html>' }));
    await source.poll();
    expect(source.snapshot()).toMatchObject({
      status: 'error',
      message: 'gh returned invalid JSON for acme/app',
      tickets: [],
      updatedAt: null,
    });
  });

  it('stops at the first repo when gh is missing', async () => {
    const exec = vi.fn<ExecFn>(async () => {
      throw execError({ code: 'ENOENT' });
    });
    const { source } = setup(exec, { repos: ['acme/app', 'acme/web'] });
    await source.poll();
    expect(exec).toHaveBeenCalledOnce();
  });

  it('logs a status change once, and the recovery', async () => {
    let fail = true;
    const { source, log, onChange } = setup(async () => {
      if (fail) throw execError({ code: 4 });
      return { stdout: '[]' };
    });
    await source.poll();
    await source.poll();
    await source.poll();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toContain('unauthenticated');
    expect(onChange).toHaveBeenCalledOnce();

    fail = false;
    await source.poll();
    expect(source.status).toBe('ok');
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('never rejects, whatever exec throws', async () => {
    const { source } = setup(async () => {
      throw 'not even an Error';
    });
    await expect(source.poll()).resolves.toBeUndefined();
    expect(source.status).toBe('error');
  });

  describe('timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('polls at start, then every 60 s by default, until stop()', async () => {
      const exec = vi.fn<ExecFn>(async () => ({ stdout: '[]' }));
      const { source } = setup(exec);
      source.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(exec).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(exec).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(exec).toHaveBeenCalledTimes(2);

      source.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(exec).toHaveBeenCalledTimes(2);
    });

    it('takes a custom interval and never overlaps polls', async () => {
      let release: (() => void) | undefined;
      const exec = vi.fn<ExecFn>(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ stdout: '[]' });
          }),
      );
      const { source } = setup(exec, { intervalMs: 1000 });
      source.start();
      await vi.advanceTimersByTimeAsync(5000);
      // The first poll is still running: no second gh call.
      expect(exec).toHaveBeenCalledTimes(1);
      void source.poll();
      expect(exec).toHaveBeenCalledTimes(1);

      release!();
      await vi.advanceTimersByTimeAsync(999);
      expect(exec).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(exec).toHaveBeenCalledTimes(2);
      source.stop();
    });

    it('schedules nothing when stopped during a poll', async () => {
      let release: (() => void) | undefined;
      const exec = vi.fn<ExecFn>(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ stdout: '[]' });
          }),
      );
      const { source } = setup(exec, { intervalMs: 1000 });
      source.start();
      await vi.advanceTimersByTimeAsync(0);
      source.stop();
      release!();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
