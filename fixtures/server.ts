import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sites');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export interface FixtureServer {
  baseUrl: string;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function serveFile(res: ServerResponse, filePath: string): Promise<void> {
  try {
    const body = await readFile(filePath);
    const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> | void {
  if (req.method === 'POST' && url.pathname === '/echo') {
    return readBody(req).then((body) => {
      let parsed: unknown = body;
      const type = req.headers['content-type'] ?? '';
      if (type.includes('application/json')) {
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
      } else if (type.includes('application/x-www-form-urlencoded')) {
        parsed = Object.fromEntries(new URLSearchParams(body));
      }
      send(res, 200, JSON.stringify({ received: parsed }), { 'Content-Type': 'application/json; charset=utf-8' });
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');

  if (url.pathname === '/download/sample.txt') {
    return send(res, 200, 'browser-os fixture download\n', {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sample.txt"',
    });
  }

  if (url.pathname === '/slow') {
    const ms = Math.min(Number(url.searchParams.get('ms') ?? '0') || 0, 10000);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        send(res, 200, JSON.stringify({ waitedMs: ms }), { 'Content-Type': 'application/json; charset=utf-8' });
        resolve();
      }, ms);
    });
  }

  // Static files. Query strings (including ?variant=) are ignored here and read by the page's own JS.
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const candidate = path.resolve(SITES_DIR, relative);
  const insideSites = candidate === SITES_DIR || candidate.startsWith(SITES_DIR + path.sep);
  if (!insideSites) return send(res, 403, 'forbidden');

  if (url.pathname === '/') return serveFile(res, path.join(SITES_DIR, 'basic', 'index.html'));

  // SPA fallback: /spa/<route> without a file extension serves the SPA shell.
  if (/^\/spa\/(?![^/]*\.[a-z0-9]+$)/i.test(url.pathname)) {
    return serveFile(res, path.join(SITES_DIR, 'spa', 'index.html'));
  }

  const isFile = path.extname(relative) !== '';
  return serveFile(res, isFile ? candidate : path.join(SITES_DIR, relative, 'index.html'));
}

export async function startFixtureServer(opts: { port?: number } = {}): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    Promise.resolve(handle(req, res, url)).catch(() => {
      if (!res.headersSent) send(res, 500, 'internal error');
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture server: no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
