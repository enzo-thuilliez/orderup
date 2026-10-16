import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COMMAND_TOKEN_META,
  type CrewCommandReply,
  type CrewCommandType,
  type CrewError,
} from 'orderup-shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  CREW_RATE_LIMIT,
  crewError,
  defaultTokenPath,
  isValidTaskId,
  MAX_CONCURRENT_RUNS,
  openDatabase,
  Repository,
  startServer,
  type BrigadeConfigPatch,
  type CrewController,
  type CrewRequest,
  type RunningServer,
} from 'orderup-server';
import { createCrewChannel } from '../src/crew/channel.js';
import {
  alive,
  connect,
  FAKE_CLAUDE,
  rawRequest,
  tempRepo,
  tmp,
  waitFor,
  type FakeLog,
} from './helpers.js';

/** Records what reaches it and acks everything. */
class SpyController implements CrewController {
  calls: CrewRequest[] = [];
  talk(request: CrewRequest<'talk'>) {
    this.calls.push(request);
    return Promise.resolve({
      type: 'ack' as const,
      requestId: request.requestId,
      command: 'talk' as const,
      runId: 'run-1',
    });
  }
  assign(request: CrewRequest<'assign'>) {
    this.calls.push(request);
    return Promise.resolve({
      type: 'ack' as const,
      requestId: request.requestId,
      command: 'assign' as const,
      runId: 'run-2',
      cardId: 'card-1',
    });
  }
  stop(request: CrewRequest<'stop'>) {
    this.calls.push(request);
    return Promise.resolve({
      type: 'ack' as const,
      requestId: request.requestId,
      command: 'stop' as const,
      runId: null,
    });
  }
  approve(request: CrewRequest<'approve'>) {
    this.calls.push(request);
    return Promise.resolve(crewError(request.requestId, 'approve', 'unknown_card', 'no card'));
  }
  sendBack(request: CrewRequest<'send-back'>) {
    this.calls.push(request);
    return Promise.resolve(crewError(request.requestId, 'send-back', 'unknown_card', 'no card'));
  }
}

