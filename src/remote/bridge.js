import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
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
  const send = (msg) => {
    if (!output.destroyed) writeLine(output, msg);
  };
  // If the daemon goes away mid-session, end the session: the client reconnects and re-picks a backend.
  const fatal = (err) => {
    process.stderr.write(`[todo-devs rpc] ${err.message} — closing session\n`);
    output.end?.();
    process.exit(3);
  };
  const backend = daemon ? createDaemonBackend(daemon, { onUnavailable: fatal }) : await createEmbeddedBackend(dir);

  // Subscribe before announcing ourselves so no event between hello and the first call is lost.
  const stopEvents = backend.subscribe((event) => send({ jsonrpc: '2.0', method: 'event', params: event }));
  let info;
  try {
    info = await backend.info();
  } catch (err) {
    stopEvents();
    await backend.close();
    throw err;
  }
  send({ jsonrpc: '2.0', method: 'hello', params: { ...info, mode: daemon ? 'daemon' : 'embedded', bridgeHost: hostname() } });

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

/**
 * Only one embedded instance per data directory: two would run independent
 * schedulers on the same database. Start `todo-devs serve` on the remote to
 * share it between several sessions.
 */
async function acquireEmbeddedLock(home) {
  const file = join(home, 'embedded.lock');
  const deadline = Date.now() + 4000; // a previous session may still be shutting down
  for (;;) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(file, 'utf8'));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        /* stale */
      }
      if (!alive) {
        rmSync(file, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`another session already runs an embedded todo.devs on this host (pid ${pid}); run \`todo-devs serve\` there to share it`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function createEmbeddedBackend(home) {
  const release = await acquireEmbeddedLock(home);
  const app = createApp({ home, log: (err) => process.stderr.write(`[todo-devs] ${err?.stack || err}\n`) });
  return {
    info: () => app.call('system.info', {}),
    call: (msg) => app.rpc.handle({ jsonrpc: '2.0', id: msg.id, method: msg.method, params: msg.params }, { app, log: app.log }),
    subscribe: (fn) => app.bus.subscribe(fn), // local events only — never relayed peer events
    close: async () => {
      await app.close();
      release();
    },
  };
}

function createDaemonBackend(daemon, { onUnavailable }) {
  const host = daemon.host === '0.0.0.0' || daemon.host === '::' ? '127.0.0.1' : daemon.host;
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${daemon.port}`;
  const headers = { 'content-type': 'application/json', ...(daemon.token ? { 'x-todo-devs-token': daemon.token } : {}) };
  const post = async (method, params) => {
    let res;
    try {
      res = await fetch(`${base}/api/rpc`, { method: 'POST', headers, body: JSON.stringify({ method, params }) });
    } catch (err) {
      onUnavailable(new Error(`server at ${base} is unreachable (${err.cause?.code || err.message})`));
      throw err;
    }
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
        let connectedBefore = false;
        let failures = 0;
        while (!controller.signal.aborted) {
          try {
            const res = await fetch(`${base}/api/events${daemon.token ? `?token=${encodeURIComponent(daemon.token)}` : ''}`, { signal: controller.signal });
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            failures = 0;
            // Events may have been missed while disconnected: tell the client to reload.
            if (connectedBefore) fn({ seq: 0, type: 'sync.reconnected', ts: new Date().toISOString(), payload: {} });
            connectedBefore = true;
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
            if (++failures >= 5) return onUnavailable(new Error(`lost the event stream of ${base}`));
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      })();
      return () => controller.abort();
    },
    close: async () => controller.abort(),
  };
}
