import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  startServer,
  type CrewController,
  type CrewRequest,
  type RunningServer,
} from 'orderup-server';
import { createCrewChannel } from '../src/crew/channel.js';
import { connect, rawRequest, waitFor } from './helpers.js';

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
      const { port } = await start({ crewController: controller });
      const k = await kitchen(port);
      k.send(talk('r1', { token: 'anything' }));
      k.send({ type: 'stop', requestId: 'r2', to: 'head-chef', token: 'x' });
      expectError(await k.reply('r1'), 'crew_disabled', 'talk');
      expectError(await k.reply('r2'), 'crew_disabled', 'stop');
      expect(controller.calls).toEqual([]);
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

    it('answers crew_disabled from the stub controller until the runner is wired', async () => {
      const { port } = await start({ crew: true });
      const k = await kitchen(port);
      k.send(talk('r1', { token: token() }));
      expectError(await k.reply('r1'), 'crew_disabled', 'talk');
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
