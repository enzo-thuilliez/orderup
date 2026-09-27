import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import path from 'node:path';
import { PROTOCOL_VERSION } from 'orderup-shared';

/** Hook payloads include tool inputs, which can hold whole files (Write). */
const MAX_HOOK_BYTES = 8 * 1024 * 1024;

/**
 * Host and Origin checks (ADR-003). `Host` must name the loopback server itself, which
 * defeats DNS rebinding. `Origin`, when a browser sends one, must be the kitchen's own.
 */
export interface Guard {
  hostOk(host: string | undefined): boolean;
  originOk(origin: string | undefined): boolean;
}

export function createGuard(getPort: () => number, extraOrigins: readonly string[] = []): Guard {
  return {
    hostOk(host) {
      const port = getPort();
      return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
    },
    originOk(origin) {
      if (origin === undefined) return true;
      const port = getPort();
      return (
        origin === `http://127.0.0.1:${port}` ||
        origin === `http://localhost:${port}` ||
        extraOrigins.includes(origin)
      );
    },
  };
}

export interface HttpOptions {
  guard: Guard;
  onHook: (payload: unknown) => void;
  /** Directory of the built web app to serve, if any. */
  webRoot?: string;
}

export function createRequestHandler({ guard, onHook, webRoot }: HttpOptions): RequestListener {
  const root = webRoot ? path.resolve(webRoot) : null;

  return (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    if (!guard.hostOk(req.headers.host) || !guard.originOk(req.headers.origin)) {
      return send(res, 403, 'forbidden');
    }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (pathname === '/health' && req.method === 'GET') {
      res.setHeader('cache-control', 'no-store');
      return send(
        res,
        200,
        JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION }),
        'application/json',
      );
    }
    if (pathname === '/hook') {
      if (req.method !== 'POST') return send(res, 405, 'method not allowed');
      // Requiring JSON forces a CORS preflight for any cross-site browser request.
      if (!req.headers['content-type']?.startsWith('application/json')) {
        return send(res, 415, 'expected application/json');
      }
      return void readBody(req, MAX_HOOK_BYTES).then(
        (body) => {
          let payload: unknown;
          try {
            payload = JSON.parse(body);
          } catch {
            return send(res, 400, 'invalid json');
          }
          try {
            onHook(payload);
          } catch {
            // Never fail the hook: Claude Code must not be slowed down by OrderUp.
          }
          res.writeHead(204).end();
        },
        () => send(res, 413, 'payload too large'),
      );
    }
    if (root && (req.method === 'GET' || req.method === 'HEAD')) {
      return void serveStatic(root, pathname, req, res);
    }
    send(res, 404, 'not found');
  };
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  type = 'text/plain; charset=utf-8',
): void {
  res.writeHead(status, { 'content-type': type }).end(body);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume();
        reject(new Error('too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

async function serveStatic(
  root: string,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'bad request');
  }
  let file = path.resolve(root, `.${decoded}`);
  if (file !== root && !file.startsWith(root + path.sep)) return send(res, 404, 'not found');

  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = path.join(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) {
    // Single-page app: unknown routes without an extension get the kitchen.
    if (path.extname(decoded)) return send(res, 404, 'not found');
    file = path.join(root, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info?.isFile()) return send(res, 404, 'not found');
  }

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    'content-length': info.size,
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}
