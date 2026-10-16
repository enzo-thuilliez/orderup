import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentsJson,
  buildChefArgs,
  buildChefSystemPrompt,
  chefWorktreePath,
  CrewRunner,
  ensureChefWorktree,
  hooksDir,
  installPushGuard,
  localDay,
  MAX_CONCURRENT_RUNS,
  MIN_BUDGET_USD,
  openDatabase,
  parseStreamLine,
  removeChefWorktree,
  Repository,
  startServer,
  type Database,
  type RunnerEvent,
} from '../src/index.js';
import {
  alive,
  FAKE_CLAUDE,
  git,
  GIT_ENV,
  tempRepo,
  tmp,
  waitFor,
  type FakeLog,
} from './helpers.js';

const posix = process.platform !== 'win32';

const dbs: Database[] = [];
const runners: CrewRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stopAll();
  for (const db of dbs.splice(0)) db.close();
});

function setup(config: { dailyCapUsd?: number; chefModel?: string | null } = {}) {
  const { repo, origin } = tempRepo();
  const db = openDatabase(path.join(tmp('orderup-db-'), 'orderup.db'));
  dbs.push(db);
  const repository = new Repository(db);
  repository.updateBrigadeConfig({ repoPath: repo, globalCap: 6, ...config });
  const logDir = tmp('orderup-fake-');
  const orderupDir = path.join(tmp('orderup-home-'), '.orderup');
  const events: RunnerEvent[] = [];
  const runner = new CrewRunner({
    repository,
    claudeBin: FAKE_CLAUDE,
    env: { ...process.env, FAKE_CLAUDE_LOG: logDir },
    orderupDir,
    onEvent: (event) => events.push(event),
  });
  runners.push(runner);
  const logs = (): FakeLog[] =>
    readdirSync(logDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(path.join(logDir, f), 'utf8')));
  const ended = (runId: string) =>
    waitFor(
      () =>
        events.find(
          (e): e is Extract<RunnerEvent, { type: 'run.ended' }> =>
            e.type === 'run.ended' && e.runId === runId,
        ),
      10_000,
    );
  return { repo, origin, repository, runner, events, logs, ended, orderupDir };
}

async function started(
  runner: CrewRunner,
  options: Parameters<CrewRunner['startRun']>[0],
): Promise<string> {
  const result = await runner.startRun(options);
  if (!result.ok) throw new Error(`refused: ${result.code} ${result.message}`);
  return result.runId;
}

describe('parseStreamLine', () => {
  it('ignores malformed and unknown lines', () => {
    for (const line of [
      '',
      'not json',
      '{"type":',
      '[1]',
      'null',
      '42',
      '{"type":"mystery"}',
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":"x"}}',
      '{"type":"user","message":{"content":[{"type":"tool_result"}]}}',
      '{"type":"stream_event","event":{"delta":{"type":"input_json_delta"}}}',
    ]) {
      expect(parseStreamLine(line)).toEqual([]);
    }
  });

  it('reads the session, text, Agent calls with subagent_type, results and usage', () => {
    expect(parseStreamLine('{"type":"system","subtype":"init","session_id":"s1"}')).toEqual([
      { kind: 'init', sessionId: 's1' },
    ]);
    const agent = parseStreamLine(
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'text', text: 'hi' },
            {
              type: 'tool_use',
              id: 't1',
              name: 'Agent',
              input: { subagent_type: 'orderup-pastry', description: 'Tests', prompt: 'P' },
            },
          ],
        },
      }),
    );
    expect(agent).toEqual([
      { kind: 'text', text: 'hi', parentToolUseId: null, partial: false },
      {
        kind: 'tool_use',
        id: 't1',
        name: 'Agent',
        parentToolUseId: null,
        subagentType: 'orderup-pastry',
        description: 'Tests',
      },
    ]);
    expect(JSON.stringify(agent)).not.toContain('"P"');

    const [result] = parseStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        session_id: 's1',
        total_cost_usd: 0.5,
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 'x' },
      }),
    );
    expect(result).toEqual({
      kind: 'result',
      sessionId: 's1',
      subtype: 'success',
      isError: false,
      text: 'done',
      totalCostUsd: 0.5,
      tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    });
  });
});

