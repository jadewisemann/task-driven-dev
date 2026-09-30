import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(new URL('../../web/', import.meta.url)));
const MAX_BODY = 5 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Only loopback hosts are accepted. This blocks DNS-rebinding attacks since the
 * server is meant to be reached locally or through an SSH tunnel.
 */
function isAllowedHost(hostHeader, extraHosts) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1'].includes(host) || extraHosts.includes(host);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://local');
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: 'Malformed URL' });
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = normalize(join(WEB_ROOT, rel));
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + sep)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    if (extname(rel)) return sendJson(res, 404, { error: 'Not found' });
    const data = await readFile(join(WEB_ROOT, 'index.html'));
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(data);
  }
}

function openEventStream(req, res, app) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const unsubscribe = app.bus.subscribe((event) => res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', close);
  res.on('error', close);
}

/**
 * Cross-site protection: browsers always attach Origin to cross-origin POSTs
 * (including `no-cors` ones), so any Origin whose host is not allowed is refused.
 * Non-browser clients (CLI, scripts) send no Origin.
 */
function isAllowedOrigin(origin, extraHosts) {
  if (!origin) return true;
  try {
    return isAllowedHost(new URL(origin).host, extraHosts);
  } catch {
    return false;
  }
}

const isJsonContentType = (value) => String(value || '').split(';')[0].trim().toLowerCase() === 'application/json';

function hasValidToken(req, url, token) {
  if (!token) return true;
  return req.headers['x-todo-devs-token'] === token || url.searchParams.get('token') === token;
}

/**
 * HTTP entry point.
 *   POST /api/rpc   {method, params, peer?}  -> JSON-RPC style {result} | {error}
 *   GET  /api/events                          -> Server-Sent Events stream
 *   GET  /api/health
 *   GET  /*                                   -> web UI
 *
 * @param {object} app
 * @param {{allowedHosts?: string[], token?: string}} [options] token is required for API calls when set
 */
export function createHttpServer(app, { allowedHosts = [], token } = {}) {
  return createServer(async (req, res) => {
    try {
      if (!isAllowedHost(req.headers.host, allowedHosts)) return sendJson(res, 403, { error: 'Host not allowed' });
      if (!isAllowedOrigin(req.headers.origin, allowedHosts)) return sendJson(res, 403, { error: 'Origin not allowed' });
      const url = new URL(req.url, 'http://local');
      const { pathname } = url;

      if (pathname === '/api/health') return sendJson(res, 200, { ok: true, name: 'todo-devs', version: app.version, auth: Boolean(token) });
      if (pathname.startsWith('/api/') && !hasValidToken(req, url, token)) return sendJson(res, 401, { error: 'Missing or invalid token' });
      if (pathname === '/api/events' && req.method === 'GET') return openEventStream(req, res, app);
      if (pathname === '/api/rpc') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
        if (!isJsonContentType(req.headers['content-type'])) return sendJson(res, 415, { error: 'Content-Type must be application/json' });
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          return sendJson(res, err.status || 400, { error: { code: -32700, message: err.status ? err.message : 'Invalid JSON' } });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(res, 400, { error: { code: -32600, message: 'Body must be an object {method, params, peer?}' } });
        }
        const response = await app.dispatch({ jsonrpc: '2.0', id: 1, method: body.method, params: body.params, peer: body.peer });
        return sendJson(res, 200, response.error ? { error: response.error } : { result: response.result });
      }
      if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
      return await serveStatic(req, res);
    } catch (err) {
      app.log?.(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.end();
    }
  });
}
