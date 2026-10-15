import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDatabase,
  renderAgentFile,
  Repository,
  STATION_DEFINITIONS,
  stationsHash,
  type Database,
} from 'orderup-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentFilesStatus, installAgents, uninstallAgents } from '../src/agents.js';
import { parseCliArgs } from '../src/args.js';
import { CREW_MIN_CLAUDE_VERSION } from '../src/claude.js';
import { parseCrewArgs, runCrew, type CrewDeps } from '../src/crew.js';
import { crewChecks } from '../src/doctor.js';
import type { Io } from '../src/hooks.js';

let tmp: string;
const dbs: Database[] = [];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orderup-crew-')));
});

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  rmSync(tmp, { recursive: true, force: true });
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

/** A fake git repo dir: git itself is mocked, so only the directory needs to exist. */
function repoDir(name = 'repo'): string {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function deps(io: Io, repos: string[] = []): CrewDeps & { repository: Repository } {
  const db = openDatabase(path.join(tmp, 'orderup.db'));
  dbs.push(db);
  const repository = new Repository(db, () => 5000);
  return {
    io,
    repository,
    openRepository: () => ({ repository, close: () => undefined }),
    // Mocked git: a directory is a repo when it is, or is inside, one of `repos`.
    gitToplevel: vi.fn((dir: string) =>
      Promise.resolve(repos.find((r) => dir === r || dir.startsWith(r + path.sep)) ?? null),
    ),
    cwd: tmp,
    now: () => new Date(2026, 9, 15, 12).getTime(),
  };
}

describe('parseCrewArgs', () => {
  it('reads every command and set flag', () => {
    expect(parseCrewArgs([])).toEqual({ command: 'help' });
    expect(parseCrewArgs(['status', '--help'])).toEqual({ command: 'help' });
    expect(parseCrewArgs(['status'])).toEqual({ command: 'status' });
    expect(
      parseCrewArgs([
        'set',
        '--station-cap',
        '2',
        '--global-cap',
        '6',
        '--budget',
        '2.5',
        '--repo',
        '../x',
        '--model',
        'opus',
      ]),
    ).toEqual({
      command: 'set',
      stationCap: 2,
      globalCap: 6,
      dailyCapUsd: 2.5,
      repo: '../x',
      chefModel: 'opus',
    });
    expect(parseCrewArgs(['set', '--budget', '0'])).toEqual({ command: 'set', dailyCapUsd: 0 });
    expect(parseCrewArgs(['set', '--model', 'default'])).toEqual({
      command: 'set',
      chefModel: null,
    });
    expect(parseCrewArgs(['install-agents', '--repo', 'r'])).toEqual({
      command: 'install-agents',
      repo: 'r',
    });
    expect(parseCrewArgs(['uninstall-agents'])).toEqual({ command: 'uninstall-agents' });
  });

  it('rejects bad values, unknown commands and stray flags', () => {
    for (const n of ['0', '-1', '1.5', 'abc', '']) {
      expect(() => parseCrewArgs(['set', `--station-cap=${n}`])).toThrow(/invalid --station-cap/);
      expect(() => parseCrewArgs(['set', `--global-cap=${n}`])).toThrow(/invalid --global-cap/);
    }
    for (const usd of ['-1', 'abc', '', 'Infinity']) {
      expect(() => parseCrewArgs(['set', `--budget=${usd}`])).toThrow(/invalid --budget/);
    }
    expect(() => parseCrewArgs(['set', '--model', 'two words'])).toThrow(/invalid --model/);
    expect(() => parseCrewArgs(['set', '--repo', ' '])).toThrow(/invalid --repo/);
    expect(() => parseCrewArgs(['set'])).toThrow(/at least one/);
    expect(() => parseCrewArgs(['add', 'bob'])).toThrow();
    expect(() => parseCrewArgs(['brew'])).toThrow(/unknown crew command/);
    expect(() => parseCrewArgs(['status', '--budget', '1'])).toThrow(/takes no --budget/);
    expect(() => parseCrewArgs(['install-agents', '--model', 'x'])).toThrow(/takes no/);
    expect(() => parseCrewArgs(['status', '--nope'])).toThrow();
  });
});

describe('parseCliArgs --crew', () => {
  it('is off by default and parsed when given', () => {
    expect(parseCliArgs([]).crew).toBe(false);
    expect(parseCliArgs(['--crew']).crew).toBe(true);
    expect(parseCliArgs(['--doctor', '--crew'])).toMatchObject({ doctor: true, crew: true });
  });
});

describe('orderup crew status / set', () => {
  it('prints the defaults, the stations and the budget used today', async () => {
    const io = fakeIo();
    const d = deps(io);
    d.repository.startRun({ id: 'r1', trigger: 'talk' });
    d.repository.addUsage({
      runId: 'r1',
      costUsd: 1.5,
      recordedAt: new Date(2026, 9, 15, 9).getTime(),
    });
    expect(await runCrew({ command: 'status' }, d)).toBe(0);
    const out = io.output();
    expect(out).toContain('off unless orderup is started with --crew');
    expect(out).toContain('not set. Set it with: orderup crew set --repo <path>');
    expect(out).toContain("default (the claude CLI's)");
    expect(out).toContain('4 per station');
    expect(out).toContain('8 in total');
    expect(out).toContain('$5.00 per day, API-equivalent; $1.50 used today');
    for (const def of STATION_DEFINITIONS) expect(out).toContain(def.name);
    expect(out).toContain(stationsHash().slice(0, 12));
  });

  it('persists each setting and records the definitions hash', async () => {
    const repo = repoDir();
    const d = deps(fakeIo(), [repo]);
    await runCrew(
      {
        command: 'set',
        stationCap: 2,
        globalCap: 6,
        dailyCapUsd: 0,
        chefModel: 'opus',
        repo: 'repo/sub/..',
      },
      d,
    );
    expect(d.repository.getBrigadeConfig()).toMatchObject({
      repoPath: repo,
      chefModel: 'opus',
      stationCap: 2,
      globalCap: 6,
      dailyCapUsd: 0,
      stationsHash: stationsHash(),
    });
    expect(d.gitToplevel).toHaveBeenCalledWith(repo);

    const io = fakeIo();
    await runCrew({ command: 'set', chefModel: null }, { ...d, io });
    expect(d.repository.getBrigadeConfig()).toMatchObject({ chefModel: null, stationCap: 2 });
    expect(io.output()).toContain('crew runs are disabled');
  });

  it('refuses a repo that is not a git repo or not a directory, changing nothing', async () => {
    repoDir('plain');
    const d = deps(fakeIo());
    await expect(runCrew({ command: 'set', repo: 'plain', stationCap: 3 }, d)).rejects.toThrow(
      /is not a git repository/,
    );
    await expect(runCrew({ command: 'set', repo: 'missing' }, d)).rejects.toThrow(
      /is not a directory/,
    );
    expect(d.repository.getBrigadeConfig().stationCap).toBe(4);
  });

  it('notes a station cap above the global cap', async () => {
    const io = fakeIo();
    await runCrew({ command: 'set', stationCap: 9 }, deps(io));
    expect(io.output()).toMatch(/station cap \(9\) is above the global cap \(8\)/);
  });

  it('prints help without opening the database', async () => {
    const io = fakeIo();
    const open = vi.fn();
    await runCrew({ command: 'help' }, { io, gitToplevel: vi.fn(), openRepository: open });
    expect(io.output()).toContain('install-agents');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('orderup crew install-agents / uninstall-agents', () => {
  const agents = (repo: string) => path.join(repo, '.claude', 'agents');

  it('shows the diff, asks, then writes the five files', async () => {
    const repo = repoDir();
    const io = fakeIo(true);
    expect(await installAgents({ repo, io })).toBe('installed');
    expect(io.asked).toEqual(['\nWrite these 5 station files? [y/N] ']);
    expect(io.output()).toContain(`${path.join(agents(repo), 'orderup-hot.md')} (new file)`);
    expect(io.output()).toContain('+ name: orderup-hot');
    expect(readdirSync(agents(repo)).sort()).toEqual(
      STATION_DEFINITIONS.map((def) => `${def.name}.md`).sort(),
    );
    expect(readFileSync(path.join(agents(repo), 'orderup-pastry.md'), 'utf8')).toBe(
      renderAgentFile(STATION_DEFINITIONS[3]!),
    );
    expect((await agentFilesStatus(repo)).current).toBe(true);
  });

  it('writes nothing when declined, and is a no-op when files already match', async () => {
    const repo = repoDir();
    expect(await installAgents({ repo, io: fakeIo(false) })).toBe('cancelled');
    expect(existsSync(agents(repo))).toBe(false);

    await installAgents({ repo, io: fakeIo(true) });
    const io = fakeIo(true);
    expect(await installAgents({ repo, io })).toBe('unchanged');
    expect(io.asked).toEqual([]);
    expect(io.output()).toContain('already up to date');
  });

  it('updates only stale files and never touches files not named orderup-*', async () => {
    const repo = repoDir();
    mkdirSync(agents(repo), { recursive: true });
    const mine = path.join(agents(repo), 'reviewer.md');
    const other = path.join(agents(repo), 'orderup-custom.md');
    writeFileSync(mine, 'my agent\n');
    writeFileSync(other, 'not a station\n');
    await installAgents({ repo, io: fakeIo(true) });
    const hot = path.join(agents(repo), 'orderup-hot.md');
    writeFileSync(hot, readFileSync(hot, 'utf8').replace('backend cook', 'grill cook'));
    expect((await agentFilesStatus(repo)).files.find((f) => f.name === 'orderup-hot')?.state).toBe(
      'stale',
    );

    const io = fakeIo(true);
    await installAgents({ repo, io });
    expect(io.asked).toEqual(['\nWrite these 1 station file? [y/N] ']);
    expect(io.output()).toContain('grill cook');

    const removed = fakeIo(true);
    expect(await uninstallAgents({ repo, io: removed })).toBe('removed');
    expect(removed.output()).toContain('(delete)');
    expect(readdirSync(agents(repo)).sort()).toEqual(['orderup-custom.md', 'reviewer.md']);
    expect(readFileSync(mine, 'utf8')).toBe('my agent\n');
    expect(await uninstallAgents({ repo, io: fakeIo(true) })).toBe('none');
  });

  it('keeps the files when uninstall is declined', async () => {
    const repo = repoDir();
    await installAgents({ repo, io: fakeIo(true) });
    expect(await uninstallAgents({ repo, io: fakeIo(false) })).toBe('cancelled');
    expect(readdirSync(agents(repo))).toHaveLength(5);
  });

  it('refuses to write through a symlink', async () => {
    const repo = repoDir();
    mkdirSync(agents(repo), { recursive: true });
    const target = path.join(tmp, 'outside.md');
    writeFileSync(target, 'outside\n');
    symlinkSync(target, path.join(agents(repo), 'orderup-hot.md'));
    await expect(installAgents({ repo, io: fakeIo(true) })).rejects.toThrow(/not a regular file/);
    expect(readFileSync(target, 'utf8')).toBe('outside\n');
  });

  it('runCrew targets --repo, else the configured repo, and records the hash', async () => {
    const configured = repoDir('configured');
    const flagged = repoDir('flagged');
    const d = deps(fakeIo(true), [configured, flagged]);
    d.repository.updateBrigadeConfig({ repoPath: configured });
    await runCrew({ command: 'install-agents' }, d);
    expect(existsSync(agents(configured))).toBe(true);
    expect(d.repository.getBrigadeConfig().stationsHash).toBe(stationsHash());

    await runCrew({ command: 'install-agents', repo: 'flagged' }, d);
    expect(existsSync(agents(flagged))).toBe(true);
    await runCrew({ command: 'uninstall-agents', repo: 'flagged' }, d);
    expect(readdirSync(agents(flagged))).toEqual([]);

    await expect(
      runCrew({ command: 'install-agents', repo: 'flagged/../nowhere' }, d),
    ).rejects.toThrow(/is not a directory/);
  });
});

describe('crewChecks (orderup --doctor)', () => {
  const loggedIn = () => Promise.resolve({ loggedIn: true, method: 'claude.ai' });

  it('passes with a recent, logged-in claude and no fallback files', async () => {
    const repo = repoDir();
    const auth = vi.fn(loggedIn);
    const checks = await crewChecks({ claude: '2.1.300', auth, repo, required: true });
    expect(checks.map((c) => c.level)).toEqual(['ok', 'ok']);
    expect(checks[1]!.detail).toBe('claude is logged in (claude.ai)');
    expect(auth).toHaveBeenCalledOnce();
  });

  it('fails below the minimum version without asking about login', async () => {
    const auth = vi.fn(loggedIn);
    const checks = await crewChecks({ claude: '2.1.216', auth, repo: null, required: true });
    expect(checks[0]).toMatchObject({ name: 'crew', level: 'FAIL' });
    expect(checks[0]!.detail).toContain(
      `Claude Code 2.1.216 is too old for crew: it needs ${CREW_MIN_CLAUDE_VERSION} or later`,
    );
    expect(checks[1]).toMatchObject({ level: 'warn' });
    expect(auth).not.toHaveBeenCalled();
  });

  it('only warns when crew is not set up', async () => {
    const checks = await crewChecks({ claude: null, auth: loggedIn, repo: null, required: false });
    expect(checks).toEqual([
      { name: 'crew', level: 'warn', detail: expect.stringContaining('not on PATH') },
    ]);
  });

  it('reports logged out as a failure and an unknown login as a warning', async () => {
    const out = await crewChecks({
      claude: CREW_MIN_CLAUDE_VERSION,
      auth: () => Promise.resolve({ loggedIn: false }),
      repo: null,
      required: true,
    });
    expect(out[1]).toMatchObject({
      level: 'FAIL',
      detail: expect.stringContaining('not logged in'),
    });
    const unknown = await crewChecks({
      claude: CREW_MIN_CLAUDE_VERSION,
      auth: () => Promise.resolve({ loggedIn: null }),
      repo: null,
      required: true,
    });
    expect(unknown[1]).toMatchObject({ level: 'warn', detail: expect.stringContaining('unknown') });
  });

  it('checks fallback files against the current definitions when they exist', async () => {
    const repo = repoDir();
    await installAgents({ repo, io: fakeIo(true) });
    const ok = await crewChecks({ claude: '2.1.300', auth: loggedIn, repo, required: true });
    expect(ok[2]).toMatchObject({ level: 'ok', detail: expect.stringContaining('match') });

    rmSync(path.join(repo, '.claude', 'agents', 'orderup-dish.md'));
    const stale = await crewChecks({ claude: '2.1.300', auth: loggedIn, repo, required: true });
    expect(stale[2]).toMatchObject({ level: 'warn' });
    expect(stale[2]!.detail).toContain('orderup-dish');
    expect(stale[2]!.detail).toContain(`orderup crew install-agents --repo ${repo}`);
  });
});