describe('buildChefArgs', () => {
  it('builds the documented flags, and never --bare or a permission bypass', () => {
    const args = buildChefArgs({ model: 'opus', resumeSessionId: 's1', maxBudgetUsd: 4.5 });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '30',
      '--agents',
      agentsJson(),
      '--settings',
      '{"worktree":{"baseRef":"head"}}',
      '--model',
      'opus',
      '--resume',
      's1',
      '--max-budget-usd',
      '4.50',
    ]);
    const budget = (maxBudgetUsd: number | null) => {
      const a = buildChefArgs({ maxBudgetUsd });
      return a.includes('--max-budget-usd') ? a[a.indexOf('--max-budget-usd') + 1] : null;
    };
    expect(budget(3.749)).toBe('3.74');
    expect(budget(0.001)).toBe('0.01');
    expect(budget(0)).toBe('0.01');
    expect(budget(-2)).toBe('0.01');
    expect(budget(null)).toBeNull();
    const plain = buildChefArgs({});
    expect(plain).not.toContain('--model');
    expect(plain).not.toContain('--resume');
    expect(plain).not.toContain('--max-budget-usd');
    for (const flag of [
      '--bare',
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
      '--permission-mode',
    ]) {
      expect(args).not.toContain(flag);
    }
  });
});

describe('buildChefSystemPrompt', () => {
  it('states the task id, both caps and the report schema', () => {
    const prompt = buildChefSystemPrompt({ taskId: 't_01JABC', stationCap: 3, globalCap: 7 });
    expect(prompt).toContain('t_01JABC');
    expect(prompt).toContain('"taskId": "t_01JABC"');
    expect(prompt).toContain('At most 3 cooks at the same station');
    expect(prompt).toContain('At most 7 cooks in total');
    expect(prompt).toContain('"schema": 1');
    for (const field of ['ticket', 'stations', 'summary', 'prUrl', 'filesChanged', 'unmerged']) {
      expect(prompt).toContain(`"${field}":`);
    }
    for (const name of ['orderup-hot', 'orderup-garde-manger', 'orderup-commis']) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toMatch(/Never push to the protected branch/);
    expect(prompt).toMatch(/retry|once/);
  });

  it('is passed as --append-system-prompt, after the other flags', () => {
    const args = buildChefArgs({ appendSystemPrompt: 'be the chef' });
    expect(args.slice(-2)).toEqual(['--append-system-prompt', 'be the chef']);
    expect(buildChefArgs({})).not.toContain('--append-system-prompt');
  });
});

