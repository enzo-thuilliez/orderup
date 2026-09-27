import type { Server } from 'node:http';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type CommandError,
  type ServerMessage,
} from 'orderup-shared';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Guard } from './http.js';
import type { SessionStore } from './sessions/store.js';

export interface KitchenSocketOptions {
  store: SessionStore;
  guard: Guard;
  serverVersion: string;
}

/**
 * `/ws`: `hello` and `snapshot` on connect, then `session.upsert` / `session.remove`.
 * Commands are reserved until crew lands (ADR-008): every one gets `not_implemented`.
 */
export function attachWebSocket(
  server: Server,
  { store, guard, serverVersion }: KitchenSocketOptions,
): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (
      pathname !== '/ws' ||
      !guard.hostOk(req.headers.host) ||
      !guard.originOk(req.headers.origin)
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    ws.on('error', () => ws.terminate());
    send(ws, { type: 'hello', protocol: PROTOCOL_VERSION, serverVersion });
    send(ws, { type: 'snapshot', sessions: store.snapshot() });
    ws.on('message', (data) => {
      const reply = handleClientMessage(data);
      if (reply) send(ws, reply);
    });
  });

  const unsubscribe = store.subscribe((change) => {
    const message: ServerMessage =
      change.type === 'upsert'
        ? { type: 'session.upsert', session: change.session }
        : { type: 'session.remove', sessionId: change.sessionId };
    const text = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  });

  return {
    close() {
      unsubscribe();
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}

function handleClientMessage(data: RawData): ServerMessage | null {
  let message: unknown;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (typeof message !== 'object' || message === null) return null;
  const { type, id, command } = message as Partial<ClientMessage>;
  if (typeof id !== 'string') return null;
  const error: CommandError =
    type === 'command' && typeof command === 'object' && command !== null && 'name' in command
      ? 'not_implemented'
      : 'invalid';
  return { type: 'command.result', id, ok: false, error };
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
