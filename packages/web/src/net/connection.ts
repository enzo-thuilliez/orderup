/**
 * Reconnecting WebSocket client for the local server. Talks only to the page's own origin,
 * which is the OrderUp server on 127.0.0.1 (or the Vite dev proxy in front of it).
 */
import type { ClientMessage, ServerMessage } from 'orderup-shared';
import { parseMessage, type ConnectionStatus } from './store';

/** The slice of the WebSocket API we use, so tests can pass a fake. */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
  readonly readyState: number;
}

export interface ConnectionOptions {
  url: string;
  onMessage(msg: ServerMessage): void;
  onStatus(status: ConnectionStatus): void;
  createSocket?: (url: string) => SocketLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const OPEN = 1;

/** 0.5 s, 1 s, 2 s, … capped at 10 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** Math.max(0, attempt));
}

/** `ws://host/ws` (or `wss:`) for the page's own origin. */
export function socketUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
}

export class Connection {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private timer: unknown = null;
  private stopped = false;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly opts: ConnectionOptions) {
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Close for good: no more reconnects. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const s = this.socket;
    this.socket = null;
    s?.close();
  }

  send(msg: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  private connect(): void {
    this.timer = null;
    this.opts.onStatus('connecting');
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.opts.onStatus('open');
    };
    socket.onmessage = (ev) => {
      const msg = parseMessage(ev.data);
      if (msg) this.opts.onMessage(msg);
    };
    socket.onerror = () => {
      // onclose follows and handles the retry.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;
      this.opts.onStatus('closed');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer !== null) return;
    const delay = reconnectDelay(this.attempt++);
    this.timer = this.setTimer(() => this.connect(), delay);
  }
}
