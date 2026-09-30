import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createHttpServer } from '../server/http/server.js';
import { clearDaemonInfo, writeDaemonInfo } from '../server/core/paths.js';

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

/**
 * Starts the HTTP server + web UI and records it in <home>/daemon.json.
 * Binding outside loopback always requires an access token (generated if absent).
 */
export async function serve({ home, port = 7420, host = '127.0.0.1', allowedHosts = [], token }) {
  if (!LOOPBACK.includes(host) && !token) token = randomBytes(18).toString('base64url');
  const app = createApp({ home, recover: true });
  const server = createHttpServer(app, { allowedHosts, token });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), host, resolve);
  });
  const address = server.address();
  writeDaemonInfo(app.home, { port: address.port, host, token: token || null });
  const shown = LOOPBACK.includes(host) ? host : '<this-host>';
  console.log(`todo.devs ${app.version} listening on http://${shown}:${address.port}${token ? `/?token=${token}` : ''}`);
  console.log(`data: ${app.home}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.closeAllConnections?.();
    server.close();
    clearDaemonInfo(app.home);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { app, server, shutdown };
}