describe('chef worktree and push guard', () => {
  it('creates the worktree under ~/.orderup on orderup/<taskId>, outside the checkout', async () => {
    const { repo } = tempRepo();
    const orderupDir = path.join(os.homedir(), '.orderup');
    const before = git(repo, ['status', '--porcelain']);
    const head = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);

    const wt = await ensureChefWorktree({ repoPath: repo, taskId: 't_1', orderupDir });
    expect(wt).toMatchObject({ branch: 'orderup/t_1', defaultBranch: 'main', created: true });
    expect(wt.path).toBe(path.join(orderupDir, 'worktrees', 'kitchen', 't_1'));
    expect(path.relative(repo, wt.path).startsWith('..')).toBe(true);
    expect(git(wt.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('orderup/t_1');
    expect(git(wt.path, ['rev-parse', 'HEAD'])).toBe(git(repo, ['rev-parse', 'main']));
    // The user's checkout is untouched: same branch, clean, no hooks written into .git.
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(head);
    expect(git(repo, ['status', '--porcelain'])).toBe(before);
    expect(existsSync(path.join(repo, '.git', 'hooks', 'pre-push'))).toBe(false);

    // A second run of the task reuses it.
    const again = await ensureChefWorktree({ repoPath: repo, taskId: 't_1', orderupDir });
    expect(again).toMatchObject({ path: wt.path, created: false });

    await removeChefWorktree({ repoPath: repo, taskId: 't_1', orderupDir });
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, ['branch', '--list', 'orderup/t_1'])).toBe('');
    // Idempotent.
    await removeChefWorktree({ repoPath: repo, taskId: 't_1', orderupDir });
  });

  it("never reuses another repo's worktree with the same basename", async () => {
    const orderupDir = path.join(tmp('orderup-home-'), '.orderup');
    const a = tempRepo().repo;
    const b = tempRepo().repo;
    expect(path.basename(a)).toBe(path.basename(b));
    await ensureChefWorktree({ repoPath: a, taskId: 't3', orderupDir });
    await expect(ensureChefWorktree({ repoPath: b, taskId: 't3', orderupDir })).rejects.toThrow(
      /not this repo's worktree/,
    );
  });

  it('rejects task ids outside [A-Za-z0-9_-]', async () => {
    const { repo } = tempRepo();
    for (const taskId of ['../x', 'a/b', '', '-rf', 'a b', 't.1']) {
      await expect(ensureChefWorktree({ repoPath: repo, taskId })).rejects.toThrow(/task id/);
      await expect(removeChefWorktree({ repoPath: repo, taskId })).rejects.toThrow(/task id/);
    }
  });

  it.runIf(posix)(
    'refuses a chef push to the default branch, allows the task branch and your own pushes',
    async () => {
      const { repo, origin } = tempRepo();
      const orderupDir = path.join(os.homedir(), '.orderup');
      const wt = await ensureChefWorktree({ repoPath: repo, taskId: 't2', orderupDir });
      const dir = await installPushGuard(orderupDir);
      expect(dir).toBe(hooksDir(orderupDir));
      expect(statSync(path.join(dir, 'pre-push')).mode & 0o111).not.toBe(0);
      git(wt.path, ['commit', '--allow-empty', '-m', 'chef work']);

      const chefEnv = {
        ...GIT_ENV,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: dir,
        ORDERUP_PROTECTED_BRANCH: 'main',
      };
      const push = (refspec: string, env: NodeJS.ProcessEnv) =>
        spawnSync('git', ['push', 'origin', refspec], { cwd: wt.path, env, encoding: 'utf8' });

      const refused = push('HEAD:main', chefEnv);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('OrderUp: the crew never pushes to main');
      expect(push(':main', chefEnv).status).not.toBe(0);
      // The remote's HEAD is protected even when the env names nothing.
      expect(push('HEAD:main', { ...chefEnv, ORDERUP_PROTECTED_BRANCH: '' }).status).not.toBe(0);
      expect(git(origin, ['log', '-1', '--format=%s', 'main'])).toBe('init');

      expect(push('HEAD:refs/heads/orderup/t2', chefEnv).status).toBe(0);
      // Without the chef's env (the user's own push), the guard does not apply.
      expect(push('HEAD:main', GIT_ENV).status).toBe(0);
    },
  );
});

