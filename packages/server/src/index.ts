import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_PORT, PROTOCOL_VERSION } from 'orderup-shared';

export interface ServerOptions {
  port?: number;
  host?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Stub: serves GET /health only. Hook intake, transcript tail and the WebSocket
 * arrive with feat(server).
 */
export async function startServer({
  port = DEFAULT_PORT,
  host = '127.0.0.1',
}: ServerOptions = {}): Promise<RunningServer> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const actualPort = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
