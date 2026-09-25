import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION, type ServerMessage } from 'orderup-shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type RunningServer } from 'orderup-server';
import { connect, postHook, rawRequest, waitFor } from './helpers.js';

describe('startServer', () => {
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

  async function kitchen(port: number, origin?: string) {
    const client = await connect(port, origin);
    sockets.push(client.ws);
    return client;
  }

  it('binds to 127.0.0.1 and answers /health', async () => {
    const { port, url } = await start();
    expect(url).toBe(`http://127.0.0.1:${port}`);
    const res = await rawRequest(port, { path: '/health' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, protocol: PROTOCOL_VERSION });
  });

  it('streams hello, snapshot, then upserts driven by hooks', async () => {
    const { port } = await start();
    const { messages } = await kitchen(port);
    await waitFor(() => messages.length >= 2 || undefined);
    expect(messages[0]).toMatchObject({ type: 'hello', protocol: PROTOCOL_VERSION });
    expect(messages[1]).toEqual({ type: 'snapshot', sessions: [] });

    const res = await postHook(port, {
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      cwd: '/code/app',
      tool_name: 'Edit',
      tool_input: { file_path: '/code/app/src/oven.ts' },
    });
    expect(res.status).toBe(204);

    const upsert = await waitFor(() =>
      messages.find(
        (m): m is Extract<ServerMessage, { type: 'session.upsert' }> => m.type === 'session.upsert',
      ),
    );
    expect(upsert.session).toMatchObject({
      sessionId: 's1',
      state: 'working',
      activity: { tool: 'Edit', target: 'src/oven.ts' },
    });

    await postHook(port, { session_id: 's1', hook_event_name: 'SessionEnd' });
    await waitFor(() => messages.find((m) => m.type === 'session.remove'));
  });

  it('includes existing sessions in the snapshot', async () => {
    const { port } = await start();
    await postHook(port, { session_id: 's1', hook_event_name: 'Stop', cwd: '/x' });
    const { messages } = await kitchen(port);
    const snapshot = await waitFor(() => messages.find((m) => m.type === 'snapshot'));
    expect(snapshot).toMatchObject({ sessions: [{ sessionId: 's1', state: 'done' }] });
  });

  it('answers every command with not_implemented, and malformed ones with invalid', async () => {
    const { port } = await start();
    const { ws, messages } = await kitchen(port);
    ws.send(
      JSON.stringify({
        type: 'command',
        id: 'c1',
        command: { name: 'crew.message', agentId: 'a', text: 'hi' },
      }),
    );
    ws.send(JSON.stringify({ type: 'nope', id: 'c2' }));
    ws.send('not json');
    await waitFor(
      () => messages.filter((m) => m.type === 'command.result').length === 2 || undefined,
    );
    expect(messages.filter((m) => m.type === 'command.result')).toEqual([
      { type: 'command.result', id: 'c1', ok: false, error: 'not_implemented' },
      { type: 'command.result', id: 'c2', ok: false, error: 'invalid' },
    ]);
  });

  describe('Host and Origin checks', () => {
    it('rejects a foreign Host (DNS rebinding)', async () => {
      const { port } = await start();
      const res = await rawRequest(port, {
        path: '/health',
        headers: { host: `evil.example:${port}` },
      });
      expect(res.status).toBe(403);
    });

    it('rejects a foreign Origin on HTTP and accepts localhost', async () => {
      const { port } = await start();
      const evil = await postHookWith(port, 'https://evil.example');
      expect(evil.status).toBe(403);
      const local = await postHookWith(port, `http://localhost:${port}`);
      expect(local.status).toBe(204);
    });

    it('rejects a foreign Origin on the WebSocket', async () => {
      const { port } = await start();
      await expect(connect(port, 'https://evil.example')).rejects.toThrow(/403/);
    });

    it('accepts extra allowed origins (Vite dev server)', async () => {
      const { port } = await start({ allowedOrigins: ['http://localhost:5173'] });
      const { ws } = await kitchen(port, 'http://localhost:5173');
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('requires JSON for hooks and caps the body size', async () => {
      const { port } = await start();
      const form = await rawRequest(port, {
        method: 'POST',
        path: '/hook',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      });
      expect(form.status).toBe(415);
      const bad = await rawRequest(port, {
        method: 'POST',
        path: '/hook',
        headers: { 'content-type': 'application/json' },
        body: '{nope',
      });
      expect(bad.status).toBe(400);
      const huge = await rawRequest(port, {
        method: 'POST',
        path: '/hook',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(9 * 1024 * 1024),
      }).catch(() => ({ status: 413 }));
      expect(huge.status).toBe(413);
    });
  });

  it('serves the built web app with SPA fallback and no path traversal', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orderup-web-'));
    mkdirSync(path.join(root, 'assets'));
    writeFileSync(path.join(root, 'index.html'), '<title>OrderUp</title>');
    writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
    const { port } = await start({ webRoot: root });

    expect((await rawRequest(port, { path: '/' })).body).toContain('OrderUp');
    expect((await rawRequest(port, { path: '/assets/app.js' })).body).toBe('console.log(1)');
    expect((await rawRequest(port, { path: '/walk' })).body).toContain('OrderUp');
    expect((await rawRequest(port, { path: '/missing.js' })).status).toBe(404);
    // Dot segments are normalized by URL parsing; encoded slashes reach the traversal check.
    const traversal = await rawRequest(port, { path: '/..%2f..%2f..%2fetc%2fpasswd' });
    expect(traversal.status).toBe(404);
    expect(traversal.body).not.toContain('root:');
  });

  it('feeds transcripts into the store', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orderup-projects-'));
    mkdirSync(path.join(dir, 'p'));
    writeFileSync(
      path.join(dir, 'p', 't1.jsonl'),
      JSON.stringify({
        type: 'user',
        sessionId: 't1',
        cwd: '/x',
        timestamp: new Date().toISOString(),
        message: { content: 'hi' },
      }) + '\n',
    );
    const { store } = await start({ projectsDir: dir });
    await waitFor(() => store.get('t1'));
    expect(store.get('t1')?.state).toBe('working');
  });
});

function postHookWith(port: number, origin: string) {
  return rawRequest(port, {
    method: 'POST',
    path: '/hook',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }),
  });
}
