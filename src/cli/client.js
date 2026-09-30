import { createApp } from '../server/app.js';
import { readDaemonInfo, resolveHome } from '../server/core/paths.js';

/**
 * Calls an RPC method on the running server for this home (so its event bus,
 * scheduler and UI see the change). Falls back to a short-lived in-process
 * instance when no server is running.
 */
export async function callRpc({ home, method, params = {}, peer }) {
  const dir = resolveHome(home);
  const daemon = readDaemonInfo(dir);
  if (daemon) return callHttp(daemon, method, params, peer);
  if (peer) throw new Error('Remote peers require a running server: start one with `todo-devs serve`');
  const app = createApp({ home: dir, log: () => {} });
  try {
    return await app.call(method, params);
  } finally {
    await app.close();
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
