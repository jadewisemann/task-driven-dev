import { runBridge } from '../remote/bridge.js';
import { openSession } from './client.js';
import { pairingInfo } from './pairing.js';
import { rotateToken } from '../server/core/auth.js';
import { readDaemonInfo, resolveHome } from '../server/core/paths.js';
import { serve } from './serve.js';

const HELP = `todo.devs — agent kanban with dependency scheduling, orchestration and remote sessions

Server
  todo-devs serve [--port 7420] [--host 127.0.0.1] [--token T]    Start web UI + API
  todo-devs rpc                                                    JSON-RPC over stdio (what SSH peers run)

Board (current project = first one, or --project ID)
  todo-devs status                          Tasks per column + scheduler state
  todo-devs tasks                           List tasks
  todo-devs add "<title>" [--after ID,ID] [--agent NAME]
  todo-devs plan "<goal>" [--run] [--wait]  Orchestrator: natural language → tasks (→ run)
  todo-devs run [--concurrency 2] [--auto-approve]   Run everything in dependency order
  todo-devs stop

Mobile app / other devices
  todo-devs serve --host 0.0.0.0            Listen on the network (token required, kept in auth.json)
  todo-devs pair [--host 100.x.y.z]         Print pairing links (open the app link on the phone)
  todo-devs token rotate                    New token; paired devices must pair again (restart server)

Remote sessions (SSH)
  todo-devs peer add <name> <user@host> [--port 22] [--identity ~/.ssh/key]
                     [--remote-command "todo-devs"] [--remote-home DIR]
  todo-devs peer add <name> --exec "<command that runs todo-devs rpc>"
  todo-devs peer list | ping <name> | rm <name>
  Any command + --peer <name> runs against that remote instance, e.g.
    todo-devs status --peer build-box

Low level
  todo-devs call <method> [json-params]     Call any RPC method
  todo-devs methods                         List RPC methods

Global flags: --home DIR (default $TODO_DEVS_HOME or ~/.todo-devs), --json, --peer NAME
`;

function parseParams(raw) {
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`params must be valid JSON, got: ${raw}`);
  }
}