describe('crew command channel', () => {
  let server: RunningServer | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await server?.close();
    server = undefined;
  });

  async function start(options: Parameters<typeof startServer>[0] = {}) {
    server = await startServer({ port: 0, projectsDir: false, ...options });
    return server;
  }

  async function kitchen(port: number) {
    const client = await connect(port);
    sockets.push(client.ws);
    const replies = client.messages as unknown as CrewCommandReply[];
    const isReply = (m: { type: string }) => m.type === 'ack' || m.type === 'error';
    return {
      send(message: Record<string, unknown>) {
        client.ws.send(JSON.stringify(message));
      },
      async reply(requestId: string): Promise<CrewCommandReply> {
        return waitFor(() => replies.find((m) => isReply(m) && m.requestId === requestId));
      },
      replies: () => replies.filter(isReply),
    };
  }

  const token = () => readFileSync(defaultTokenPath(), 'utf8').trim();
  const dbFile = () => path.join(tmp('orderup-db-'), 'orderup.db');

  const talk = (requestId: string, extra: Record<string, unknown> = {}) => ({
    type: 'talk',
    requestId,
    to: 'head-chef',
    text: 'make the soup',
    ...extra,
  });

  function expectError(reply: CrewCommandReply, code: CrewError['code'], command: CrewCommandType) {
    expect(reply).toMatchObject({ type: 'error', code, command });
  }

  describe('without --crew', () => {
    it('answers every crew command with crew_disabled and writes no token', async () => {
      const controller = new SpyController();
      const { port, runner } = await start({ crewController: controller });
      const k = await kitchen(port);
      const commands = [
        talk('r1'),
        { type: 'assign', requestId: 'r2', to: 'head-chef', ticket: { repo: 'o/r', number: 1 } },
        { type: 'stop', requestId: 'r3', to: 'head-chef' },
        { type: 'approve', requestId: 'r4', to: 'head-chef', cardId: 'c' },
        { type: 'send-back', requestId: 'r5', to: 'head-chef', cardId: 'c', comment: 'salt' },
      ];
      for (const command of commands) k.send({ ...command, token: 'anything' });
      for (const command of commands) {
        expectError(
          await k.reply(command.requestId),
          'crew_disabled',
          command.type as CrewCommandType,
        );
      }
      expect(controller.calls).toEqual([]);
      expect(runner).toBeNull();
      expect(existsSync(defaultTokenPath())).toBe(false);
    });

    it('serves the kitchen page without a token', async () => {
      const webRoot = mkdtempSync(path.join(os.tmpdir(), 'orderup-web-'));
      writeFileSync(path.join(webRoot, 'index.html'), '<html><head></head><body></body></html>');
      const { port } = await start({ webRoot });
      const res = await rawRequest(port, { path: '/' });
      expect(res.body).not.toContain(COMMAND_TOKEN_META);
    });
  });

  describe('with --crew', () => {
    it.skipIf(process.platform === 'win32')(
      'writes a fresh 32-byte token readable by the user only, and removes it on close',
      async () => {
        await start({ crew: true });
        const first = token();
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(statSync(defaultTokenPath()).mode & 0o777).toBe(0o600);
        expect(statSync(path.dirname(defaultTokenPath())).mode & 0o077).toBe(0);

        await server?.close();
        server = undefined;
        expect(existsSync(defaultTokenPath())).toBe(false);

        await start({ crew: true });
        expect(token()).not.toBe(first);
      },
    );

    it('replaces a token file left with loose permissions', async () => {
      const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'orderup-tok-')), 'command-token');
      writeFileSync(file, 'stale', { mode: 0o644 });
      await start({ crew: true, commandTokenFile: file });
      expect(readFileSync(file, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it('refuses to start crew when the token file cannot be written', async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'orderup-tok-'));
      writeFileSync(path.join(dir, 'not-a-dir'), '');
      await expect(
        start({ crew: true, commandTokenFile: path.join(dir, 'not-a-dir', 'command-token') }),
      ).rejects.toThrow(/cannot write the crew command token/);
    });

    it('injects the token into the kitchen page, uncached, and never into a URL', async () => {
      const webRoot = mkdtempSync(path.join(os.tmpdir(), 'orderup-web-'));
      writeFileSync(
        path.join(webRoot, 'index.html'),
        '<html><head><title>OrderUp</title></head><body></body></html>',
      );
      const { port } = await start({ crew: true, webRoot });
      for (const p of ['/', '/index.html', '/some/route']) {
        const res = await rawRequest(port, { path: p });
        expect(res.status).toBe(200);
        expect(res.body).toContain(`<meta name="${COMMAND_TOKEN_META}" content="${token()}" />`);
      }
      const health = await rawRequest(port, { path: '/health' });
      expect(health.body).not.toContain(token());
    });

    it('rejects a command without a token', async () => {
      const controller = new SpyController();
      const { port } = await start({ crew: true, crewController: controller });
      const k = await kitchen(port);
      k.send(talk('r1'));
      expectError(await k.reply('r1'), 'unauthorized', 'talk');
      expect(controller.calls).toEqual([]);
    });

    it('rejects a command with a wrong token', async () => {
      const controller = new SpyController();
      const { port } = await start({ crew: true, crewController: controller });
      const k = await kitchen(port);
      const good = token();
      k.send(talk('r1', { token: 'f'.repeat(64) }));
      k.send(talk('r2', { token: good.slice(0, -1) }));
      k.send(talk('r3', { token: 42 }));
      expectError(await k.reply('r1'), 'unauthorized', 'talk');
      expectError(await k.reply('r2'), 'unauthorized', 'talk');
      expectError(await k.reply('r3'), 'unauthorized', 'talk');
      expect(controller.calls).toEqual([]);
    });

    it('never lets a foreign Origin open the channel', async () => {
      const controller = new SpyController();
      const { port } = await start({ crew: true, crewController: controller });
      await expect(connect(port, 'https://evil.example')).rejects.toThrow(/403/);
      expect(controller.calls).toEqual([]);
    });

    it('rejects a command addressed to a cook with chef_only', async () => {
      const controller = new SpyController();
      const { port } = await start({ crew: true, crewController: controller });
      const k = await kitchen(port);
      k.send(talk('r1', { token: token(), to: 'hot' }));
      expectError(await k.reply('r1'), 'chef_only', 'talk');
      expect(controller.calls).toEqual([]);
    });

    it('rejects unknown fields with invalid_command', async () => {
      const controller = new SpyController();
      const { port } = await start({ crew: true, crewController: controller });
      const k = await kitchen(port);
      k.send(talk('r1', { token: token(), memberId: 'm1' }));
      k.send({ type: 'assign', requestId: 'r2', to: 'head-chef', token: token(), ticket: 'x' });
      expectError(await k.reply('r1'), 'invalid_command', 'talk');
      expectError(await k.reply('r2'), 'invalid_command', 'assign');
      expect(controller.calls).toEqual([]);
    });

    it('routes valid commands to the controller without their token', async () => {
      const controller = new SpyController();
      const { port } = await start({ crew: true, crewController: controller });
      const k = await kitchen(port);
      const t = token();
      k.send(talk('r1', { token: t }));
      k.send({
        type: 'assign',
        requestId: 'r2',
        to: 'head-chef',
        token: t,
        ticket: { repo: 'o/r', number: 20 },
      });
      k.send({ type: 'stop', requestId: 'r3', to: 'head-chef', token: t });
      k.send({
        type: 'send-back',
        requestId: 'r4',
        to: 'head-chef',
        token: t,
        cardId: 'c',
        comment: 'more salt',
      });

      expect(await k.reply('r1')).toEqual({
        type: 'ack',
        requestId: 'r1',
        command: 'talk',
        runId: 'run-1',
      });
      expect(await k.reply('r2')).toMatchObject({
        type: 'ack',
        command: 'assign',
        cardId: 'card-1',
      });
      expect(await k.reply('r3')).toMatchObject({ type: 'ack', command: 'stop', runId: null });
      expectError(await k.reply('r4'), 'unknown_card', 'send-back');
      expect(controller.calls).toEqual([
        { type: 'talk', requestId: 'r1', to: 'head-chef', text: 'make the soup' },
        { type: 'assign', requestId: 'r2', to: 'head-chef', ticket: { repo: 'o/r', number: 20 } },
        { type: 'stop', requestId: 'r3', to: 'head-chef' },
        { type: 'send-back', requestId: 'r4', to: 'head-chef', cardId: 'c', comment: 'more salt' },
      ]);
    });

    it('drives the crew runner by default: no working repo is invalid_command', async () => {
      const { port, runner } = await start({ crew: true, dbPath: dbFile() });
      const k = await kitchen(port);
      k.send(talk('r1', { token: token() }));
      expect(await k.reply('r1')).toMatchObject({
        type: 'error',
        command: 'talk',
        code: 'invalid_command',
        message: expect.stringMatching(/no working repo/),
      });
      expect(runner?.activeRunIds).toEqual([]);
    });

    it('rate-limits crew commands per connection', async () => {
      const controller = new SpyController();
      const { port } = await start({ crew: true, crewController: controller });
      const k = await kitchen(port);
      const t = token();
      const total = CREW_RATE_LIMIT + 3;
      for (let i = 0; i < total; i++) k.send(talk(`r${i}`, { token: t }));
      await waitFor(() => k.replies().length === total || undefined);
      const limited = k.replies().filter((r) => r.type === 'error' && r.code === 'rate_limited');
      expect(limited).toHaveLength(3);
      expect(controller.calls).toHaveLength(CREW_RATE_LIMIT);

      // A second connection has its own budget.
      const other = await kitchen(port);
      other.send(talk('o1', { token: t }));
      expect(await other.reply('o1')).toMatchObject({ type: 'ack' });
    });

    it('keeps the reserved V0 command answering not_implemented', async () => {
      const { port } = await start({ crew: true });
      const client = await connect(port);
      sockets.push(client.ws);
      client.ws.send(
        JSON.stringify({ type: 'command', id: 'c1', command: { name: 'crew.spawn' } }),
      );
      const result = await waitFor(() => client.messages.find((m) => m.type === 'command.result'));
      expect(result).toEqual({
        type: 'command.result',
        id: 'c1',
        ok: false,
        error: 'not_implemented',
      });
    });
  });
});

