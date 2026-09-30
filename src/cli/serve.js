import { createApp } from '../server/app.js';
import { PairingCodes, loadOrCreateToken } from '../server/core/auth.js';
import { createHttpServer } from '../server/http/server.js';
import { clearDaemonInfo, writeDaemonInfo } from '../server/core/paths.js';
import { pairingInfo } from './pairing.js';
import { installedServicePaths } from './service.js';

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

/**
 * Starts the HTTP server + web UI and records it in <home>/daemon.json.
 * Binding outside loopback always requires an access token: --token, or the
 * one persisted in <home>/auth.json (so paired phones keep working across restarts).
 */
export async function serve({ home, port = 7420, host = '127.0.0.1', allowedHosts = [], token }) {
  const app = createApp({ home, recover: true });
  app.servicePaths = () => installedServicePaths();
  const networked = !LOOPBACK.includes(host);
  if (networked && !token) token = loadOrCreateToken(app.home);
  const pairing = token ? new PairingCodes(token) : null;
  const server = createHttpServer(app, { allowedHosts, token, pairing });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port), host, resolve);
    });
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`error: port ${port} is already in use (another todo-devs serve?). Stop it or use --port.`);
    await app.close();
    process.exit(3); // EXIT_PORT_IN_USE: the service manager does not retry this
  }
  const address = server.address();
  const daemon = { port: address.port, host, token: token || null };
  writeDaemonInfo(app.home, daemon);

  // Each call mints a fresh one-time code; the long-lived token itself is never handed out.
  app.rpc.register(
    'system.pairing',
    () => (pairing ? pairingInfo(daemon, pairing.create()) : pairingInfo(daemon)),
    'One-time pairing links for the mobile app / other browsers (network mode only)',
  );

  console.log(`todo.devs ${app.version} listening on http://${networked ? '<this-host>' : host}:${address.port}`);
  console.log(`data: ${app.home}`);
  if (networked) {
    console.log('network mode: API calls need the access token. Pair a phone or browser with `todo-devs pair`.');
    if (allowedHosts.length) console.log('note: --allow-host is ignored in network mode (the token authorises requests).');
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