export function print(value, flags) {
  if (flags.json || typeof value !== 'object' || value === null) {
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  } else if (Array.isArray(value) && value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
    console.table(value);
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {Promise<number|void>} exit code */
export async function runCli(positionals, flags) {
  const [command] = positionals;
  if (['serve', 'rpc', 'help', 'pair', 'token', undefined].includes(command)) return runCommand(positionals, flags, null);
  if (flags.peer === true) throw new Error('--peer needs a peer name');
  const session = await openSession({ home: flags.home });
  try {
    return await runCommand(positionals, flags, session);
  } finally {
    await session.close();
  }
}

async function runCommand(positionals, flags, session) {
  const [command, ...rest] = positionals;
  const call = (method, params) => session.call(method, params, flags.peer);
  const local = (method, params) => session.call(method, params);
  const projectId = async () => flags.project || (await call('projects.list', {}))[0]?.id;

  /**
   * Scheduling and planning keep running after the call returns, so they need a
   * long-lived server on whichever machine executes them.
   */
  async function requirePersistentBackend(what) {
    if (flags.peer) {
      const { info } = await local('peers.connect', { id: flags.peer });
      if (info.mode !== 'daemon') throw new Error(`${what} needs a running server on ${flags.peer}: run \`todo-devs serve\` there first`);
    } else if (session.mode !== 'daemon') {
      throw new Error(`${what} needs a running server: start \`todo-devs serve\` (in another terminal or as a service) first`);
    }
  }

  switch (command) {
    case 'serve': {
      const allowedHosts = typeof flags['allow-host'] === 'string' ? flags['allow-host'].split(',') : [];
      await serve({ home: flags.home, port: flags.port ?? 7420, host: flags.host ?? '127.0.0.1', allowedHosts, token: flags.token });
      return new Promise(() => {}); // keep running until a signal arrives
    }
    case 'pair': {
      const daemon = readDaemonInfo(resolveHome(flags.home));
      if (!daemon) throw new Error('no server running — start one with `todo-devs serve --host 0.0.0.0`');
      const info = pairingInfo(daemon, { publicHost: typeof flags.host === 'string' ? flags.host : undefined });
      if (flags.json) return print(info, flags);
      if (!info.enabled) {
        console.log(info.reason);
        return 1;
      }
      console.log('Open the app link on your phone (e.g. send it to yourself) or paste it in the app. Keep it private.');
      for (const l of info.links) console.log(`\n${l.label}\n  app: ${l.deepLink}\n  web: ${l.web}`);
      return 0;
    }
    case 'token': {
      if (rest[0] !== 'rotate') throw new Error('usage: todo-devs token rotate');
      rotateToken(resolveHome(flags.home));
      console.log('token rotated — restart `todo-devs serve` and pair your devices again');
      return 0;
    }
    case 'rpc':
      await runBridge({ home: flags.home });
      process.exit(0); // stdin closed: the session is over, don't linger on open handles
      return 0;

    case 'status': {
      const pid = await projectId();
      const [tasks, sched, info] = await Promise.all([call('tasks.list', { projectId: pid }), call('scheduler.status', { projectId: pid }), call('system.info', {})]);
      const counts = {};
      for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
      if (flags.json) return print({ host: info.host, counts, scheduler: sched }, flags);
      console.log(`${info.host} · project ${pid}`);
      console.log(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('  ') || 'no tasks');
      console.log(`scheduler: ${sched.state}${sched.reason ? ` — ${sched.reason}` : ''}`);
      return 0;
    }
    case 'tasks': {
      const [tasks, agents] = await Promise.all([call('tasks.list', { projectId: await projectId() }), call('agents.list', {})]);
      const name = (id) => agents.find((a) => a.id === id)?.name || '';
      if (flags.json) return print(tasks, flags);
      print(tasks.map((t) => ({ id: t.id, status: t.status, title: t.title.slice(0, 50), agent: name(t.assigneeId), after: t.dependsOn.length })), flags);
      return 0;
    }
    case 'add': {
      if (!rest[0]) throw new Error('usage: todo-devs add "<title>" [--after ID,ID] [--agent NAME]');
      let assigneeId;
      if (flags.agent) {
        const agent = (await call('agents.list', {})).find((a) => a.name.toLowerCase() === String(flags.agent).toLowerCase() || a.id === flags.agent);
        if (!agent) throw new Error(`no agent named ${flags.agent}`);
        assigneeId = agent.id;
      }
      const task = await call('tasks.create', { projectId: await projectId(), title: rest.join(' '), status: 'todo', assigneeId, dependsOn: typeof flags.after === 'string' ? flags.after.split(',') : undefined });
      console.log(`created ${task.id}`);
      return 0;
    }
    case 'plan': {
      if (!rest[0]) throw new Error('usage: todo-devs plan "<goal>" [--run] [--wait]');
      await requirePersistentBackend('Planning');
      const pid = await projectId();
      let plan = await call('orchestrator.plan', { projectId: pid, goal: rest.join(' '), autoRun: flags.run === true, reviewPolicy: flags['auto-approve'] ? 'auto-approve' : 'wait' });
      console.log(`plan ${plan.id}: planning…`);
      const until = flags.run ? (flags.wait ? ['finished', 'incomplete', 'failed', 'discarded'] : ['running', 'failed', 'finished', 'incomplete', 'discarded']) : ['draft', 'failed', 'discarded'];
      const deadline = Date.now() + (Number(flags.timeout) || 3600) * 1000;
      while (!until.includes(plan.status)) {
        if (Date.now() > deadline) throw new Error(`plan ${plan.id} still ${plan.status} after ${Number(flags.timeout) || 3600}s`);
        await sleep(1000);
        plan = await call('orchestrator.get', { planId: plan.id });
      }
      if (flags.json) return print(plan, flags);
      console.log(`status: ${plan.status} (${plan.source})`);
      for (const t of plan.plan.tasks) console.log(`  ${t.key.padEnd(4)} c${t.complexity} ${String(t.agentName || '-').padEnd(8)} ${t.title}${t.dependsOn.length ? `  ← ${t.dependsOn.join(', ')}` : ''}`);
      for (const w of plan.plan.warnings || []) console.log(`  ! ${w}`);
      if (plan.summary) console.log(plan.summary);
      if (plan.status === 'draft') console.log(`run it with: todo-devs call orchestrator.run '{"planId":"${plan.id}"}'`);
      return plan.status === 'failed' ? 1 : 0;
    }
    case 'run':
      await requirePersistentBackend('Running the scheduler');
      print(await call('scheduler.start', { projectId: await projectId(), concurrency: Number(flags.concurrency) || 2, reviewPolicy: flags['auto-approve'] ? 'auto-approve' : 'wait' }), flags);
      return 0;
    case 'stop':
      print(await call('scheduler.stop', { projectId: await projectId() }), flags);
      return 0;

    case 'peer': {
      const [sub, name, target] = rest;
      if (sub === 'list' || !sub) {
        const peers = await local('peers.list', {});
        if (flags.json) return print(peers, flags);
        print(peers.map((p) => ({ name: p.name, transport: p.transport, target: p.target, state: p.status.state, command: p.command })), flags);
        return 0;
      }
      if (sub === 'add') {
        if (!name) throw new Error('usage: todo-devs peer add <name> <user@host> | --exec "<command>"');
        const exec = typeof flags.exec === 'string';
        if (!exec && !target) throw new Error('usage: todo-devs peer add <name> <user@host>');
        const options = {};
        if (flags.port) options.port = Number(flags.port);
        if (flags.identity) options.identityFile = String(flags.identity);
        if (flags['remote-home']) options.remoteHome = String(flags['remote-home']);
        const peer = await local('peers.add', {
          name,
          transport: exec ? 'exec' : 'ssh',
          target: exec ? flags.exec : target,
          ...(flags['remote-command'] ? { remoteCommand: String(flags['remote-command']) } : {}),
          options,
        });
        console.log(`added ${peer.name} — test it with: todo-devs peer ping ${peer.name}`);
        return 0;
      }
      if (sub === 'ping') {
        const res = await local('peers.ping', { id: name });
        const info = await session.call('system.info', {}, name);
        console.log(`${name}: ${info.host} (todo.devs ${info.version}) — ${res.latencyMs} ms`);
        return 0;
      }
      if (sub === 'rm' || sub === 'remove') {
        await local('peers.remove', { id: name });
        console.log(`removed ${name}`);
        return 0;
      }
      throw new Error(`unknown peer command: ${sub}`);
    }

    case 'call': {
      if (!rest[0]) throw new Error('usage: todo-devs call <method> [json-params]');
      print(await call(rest[0], parseParams(rest[1])), { ...flags, json: true });
      return 0;
    }
    case 'methods':
      print(await call('system.methods', {}), flags);
      return 0;
    case undefined:
    case 'help':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      return 1;
  }
}
