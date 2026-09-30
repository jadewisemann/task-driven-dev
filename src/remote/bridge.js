import { hostname } from 'node:os';
import { createApp } from '../server/app.js';
import { readDaemonInfo, resolveHome } from '../server/core/paths.js';
import { createLineReader, writeLine } from './jsonl.js';

/** Methods a remote caller may not use through the bridge (no chained hops / peer admin from afar). */
const BLOCKED_PREFIXES = ['peers.'];

/**
 * `todo-devs rpc` — the remote end of an SSH session.
 *
 * Speaks JSON-RPC 2.0 over stdin/stdout, one message per line:
 *   → {"jsonrpc":"2.0","id":1,"method":"tasks.list","params":{...}}
 *   ← {"jsonrpc":"2.0","id":1,"result":[...]}
 *   ← {"jsonrpc":"2.0","method":"event","params":{seq,type,ts,payload}}   (live events)
 * The first line is a `hello` notification describing this instance.
 *
 * If a server (`todo-devs serve`) is running for this home, every call is
 * forwarded to it so its scheduler, UI and event bus stay the single source of
 * truth. Otherwise an embedded instance is opened for the life of the session.
 * Anything that is not protocol goes to stderr.
 */
export async function runBridge({ home, input = process.stdin, output = process.stdout }) {
  const dir = resolveHome(home);
  const daemon = readDaemonInfo(dir);
  const backend = daemon ? createDaemonBackend(daemon) : createEmbeddedBackend(dir);
  const send = (msg) => {
    if (!output.destroyed) writeLine(output, msg);
  };

  const info = await backend.info();
  send({ jsonrpc: '2.0', method: 'hello', params: { ...info, mode: daemon ? 'daemon' : 'embedded', bridgeHost: hostname() } });
  const stopEvents = backend.subscribe((event) => send({ jsonrpc: '2.0', method: 'event', params: event }));

  let pending = 0;
  let ended = false;
  const done = new Promise((resolve) => {
    const maybeFinish = () => ended && pending === 0 && resolve();
    createLineReader(
      input,
      async (msg) => {
        if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
          send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } });
          return;
        }
        if (msg.id === undefined) return; // notifications from the client are ignored
        if (BLOCKED_PREFIXES.some((p) => msg.method.startsWith(p))) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${msg.method} is not available over a remote session` } });
          return;
        }
        pending++;
        try {
          send(await backend.call(msg));
        } catch (err) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } });
        } finally {
          pending--;
          maybeFinish();
        }
      },
      { onError: (err) => process.stderr.write(`[todo-devs rpc] ${err.message}\n`) },
    );
    input.on('end', () => {
      ended = true;
      maybeFinish();
    });
  });
  await done;
  stopEvents();
  await backend.close();
}

function createEmbeddedBackend(home) {
  const app = createApp({ home, log: (err) => process.stderr.write(`[todo-devs] ${err?.stack || err}\n`) });
  return {
    info: () => app.call('system.info', {}),
    call: (msg) => app.rpc.handle({ jsonrpc: '2.0', id: msg.id, method: msg.method, params: msg.params }, { app, log: app.log }),
    subscribe: (fn) => app.bus.subscribe((e) => !e.peer && fn(e)),
    close: () => app.close(),
  };
}

function createDaemonBackend(daemon) {
  const host = daemon.host === '0.0.0.0' || daemon.host === '::' ? '127.0.0.1' : daemon.host;
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${daemon.port}`;
  const headers = { 'content-type': 'application/json', ...(daemon.token ? { 'x-todo-devs-token': daemon.token } : {}) };
  const post = async (method, params) => {
    const res = await fetch(`${base}/api/rpc`, { method: 'POST', headers, body: JSON.stringify({ method, params }) });
    return res.json();
  };
  const controller = new AbortController();
  return {
    async info() {
      const body = await post('system.info', {});
      if (body.error) throw new Error(typeof body.error === 'string' ? body.error : body.error.message);
      return body.result;
    },
    async call(msg) {
      const body = await post(msg.method, msg.params);
      if (body.error) return { jsonrpc: '2.0', id: msg.id, error: typeof body.error === 'string' ? { code: -32000, message: body.error } : body.error };
      return { jsonrpc: '2.0', id: msg.id, result: body.result ?? null };
    },
    subscribe(fn) {
      (async () => {
        // Follow the daemon's SSE stream; reconnect until the session ends.
        while (!controller.signal.aborted) {
          try {
            const res = await fetch(`${base}/api/events${daemon.token ? `?token=${encodeURIComponent(daemon.token)}` : ''}`, { signal: controller.signal });
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buf = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += value;
              let idx;
              while ((idx = buf.indexOf('\n\n')) !== -1) {
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
                if (!data) continue;
                try {
                  const event = JSON.parse(data);
                  if (!event.peer) fn(event); // never re-export events this daemon relays from its own peers
                } catch {
                  /* ignore malformed frame */
                }
              }
            }
          } catch {
            if (controller.signal.aborted) return;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      })();
      return () => controller.abort();
    },
    close: async () => controller.abort(),
  };
}
