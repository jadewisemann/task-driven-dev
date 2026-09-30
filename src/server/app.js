import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { Database } from './core/db.js';
import { EventBus } from './core/events.js';
import { migrations } from './core/migrations.js';
import { dbPath, resolveHome } from './core/paths.js';
import { RpcRegistry } from './rpc/registry.js';
import { createProjectService, registerProjectRpc } from './domain/projects.js';
import { createTaskService, registerTaskRpc } from './domain/tasks.js';
import { createAgentService, registerAgentRpc } from './domain/agents.js';
import { createRunStore } from './runtime/runs.js';
import { createRunner } from './runtime/runner.js';
import { createScheduler } from './runtime/scheduler.js';
import { registerRuntimeRpc } from './runtime/rpc.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/**
 * Composition root: wires storage, event bus, domain services and the RPC
 * surface. Everything that talks to the app (HTTP, stdio bridge, CLI) goes
 * through `app.dispatch`.
 *
 * @param {{home?: string, dbFile?: string, log?: (err: unknown) => void, recover?: boolean}} [options]
 *   recover: reset runs/tasks left "running" by a previous process (only the long-lived server should do this).
 */
export function createApp(options = {}) {
  const home = options.dbFile === ':memory:' ? null : resolveHome(options.home);
  const db = new Database(options.dbFile || dbPath(home));
  db.migrate(migrations);

  const bus = new EventBus();
  const rpc = new RpcRegistry();
  const log = options.log || ((err) => console.error('[todo-devs]', err));

  const projects = createProjectService({ db, bus });
  const tasks = createTaskService({ db, bus });
  const agents = createAgentService({ db, bus });
  tasks.validateAssignee = (id) => agents.get(id);
  projects.ensureDefault();
  agents.seedStarterTeam();

  const services = { projects, tasks, agents };
  const runs = createRunStore({ db, bus });
  const runner = createRunner({ bus, services, runs, home, log });
  const scheduler = createScheduler({ bus, services, runner, log });
  if (options.recover) runner.recoverInterrupted();

  const app = {
    version: pkg.version,
    home,
    db,
    bus,
    rpc,
    log,
    services,
    runs,
    runner,
    scheduler,
    /** Hooks run on shutdown (child processes, remote connections, timers). */
    disposers: [
      async () => {
        scheduler.stopAll();
        await runner.cancelAll();
        runs.close(); // late output from runs that outlived the wait is dropped, never written to a closed DB
      },
    ],

    /** Executes a JSON-RPC request object. `peer` routing is added by the remote feature. */
    async dispatch(request) {
      return rpc.handle(request, { app, log });
    },

    /** Convenience for in-process callers: resolves result or throws the RPC error. */
    async call(method, params) {
      const response = await app.dispatch({ jsonrpc: '2.0', id: 1, method, params });
      if (response.error) throw Object.assign(new Error(response.error.message), response.error);
      return response.result;
    },

    async close() {
      for (const dispose of app.disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch (err) {
          log(err);
        }
      }
      db.close();
    },
  };

  rpc.group('system', {
    info: { handler: () => ({ name: 'todo-devs', version: pkg.version, host: hostname(), home, pid: process.pid }), description: 'Instance info' },
    methods: { handler: () => rpc.list(), description: 'List RPC methods' },
    ping: { handler: () => ({ pong: true, ts: new Date().toISOString() }), description: 'Liveness check' },
  });
  registerProjectRpc(rpc, projects);
  registerTaskRpc(rpc, tasks, projects);
  registerAgentRpc(rpc, { agents, tasks, projects });
  registerRuntimeRpc(rpc, { runner, scheduler, runs, services, log });

  return app;
}
