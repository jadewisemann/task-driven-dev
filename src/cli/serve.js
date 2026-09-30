import { createApp } from '../server/app.js';
import { createHttpServer } from '../server/http/server.js';
import { clearDaemonInfo, writeDaemonInfo } from '../server/core/paths.js';

/** Starts the HTTP server + web UI and records it in <home>/daemon.json. */
export async function serve({ home, port = 7420, host = '127.0.0.1', allowedHosts = [] }) {
  const app = createApp({ home });
  const server = createHttpServer(app, { allowedHosts });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), host, resolve);
  });
  const address = server.address();
  writeDaemonInfo(app.home, { port: address.port, host });
  console.log(`todo.devs ${app.version} listening on http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`);
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
