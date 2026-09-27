import type { ServerMessage } from 'orderup-shared';
import { describe, expect, it } from 'vitest';
import { Connection, reconnectDelay, socketUrl, type SocketLike } from '../src/net/connection';
import type { ConnectionStatus } from '../src/net/store';

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  onmessage: SocketLike['onmessage'] = null;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const statuses: ConnectionStatus[] = [];
  const messages: ServerMessage[] = [];
  const conn = new Connection({
    url: 'ws://127.0.0.1:7717/ws',
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
  });
  return { conn, sockets, timers, statuses, messages };
}

describe('reconnectDelay', () => {
  it('backs off exponentially up to 10 s', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(reconnectDelay)).toEqual([
      500, 1000, 2000, 4000, 8000, 10000, 10000,
    ]);
  });
});

describe('socketUrl', () => {
  it('uses the page origin', () => {
    expect(socketUrl({ protocol: 'http:', host: '127.0.0.1:7717' })).toBe('ws://127.0.0.1:7717/ws');
    expect(socketUrl({ protocol: 'https:', host: 'localhost:5173' })).toBe(
      'wss://localhost:5173/ws',
    );
  });
});

describe('Connection', () => {
  it('forwards valid messages and drops junk', () => {
    const { conn, sockets, messages, statuses } = setup();
    conn.start();
    sockets[0]!.open();
    sockets[0]!.receive('{"type":"session.remove","sessionId":"a"}');
    sockets[0]!.receive('garbage');
    expect(messages).toEqual([{ type: 'session.remove', sessionId: 'a' }]);
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('reconnects with backoff and resets after a successful open', () => {
    const { conn, sockets, timers, statuses } = setup();
    conn.start();
    sockets[0]!.drop();
    expect(statuses.at(-1)).toBe('closed');
    expect(timers.map((t) => t.ms)).toEqual([500]);
    timers[0]!.fn();
    sockets[1]!.drop();
    expect(timers.map((t) => t.ms)).toEqual([500, 1000]);
    timers[1]!.fn();
    sockets[2]!.open();
    sockets[2]!.drop();
    expect(timers.at(-1)!.ms).toBe(500);
    expect(sockets).toHaveLength(3);
  });

  it('sends only while open', () => {
    const { conn, sockets } = setup();
    conn.start();
    const cmd = {
      type: 'command' as const,
      id: '1',
      command: { name: 'crew.message' as const, agentId: 'a', text: 'hi' },
    };
    expect(conn.send(cmd)).toBe(false);
    sockets[0]!.open();
    expect(conn.send(cmd)).toBe(true);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual(cmd);
  });

  it('stops reconnecting once stopped', () => {
    const { conn, sockets, timers } = setup();
    conn.start();
    sockets[0]!.open();
    conn.stop();
    expect(sockets[0]!.closed).toBe(true);
    expect(timers).toHaveLength(0);
  });
});
