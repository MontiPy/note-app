import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault, VaultError } from './vault.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const publicDir = path.join(projectRoot, 'public');

const STATIC = {
  '/vendor/marked.js': path.join(projectRoot, 'node_modules/marked/lib/marked.esm.js'),
  '/vendor/purify.js': path.join(projectRoot, 'node_modules/dompurify/dist/purify.es.mjs'),
  '/shared/markdown.js': path.join(here, 'markdown.js'),
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const MAX_BODY = 20 * 1024 * 1024;

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new VaultError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new VaultError(400, 'Invalid JSON'); }
}

// The server only listens on localhost, but a web page you visit could still try to
// reach it. Rejecting foreign Host headers blocks DNS rebinding, and requiring a
// custom header on API calls forces a CORS preflight that we never approve.
function isTrusted(req, port) {
  const host = (req.headers.host || '').toLowerCase();
  const allowed = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
  if (!allowed.includes(host)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  // EventSource can't send custom headers; the event stream is read-only and a
  // cross-origin page can't read it without CORS headers, which we never send.
  const isEventStream = req.url === '/api/events' && req.method === 'GET';
  if (req.url.startsWith('/api/') && !isEventStream && req.headers['x-notes-app'] !== '1') return false;
  return true;
}

async function serveStatic(res, urlPath) {
  let file = STATIC[urlPath];
  if (!file) {
    const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
    file = path.resolve(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep)) return send(res, 404, 'Not found');
  }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    });
    res.end(body);
  } catch {
    send(res, 404, 'Not found');
  }
}

export function createApp(vault) {
  const clients = new Set();
  vault.on('change', (data) => {
    for (const res of clients) res.write(`event: change\ndata: ${JSON.stringify(data)}\n\n`);
  });

  const routes = {
    'GET /api/tree': () => vault.tree(),
    'GET /api/note': (q) => vault.read(q.get('path')),
    'PUT /api/note': (_q, b) => vault.write(b.path, b.content, { baseMtime: b.baseMtime }),
    'POST /api/note': (_q, b) => (b.path ? vault.write(b.path, b.content ?? '', { create: true }) : vault.createNote(b)),
    'DELETE /api/note': (q) => vault.remove(q.get('path')),
    'POST /api/folder': (_q, b) => vault.mkdir(b.path),
    'POST /api/rename': (_q, b) => vault.rename(b.from, b.to),
    'GET /api/search': (q) => vault.search(q.get('q') ?? ''),
    'GET /api/backlinks': (q) => vault.backlinks(q.get('path')),
    'GET /api/tags': () => vault.tags(),
    'GET /api/templates': () => vault.templates(),
    'POST /api/attachment': (_q, b) => vault.saveAttachment(b),
    'POST /api/from-template': (_q, b) => vault.createFromTemplate(b),
    'POST /api/daily': () => vault.daily(),
    'GET /api/config': async () => ({ ...(await vault.getConfig()), vaultPath: vault.root }),
    'PUT /api/config': (_q, b) => vault.setConfig(b),
  };

  const server = http.createServer(async (req, res) => {
    if (!isTrusted(req, server.address().port)) return send(res, 403, 'Forbidden');
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const handler = routes[`${req.method} ${url.pathname}`];
        if (!handler) return send(res, 404, { error: 'Unknown endpoint' });
        const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {};
        return send(res, 200, (await handler(url.searchParams, body)) ?? { ok: true });
      }
      if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
      if (url.pathname.startsWith('/vault-file/')) {
        const rel = url.pathname.slice('/vault-file/'.length).split('/').map(decodeURIComponent).join('/');
        const { body, type } = await vault.readFile(rel);
        // Sandboxed so an SVG or PDF opened directly can't run scripts against the API.
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' });
        return res.end(body);
      }
      return serveStatic(res, url.pathname);
    } catch (e) {
      if (e instanceof VaultError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: 'Internal error' });
    }
  });
  return server;
}

export async function start({ vaultPath, port = 4321, host = '127.0.0.1', seed = true, watch = true }) {
  const vault = new Vault(vaultPath);
  await vault.init({ seed });
  if (watch) vault.watch();
  const server = createApp(vault);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  return { server, vault, url: `http://localhost:${actualPort}` };
}
