import { createApp } from '../server/app.js';
import { readDaemonInfo, resolveHome } from '../server/core/paths.js';

/**
 * One CLI command = one session. With a running server for this home, calls go
 * to it over HTTP (so its bus, scheduler and UI see them). Otherwise a single
 * in-process instance is opened for the whole command — including at most one
 * SSH session per peer — and closed at the end.
 *
 * @returns {Promise<{mode: 'daemon'|'embedded', call: (method, params?, peer?) => Promise<any>, close: () => Promise<void>}>}
 */
export async function openSession({ home }) {
  const dir = resolveHome(home);
  const daemon = readDaemonInfo(dir);
  if (daemon) {
    return { mode: 'daemon', call: (method, params = {}, peer) => callHttp(daemon, method, params, peer), close: async () => {} };
  }
  const app = createApp({ home: dir, log: () => {} });
  return {
    mode: 'embedded',
    async call(method, params = {}, peer) {
      const response = await app.dispatch({ jsonrpc: '2.0', id: 1, method, params, peer });
      if (response.error) throw Object.assign(new Error(response.error.message), response.error);
      return response.result;
    },
    close: () => app.close(),
  };
}

/** Single call convenience (opens and closes a session). */
export async function callRpc({ home, method, params = {}, peer }) {
  const session = await openSession({ home });
  try {
    return await session.call(method, params, peer);
  } finally {
    await session.close();
  }
}

async function callHttp(daemon, method, params, peer) {
  const host = daemon.host === '0.0.0.0' || daemon.host === '::' ? '127.0.0.1' : daemon.host;
  const res = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${daemon.port}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(daemon.token ? { 'x-todo-devs-token': daemon.token } : {}) },
    body: JSON.stringify({ method, params, ...(peer ? { peer } : {}) }),
  });
  const body = await res.json();
  if (body.error) {
    const error = typeof body.error === 'string' ? { message: body.error, code: res.status } : body.error;
    throw Object.assign(new Error(error.message), error);
  }
  return body.result;
}