describe('CrewRunner', () => {
  it('spawns the chef with its args, env and worktree, and the prompt on stdin', async () => {
    const { runner, logs, ended, repo, orderupDir, repository } = setup({ chefModel: 'sonnet' });
    const runId = await started(runner, {
      trigger: 'assign',
      taskId: 'task-1',
      prompt: 'scenario:ok -- not a flag',
    });
    await ended(runId);

    const [log] = logs();
    expect(log!.args).toEqual(
      buildChefArgs({
        model: 'sonnet',
        maxBudgetUsd: repository.getBrigadeConfig().dailyCapUsd,
        appendSystemPrompt: buildChefSystemPrompt({
          taskId: 'task-1',
          stationCap: 4,
          globalCap: 6,
        }),
      }),
    );
    expect(log!.args).not.toContain('scenario:ok -- not a flag');
    expect(log!.prompt).toBe('scenario:ok -- not a flag');
    expect(log!.cwd).toBe(chefWorktreePath(repo, 'task-1', orderupDir));
    expect(log!.env).toEqual({
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '6',
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: hooksDir(orderupDir),
      ORDERUP_PROTECTED_BRANCH: 'main',
    });
    expect(existsSync(path.join(hooksDir(orderupDir), 'pre-push'))).toBe(true);
  });

  it('turns the stream into events, persists the run, usage and owned sessions', async () => {
    const { runner, events, ended, repository } = setup();
    const runId = await started(runner, { trigger: 'assign', taskId: 't1', prompt: 'scenario:ok' });
    const end = await ended(runId);

    const session = events.find((e) => e.type === 'run.session');
    expect(session).toMatchObject({ runId, sessionId: expect.stringMatching(/^sess-/) });
    const sessionId = (session as { sessionId: string }).sessionId;
    expect(events.filter((e) => e.type === 'run.text')).toEqual([
      { type: 'run.text', runId, text: 'Splitting the task.' },
      // Partial deltas only arrive with --include-partial-messages; parsed all the same.
      { type: 'run.text', runId, text: 'All ' },
    ]);
    expect(events).toContainEqual({
      type: 'run.tool',
      runId,
      toolUseId: 'toolu_agent_1',
      name: 'Agent',
      parentToolUseId: null,
      subagentType: 'orderup-hot',
      description: 'Add the endpoint',
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'run.tool', name: 'Edit', parentToolUseId: 'toolu_agent_1' }),
    );
    expect(events).toContainEqual({
      type: 'run.subagent',
      runId,
      agentId: 'agent-abc',
      agentType: 'orderup-hot',
    });
    expect(JSON.stringify(events)).not.toContain('SECRET PROMPT TEXT');
    expect(end).toMatchObject({
      status: 'success',
      exitCode: 0,
      usage: { costUsd: 0.25, tokens: { input: 100, output: 50, cacheRead: 3, cacheWrite: 4 } },
    });
    expect(end.resultText).toContain('```json');

    expect(repository.getRun(runId)).toMatchObject({
      status: 'success',
      chefSessionId: sessionId,
      taskId: 't1',
      trigger: 'assign',
    });
    expect(repository.getRun(runId)!.endedAt).not.toBeNull();
    expect(repository.usageForRun(runId)).toEqual([
      expect.objectContaining({ costUsd: 0.25, tokens: expect.objectContaining({ input: 100 }) }),
    ]);
    expect(repository.ownedSessions().map((s) => [s.kind, s.id, s.agentType])).toEqual([
      ['chef', sessionId, null],
      ['subagent', 'agent-abc', 'orderup-hot'],
    ]);
    expect(runner.activeRunIds).toEqual([]);
  });

  it('ends an error exit as error', async () => {
    const { runner, ended, repository } = setup();
    const runId = await started(runner, {
      trigger: 'talk',
      taskId: 't1',
      prompt: 'scenario:error',
    });
    expect(await ended(runId)).toMatchObject({ status: 'error', exitCode: 1 });
    expect(repository.getRun(runId)?.status).toBe('error');
  });

  it('ends a missing claude binary as error', async () => {
    const { repository, events } = setup();
    const runner = new CrewRunner({
      repository,
      claudeBin: path.join(os.tmpdir(), 'no-such-claude'),
      orderupDir: path.join(tmp('orderup-home-'), '.orderup'),
      onEvent: (e) => events.push(e),
    });
    runners.push(runner);
    const runId = await started(runner, { trigger: 'talk', taskId: 't1', prompt: 'x' });
    await waitFor(() => events.find((e) => e.type === 'run.ended' && e.runId === runId));
    expect(repository.getRun(runId)?.status).toBe('error');
  });

  it('records only its own share of a resumed session cost', async () => {
    const { runner, ended, repository } = setup();
    repository.startRun({ id: 'old', trigger: 'assign', chefSessionId: 'sess-prev' });
    repository.addUsage({ runId: 'old', costUsd: 1.5 });
    const runId = await started(runner, {
      trigger: 'send-back',
      taskId: 't1',
      prompt: 'scenario:resumed',
      resumeSessionId: 'sess-prev',
    });
    const end = await ended(runId);
    expect(end.usage.costUsd).toBeCloseTo(0.25);
    expect(repository.usageTotalForSession('sess-prev').costUsd).toBeCloseTo(1.75);
    expect(repository.getRun(runId)?.chefSessionId).toBe('sess-prev');
  });

  it('refuses bad task ids, session ids and a missing repo', async () => {
    const { runner, repository } = setup();
    expect(await runner.startRun({ trigger: 'talk', taskId: '../x', prompt: '' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(
      await runner.startRun({ trigger: 'talk', taskId: 't', prompt: '', resumeSessionId: '-x' }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    repository.updateBrigadeConfig({ repoPath: null });
    expect(await runner.startRun({ trigger: 'talk', taskId: 't', prompt: '' })).toMatchObject({
      ok: false,
      code: 'no_repo',
    });
  });

  it(`refuses a ${MAX_CONCURRENT_RUNS + 1}th run with busy, and a second run of a task`, async () => {
    const { runner } = setup();
    const ids = [];
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) {
      ids.push(
        await started(runner, { trigger: 'assign', taskId: `t${i}`, prompt: 'scenario:slow' }),
      );
    }
    expect(await runner.startRun({ trigger: 'assign', taskId: 't9', prompt: '' })).toMatchObject({
      ok: false,
      code: 'busy',
    });
    await runner.stop(ids[0]!);
    expect(await runner.startRun({ trigger: 'assign', taskId: 't1', prompt: '' })).toMatchObject({
      ok: false,
      code: 'busy',
    });
    // A slot is free again.
    await started(runner, { trigger: 'assign', taskId: 't9', prompt: 'scenario:slow' });
  });

  it('refuses a start once today reaches the daily cap', async () => {
    const { runner, repository, events } = setup({ dailyCapUsd: 2 });
    repository.startRun({ id: 'old', trigger: 'talk' });
    repository.addUsage({ runId: 'old', costUsd: 2 });
    expect(await runner.startRun({ trigger: 'talk', taskId: 't1', prompt: '' })).toMatchObject({
      ok: false,
      code: 'usage_cap_reached',
    });
    expect(events).toContainEqual({
      type: 'budget.exceeded',
      runId: null,
      capUsd: 2,
      spentUsd: 2,
    });
  });

  it('passes the remaining daily budget as --max-budget-usd, never below the floor', async () => {
    const budgetArg = (log: FakeLog) => log.args[log.args.indexOf('--max-budget-usd') + 1];
    const { runner, repository, ended, logs } = setup({ dailyCapUsd: 5 });
    repository.startRun({ id: 'old', trigger: 'talk' });
    repository.addUsage({ runId: 'old', costUsd: 1.25 });
    const first = await started(runner, { trigger: 'talk', taskId: 't1', prompt: 'scenario:ok' });
    await ended(first);
    expect(budgetArg(logs()[0]!)).toBe('3.75');

    // The ok run spent 0.25; then nearly all of the rest goes: the floor applies.
    repository.addUsage({ runId: 'old', costUsd: 3.499 });
    const second = await started(runner, { trigger: 'talk', taskId: 't2', prompt: 'scenario:ok' });
    await ended(second);
    expect(logs().map(budgetArg).sort()).toEqual([MIN_BUDGET_USD.toFixed(2), '3.75']);
  });

  it('omits --max-budget-usd when the daily cap is 0', async () => {
    const { runner, repository, ended, logs } = setup({ dailyCapUsd: 0 });
    repository.startRun({ id: 'old', trigger: 'talk' });
    repository.addUsage({ runId: 'old', costUsd: 12 });
    const runId = await started(runner, { trigger: 'talk', taskId: 't1', prompt: 'scenario:ok' });
    await ended(runId);
    expect(logs()[0]!.args).not.toContain('--max-budget-usd');
  });

  it('has no cap at 0', async () => {
    const { runner, repository, ended } = setup({ dailyCapUsd: 0 });
    repository.startRun({ id: 'old', trigger: 'talk' });
    repository.addUsage({ runId: 'old', costUsd: 1000 });
    const runId = await started(runner, { trigger: 'talk', taskId: 't1', prompt: 'scenario:ok' });
    expect((await ended(runId)).status).toBe('success');
  });

  it('kills a run that crosses the cap and reports it', async () => {
    const { runner, ended, events, repository, logs } = setup({ dailyCapUsd: 5 });
    const runId = await started(runner, {
      trigger: 'assign',
      taskId: 't1',
      prompt: 'scenario:expensive',
    });
    const end = await ended(runId);
    expect(end.status).toBe('usage_cap_reached');
    expect(events).toContainEqual({ type: 'budget.exceeded', runId, capUsd: 5, spentUsd: 10 });
    expect(repository.getRun(runId)?.status).toBe('stopped');
    expect(repository.usageTotalForDay(localDay(Date.now())).costUsd).toBe(10);
    expect(alive(logs()[0]!.pid)).toBe(false);
    // And the next one is refused.
    expect(await runner.startRun({ trigger: 'talk', taskId: 't2', prompt: '' })).toMatchObject({
      code: 'usage_cap_reached',
    });
  });

  it.runIf(posix)('stopAll kills every chef and its process group: no orphans', async () => {
    const { runner, logs, events } = setup();
    const ids = [
      await started(runner, { trigger: 'assign', taskId: 'a', prompt: 'scenario:slow' }),
      await started(runner, { trigger: 'assign', taskId: 'b', prompt: 'scenario:slow' }),
    ];
    const ready = await waitFor(() => {
      const all = logs();
      return all.length === 2 && all.every((l) => l.grandchild) ? all : undefined;
    }, 10_000);
    const pids = ready.flatMap((l) => [l.pid, l.grandchild!]);
    expect(pids.every(alive)).toBe(true);

    await runner.stopAll();
    await waitFor(() => pids.every((pid) => !alive(pid)) || undefined, 5000);
    for (const id of ids) {
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'run.ended', runId: id, status: 'stopped' }),
      );
    }
    expect(runner.activeRunIds).toEqual([]);
    expect(await runner.startRun({ trigger: 'talk', taskId: 'c', prompt: '' })).toMatchObject({
      code: 'busy',
    });
  });

  it.runIf(posix)('server close stops the runner', async () => {
    const { repo } = tempRepo();
    const dbPath = path.join(tmp('orderup-db-'), 'orderup.db');
    const logDir = tmp('orderup-fake-');
    const server = await startServer({
      port: 0,
      projectsDir: false,
      crew: true,
      dbPath,
      runner: { claudeBin: FAKE_CLAUDE, env: { ...process.env, FAKE_CLAUDE_LOG: logDir } },
    });
    let closed = false;
    try {
      const db = openDatabase(dbPath);
      new Repository(db).updateBrigadeConfig({ repoPath: repo });
      db.close();
      const result = await server.runner!.startRun({
        trigger: 'talk',
        taskId: 't1',
        prompt: 'scenario:slow',
      });
      expect(result).toMatchObject({ ok: true });
      const log = await waitFor(() => {
        const files = readdirSync(logDir).filter((f) => f.endsWith('.json'));
        if (!files.length) return undefined;
        const parsed = JSON.parse(readFileSync(path.join(logDir, files[0]!), 'utf8')) as FakeLog;
        return parsed.grandchild ? parsed : undefined;
      }, 10_000);
      await server.close();
      closed = true;
      await waitFor(() => (!alive(log.pid) && !alive(log.grandchild!)) || undefined, 5000);
    } finally {
      if (!closed) await server.close();
    }
  });
});

beforeEach(() => {
  // Fixtures spawn the fake by path: it must stay executable.
  if (posix) expect(statSync(FAKE_CLAUDE).mode & 0o111).not.toBe(0);
});
