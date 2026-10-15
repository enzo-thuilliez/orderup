import type { Server } from 'node:http';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type CommandError,
  type CrewCommandReply,
  type ServerMessage,
} from 'orderup-shared';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { createCrewChannel, isCrewCommandMessage } from './crew/channel.js';
import type { CrewController } from './crew/controller.js';
import type { Guard } from './http.js';
import type { SessionStore } from './sessions/store.js';

export interface KitchenSocketOptions {
  store: SessionStore;
  guard: Guard;
  serverVersion: string;
  /** The command token, or `null` without `--crew`: crew commands then get `crew_disabled`. */
  crewToken: string | null;
  crewController: CrewController;
}

/**
 * `/ws`: `hello` and `snapshot` on connect, then `session.upsert` / `session.remove`.
 * Crew commands (`talk`, `assign`, ...) go through the per-connection command channel
 * (ADR-015). The reserved V0 `command` message still gets `not_implemented`.
 */
export function attachWebSocket(
  server: Server,
  { store, guard, serverVersion, crewToken, crewController }: KitchenSocketOptions,
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
    const crew = createCrewChannel({ token: crewToken, controller: crewController });
    ws.on('message', (data) => {
      const message = parseClientMessage(data);
      if (!message) return;
      if (isCrewCommandMessage(message)) {
        void crew(message).then((reply) => send(ws, reply));
        return;
      }
      const reply = handleLegacyCommand(message);
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

function parseClientMessage(data: RawData): Record<string, unknown> | null {
  let message: unknown;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  return message as Record<string, unknown>;
}

function handleLegacyCommand(message: Record<string, unknown>): ServerMessage | null {
  const { type, id, command } = message as Partial<ClientMessage>;
  if (typeof id !== 'string') return null;
  const error: CommandError =
    type === 'command' && typeof command === 'object' && command !== null && 'name' in command
      ? 'not_implemented'
      : 'invalid';
  return { type: 'command.result', id, ok: false, error };
}

function send(ws: WebSocket, message: ServerMessage | CrewCommandReply): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
