import { PROTOCOL_VERSION } from 'orderup-shared';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from 'orderup-server';

describe('startServer', () => {
  let server: RunningServer | undefined;
  afterEach(() => server?.close());

  it('binds to 127.0.0.1 and answers /health', async () => {
    server = await startServer({ port: 0 });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, protocol: PROTOCOL_VERSION });
  });

  it('returns 404 for unknown routes', async () => {
    server = await startServer({ port: 0 });
    const res = await fetch(`${server.url}/nope`);
    expect(res.status).toBe(404);
  });
});
