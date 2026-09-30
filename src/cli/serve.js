import { createApp } from '../server/app.js';
import { loadOrCreateToken } from '../server/core/auth.js';
import { createHttpServer } from '../server/http/server.js';
import { clearDaemonInfo, writeDaemonInfo } from '../server/core/paths.js';
import { pairingInfo } from './pairing.js';

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

/**
 * Starts the HTTP server + web UI and records it in <home>/daemon.json.
 * Binding outside loopback always requires an access token: --token, or the
 * one persisted in <home>/auth.json (so paired phones keep working across restarts).
 */
export async function serve({ home, port = 7420, host = '127.0.0.1', allowedHosts = [], token }) {
  const app = createApp({ home, recover: true });
  if (!LOOPBACK.includes(host) && !token) token = loadOrCreateToken(app.home);
  const server = createHttpServer(app, { allowedHosts, token });
  // Long-polls hold requests open ~25-55 s; keep Node's defaults from cutting them.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), host, resolve);
  });
  const address = server.address();
  const daemon = { port: address.port, host, token: token || null };
  writeDaemonInfo(app.home, daemon);

  app.rpc.register('system.pairing', () => pairingInfo(daemon), 'Links for pairing the mobile app / other devices (token mode only)');

  console.log(`todo.devs ${app.version} listening on http://${LOOPBACK.includes(host) ? host : '<this-host>'}:${address.port}`);
  console.log(`data: ${app.home}`);
  const pairing = pairingInfo(daemon);
  if (pairing.enabled) {
    console.log('pair a phone or another browser (keep these private — they grant full access):');
    for (const l of pairing.links) console.log(`  ${l.label}\n    app: ${l.deepLink}\n    web: ${l.web}`);
  }

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
