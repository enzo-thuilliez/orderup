import { request } from 'node:http';
import type { ServerMessage } from 'orderup-shared';
import { WebSocket } from 'ws';

export interface RawResponse {
  status: number;
  body: string;
}

/** Plain node:http request, so tests can set Host and Origin freely. */
export function rawRequest(
  port: number,
  {
    method = 'GET',
    path = '/',
    headers = {},
    body,
  }: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

export function postHook(port: number, payload: unknown): Promise<RawResponse> {
  return rawRequest(port, {
    method: 'POST',
    path: '/hook',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function waitFor<T>(check: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Opens a kitchen socket and records every server message. */
export async function connect(
  port: number,
  origin = `http://127.0.0.1:${port}`,
): Promise<{ ws: WebSocket; messages: ServerMessage[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  const messages: ServerMessage[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages };
}
