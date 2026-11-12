'use strict';
// Pi / self-hosted entry point: serves public/ and hands /api/* to the app core
// (lib/app.js), with JSON files in DATA_DIR as storage. Netlify runs the same core
// from netlify/functions/.
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { createApp } = require('./lib/app');
const { fileStore } = require('./lib/store');

const PORT = Number(process.env.PORT || 3003);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');

function log(...a) { console.log(new Date().toISOString(), ...a); }

const app = createApp({ store: fileStore(DATA_DIR), env: process.env, log });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function sendText(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > 64e3) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Node request -> web Request -> app core -> web Response -> Node response.
async function apiRoute(req, res) {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body = hasBody ? await readBody(req) : undefined;
  if (body === null) return sendText(res, 413, 'Body too large');
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, { method: req.method, headers, body });
  const r = await app.handle(request, { background: (p) => p });
  const out = {};
  r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) out['set-cookie'] = cookies;
  res.writeHead(r.status, out);
  res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined);
}

function etagMatches(req, etag) {
  const inm = req.headers['if-none-match'];
  return Boolean(inm) && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

async function staticFile(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC + path.sep)) return sendText(res, 404, 'Not found');
  try {
    const st = await fsp.stat(full);
    if (!st.isFile()) throw new Error('not a file');
    // Files only change on deploy; the browser revalidates and usually gets a 304.
    const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const headers = { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff' };
    if (etagMatches(req, etag)) { res.writeHead(304, headers); return res.end(); }
    const body = await fsp.readFile(full);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) await apiRoute(req, res);
    else if (req.method === 'GET') await staticFile(req, res, url.pathname);
    else sendText(res, 405, 'Method not allowed');
  } catch (e) {
    log('error:', e.stack || e.message);
    if (!res.headersSent) sendText(res, 500, 'Internal error');
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => log(`discount-tracker listening on http://${HOST}:${PORT}`));
  app.warm().catch((e) => log('warm-up failed:', e.message));
  if (!process.env.DISABLE_FETCH) {
    // Cheap local check; it only calls the APIs when the weekly slot has passed
    // (or after downtime over the slot, or for a failed shop or new item).
    app.work();
    setInterval(() => app.work(), 15 * 60e3).unref();
  }
}

module.exports = { server, app };