describe('crew commands through the runner', () => {
  let server: RunningServer | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await server?.close();
    server = undefined;
  });

  /**
   * A `--crew` server over the fake claude and a temp repo. `seed` runs on the database before
   * the server opens it.
   */
  async function kitchen(
    config: BrigadeConfigPatch = {},
    seed: (repository: Repository) => void = () => undefined,
  ) {
    const { repo } = tempRepo();
    const dbPath = path.join(tmp('orderup-db-'), 'orderup.db');
    const db = openDatabase(dbPath);
    const repository = new Repository(db);
    repository.updateBrigadeConfig({ repoPath: repo, ...config });
    seed(repository);
    db.close();
    const logDir = tmp('orderup-fake-');
    server = await startServer({
      port: 0,
      projectsDir: false,
      crew: true,
      dbPath,
      runner: {
        claudeBin: FAKE_CLAUDE,
        env: { ...process.env, FAKE_CLAUDE_LOG: logDir },
        orderupDir: path.join(tmp('orderup-home-'), '.orderup'),
      },
    });
    const running = server;
    const client = await connect(running.port);
    sockets.push(client.ws);
    const replies = client.messages as unknown as CrewCommandReply[];
    const t = readFileSync(defaultTokenPath(), 'utf8').trim();
    let n = 0;
    const logs = (): FakeLog[] =>
      readdirSync(logDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(path.join(logDir, f), 'utf8')) as FakeLog);
    return {
      runner: running.runner!,
      logs,
      /** The fake's log of one run, once it has one (and, with `grandchild`, once it spawned). */
      log: (match: (log: FakeLog) => boolean) => waitFor(() => logs().find(match), 10_000),
      async send(command: Record<string, unknown>): Promise<CrewCommandReply> {
        const [reply] = await this.sendAll([command]);
        return reply!;
      },
      /** Sends every command before waiting for any reply; replies in sending order. */
      sendAll(commands: Record<string, unknown>[]): Promise<CrewCommandReply[]> {
        const ids = commands.map((command) => {
          const requestId = `r${++n}`;
          client.ws.send(JSON.stringify({ to: 'head-chef', token: t, ...command, requestId }));
          return requestId;
        });
        return Promise.all(
          ids.map((requestId) =>
            waitFor(
              () => replies.find((m) => 'requestId' in m && m.requestId === requestId),
              10_000,
            ),
          ),
        );
      },
      idle: () => waitFor(() => running.runner!.activeRunIds.length === 0 || undefined, 10_000),
    };
  }

  /** The fake picks its scenario from the prompt, and an assign prompt names the ticket repo. */
  const slowAssign = (number: number) => ({
    type: 'assign',
    ticket: { repo: 'o/scenario:slow', number },
  });
  const arg = (log: FakeLog, flag: string) =>
    log.args.includes(flag) ? log.args[log.args.indexOf(flag) + 1] : undefined;
  const runIdOf = (reply: CrewCommandReply) => {
    if (reply.type !== 'ack' || !('runId' in reply) || !reply.runId) {
      throw new Error(`no runId: ${JSON.stringify(reply)}`);
    }
    return reply.runId;
  };

  it('talk starts a chef run with a fresh task and acks its runId', async () => {
    const k = await kitchen({ stationCap: 3, globalCap: 7 });
    const reply = await k.send({ type: 'talk', text: 'scenario:ok make the soup' });
    expect(reply).toEqual({
      type: 'ack',
      requestId: 'r1',
      command: 'talk',
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    const log = await k.log(() => true);
    // The user's text on stdin, the chef's instructions as --append-system-prompt.
    expect(log.prompt).toBe('scenario:ok make the soup');
    expect(log.args).not.toContain('scenario:ok make the soup');
    const taskId = path.basename(log.cwd);
    expect(taskId).toMatch(/^t_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isValidTaskId(taskId)).toBe(true);
    const system = arg(log, '--append-system-prompt')!;
    expect(system).toContain(taskId);
    expect(system).toContain('At most 3 cooks at the same station');
    expect(system).toContain('At most 7 cooks in total');
    expect(arg(log, '--resume')).toBeUndefined();
    await k.idle();
  });

  it('a second talk resumes the chef session of the first, in a new task', async () => {
    const k = await kitchen();
    runIdOf(await k.send({ type: 'talk', text: 'scenario:ok first' }));
    const first = await k.log((l) => l.prompt.endsWith('first'));
    await k.idle();
    runIdOf(await k.send({ type: 'talk', text: 'scenario:ok second' }));
    const second = await k.log((l) => l.prompt.endsWith('second'));
    expect(arg(second, '--resume')).toBe(`sess-${first.pid}`);
    expect(path.basename(second.cwd)).not.toBe(path.basename(first.cwd));
    await k.idle();
  });

  it('assign acks a runId and cardId = taskId, and only names the ticket', async () => {
    const k = await kitchen();
    const reply = await k.send({ type: 'assign', ticket: { repo: 'o/r', number: 20 } });
    expect(reply).toMatchObject({ type: 'ack', command: 'assign', runId: expect.any(String) });
    const log = await k.log(() => true);
    expect(reply).toMatchObject({ cardId: path.basename(log.cwd) });
    expect(log.prompt).toContain('o/r#20');
    expect(log.prompt).toContain('gh issue view 20 --repo o/r');
    expect(arg(log, '--append-system-prompt')).toContain(path.basename(log.cwd));
    await k.idle();
  });

  it.skipIf(process.platform === 'win32')(
    'stop kills the running chef and acks its runId; with nothing running it acks null',
    async () => {
      const k = await kitchen();
      const runId = runIdOf(await k.send({ type: 'talk', text: 'scenario:slow' }));
      const log = await k.log((l) => l.grandchild !== null);
      expect(alive(log.pid)).toBe(true);
      expect(await k.send({ type: 'stop' })).toMatchObject({ type: 'ack', command: 'stop', runId });
      expect(alive(log.pid)).toBe(false);
      await waitFor(() => !alive(log.grandchild!) || undefined, 5000);
      expect(k.runner.activeRunIds).toEqual([]);
      expect(await k.send({ type: 'stop' })).toMatchObject({
        type: 'ack',
        command: 'stop',
        runId: null,
      });
    },
  );

  it('stop picks the most recently started run', async () => {
    const k = await kitchen();
    const older = runIdOf(await k.send({ type: 'talk', text: 'scenario:slow older' }));
    const newer = runIdOf(await k.send(slowAssign(1)));
    expect(await k.send({ type: 'stop' })).toMatchObject({ runId: newer });
    expect(k.runner.activeRunIds).toEqual([older]);
  });

  it('a second talk during an active talk is busy, and starts nothing', async () => {
    const k = await kitchen();
    runIdOf(await k.send({ type: 'talk', text: 'scenario:slow first' }));
    expect(await k.send({ type: 'talk', text: 'scenario:slow second' })).toEqual({
      type: 'error',
      requestId: 'r2',
      command: 'talk',
      code: 'busy',
      message: 'the head chef is still answering',
    });
    await k.log((l) => l.prompt.endsWith('first'));
    expect(k.runner.activeRunIds).toHaveLength(1);
    expect(k.logs().map((l) => l.prompt)).toEqual(['scenario:slow first']);
  });

  it('two talks sent at the same time start one run; the other is busy', async () => {
    const k = await kitchen();
    const replies = await k.sendAll([
      { type: 'talk', text: 'scenario:slow a' },
      { type: 'talk', text: 'scenario:slow b' },
    ]);
    expect(replies.map((r) => (r.type === 'ack' ? 'ack' : r.code)).sort()).toEqual(['ack', 'busy']);
    expect(k.runner.activeRunIds).toHaveLength(1);
  });

  it('a talk during an active assign starts and resumes the latest talk session', async () => {
    const k = await kitchen();
    runIdOf(await k.send({ type: 'talk', text: 'scenario:ok first' }));
    const first = await k.log((l) => l.prompt.endsWith('first'));
    await k.idle();
    const assign = runIdOf(await k.send(slowAssign(7)));
    await k.log((l) => l.grandchild !== null);
    expect(k.runner.activeRunIds).toEqual([assign]);
    const talkRun = runIdOf(await k.send({ type: 'talk', text: 'scenario:ok again' }));
    const again = await k.log((l) => l.prompt.endsWith('again'));
    expect(arg(again, '--resume')).toBe(`sess-${first.pid}`);
    expect(talkRun).not.toBe(assign);
  });

  it(`a talk while ${MAX_CONCURRENT_RUNS} assigns run gets the runner's busy`, async () => {
    const k = await kitchen();
    for (let i = 1; i <= MAX_CONCURRENT_RUNS; i++) runIdOf(await k.send(slowAssign(i)));
    expect(await k.send({ type: 'talk', text: 'scenario:slow extra' })).toMatchObject({
      type: 'error',
      command: 'talk',
      code: 'busy',
      message: `already ${MAX_CONCURRENT_RUNS} chef runs`,
    });
  });

  it('a talk over the daily cap gets usage_cap_reached', async () => {
    const k = await kitchen({ dailyCapUsd: 2 }, (repository) => {
      repository.startRun({ id: 'old', trigger: 'talk' });
      repository.addUsage({ runId: 'old', costUsd: 2 });
    });
    expect(await k.send({ type: 'talk', text: 'scenario:ok' })).toMatchObject({
      type: 'error',
      command: 'talk',
      code: 'usage_cap_reached',
    });
    expect(k.logs()).toEqual([]);
  });

  it('approve and send-back know no card yet', async () => {
    const k = await kitchen();
    expect(await k.send({ type: 'approve', cardId: 't_1' })).toMatchObject({
      type: 'error',
      command: 'approve',
      code: 'unknown_card',
    });
    expect(await k.send({ type: 'send-back', cardId: 't_1', comment: 'salt' })).toMatchObject({
      type: 'error',
      command: 'send-back',
      code: 'unknown_card',
    });
    expect(k.logs()).toEqual([]);
  });
});

describe('createCrewChannel rate limit', () => {
  it('frees a slot once a command is older than a second', async () => {
    let now = 0;
    const channel = createCrewChannel({
      token: 't',
      controller: new SpyController(),
      now: () => now,
    });
    const cmd = (i: number) => ({ type: 'stop', requestId: `r${i}`, to: 'head-chef', token: 't' });
    for (let i = 0; i < CREW_RATE_LIMIT; i++) {
      expect(await channel(cmd(i))).toMatchObject({ type: 'ack' });
    }
    expect(await channel(cmd(99))).toMatchObject({ type: 'error', code: 'rate_limited' });
    now = 999;
    expect(await channel(cmd(100))).toMatchObject({ type: 'error', code: 'rate_limited' });
    now = 1000;
    expect(await channel(cmd(101))).toMatchObject({ type: 'ack' });
  });
});
