import { parseJson, toJson } from '../core/db.js';
import { ErrorCode, RpcError, check, conflict, invalidParams, notFound } from '../core/errors.js';
import { newId, now } from '../core/ids.js';
import { splitCommand } from '../harness/registry.js';
import { RemoteClient } from './client.js';

export const TRANSPORTS = ['ssh', 'exec'];

/** ssh targets: [user@]host[:ignored] — must not look like an option. */
const SSH_TARGET = /^(?!-)[A-Za-z0-9._%+-]+(@[A-Za-z0-9._\-[\]:]+)?$/;
/** Remote command run by the remote login shell; restricted to a safe charset. */
const REMOTE_COMMAND = /^[A-Za-z0-9_./~ =:@+-]+$/;
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const mapRow = (r) =>
  r && {
    id: r.id,
    name: r.name,
    transport: r.transport,
    target: r.target,
    remoteCommand: r.remote_command,
    options: parseJson(r.options, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

/**
 * Builds the local process that carries a session.
 *  - ssh:  ssh -T -o BatchMode=yes [-p port] [-i key] [...sshArgs] <target> "<remoteCommand> rpc [--home <dir>]"
 *  - exec: any local command (docker exec -i …, kubectl exec -i …, or a local todo-devs for testing)
 */
export function transportSpec(peer) {
  const o = peer.options || {};
  if (peer.transport === 'exec') {
    const [command, ...args] = splitCommand(peer.target);
    if (!command) throw invalidParams('exec transport needs a command');
    return { command, args, display: peer.target };
  }
  const remote = [peer.remoteCommand || 'todo-devs', 'rpc', ...(o.remoteHome ? ['--home', shellQuote(o.remoteHome)] : [])].join(' ');
  const args = [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    ...(o.port ? ['-p', String(o.port)] : []),
    ...(o.identityFile ? ['-i', o.identityFile] : []),
    ...(o.sshArgs || []),
    '--',
    peer.target,
    remote,
  ];
  return { command: o.sshCommand || 'ssh', args, display: `ssh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}` };
}

function validatePeer(p, { partial = false } = {}) {
  const out = {};
  if (!partial || p.name !== undefined) {
    out.name = check.string(p, 'name');
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(out.name)) throw invalidParams('name: letters, digits, . _ - (max 40)');
  }
  if (!partial || p.transport !== undefined) out.transport = check.oneOf(p, 'transport', TRANSPORTS, { optional: true }) ?? 'ssh';
  if (!partial || p.target !== undefined) out.target = check.string(p, 'target');
  if (p.remoteCommand !== undefined) {
    out.remoteCommand = check.string(p, 'remoteCommand');
    if (!REMOTE_COMMAND.test(out.remoteCommand)) throw invalidParams('remoteCommand may only contain letters, digits, spaces and . / ~ _ - = : @ +');
  }
  if (p.options !== undefined) {
    const o = p.options;
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw invalidParams('"options" must be an object');
    const known = ['port', 'identityFile', 'sshArgs', 'remoteHome', 'sshCommand'];
    const unknown = Object.keys(o).filter((k) => !known.includes(k));
    if (unknown.length) throw invalidParams(`Unknown peer options: ${unknown.join(', ')}`);
    if (o.port !== undefined && o.port !== null) check.number(o, 'port', { min: 1, max: 65535, integer: true });
    if (o.identityFile !== undefined && o.identityFile !== null) check.string(o, 'identityFile');
    if (o.remoteHome !== undefined && o.remoteHome !== null) check.string(o, 'remoteHome');
    if (o.sshCommand !== undefined && o.sshCommand !== null) check.string(o, 'sshCommand');
    if (o.sshArgs !== undefined) check.stringArray(o, 'sshArgs');
    out.options = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== ''));
  }
  return out;
}

/**
 * Peers = other todo.devs instances reachable over SSH (or any stdio transport).
 * Keeps one live RemoteClient per peer, relays its events onto the local bus
 * tagged with `peer`, and proxies RPC calls to it.
 */
export function createPeerManager({ db, bus, log = console.error }) {
  const clients = new Map(); // peerId -> RemoteClient

  const store = {
    list: () => db.all('SELECT * FROM peers ORDER BY name').map(mapRow),
    get(idOrName) {
      const peer = mapRow(db.get('SELECT * FROM peers WHERE id = ? OR name = ?', [idOrName, idOrName]));
      if (!peer) throw notFound('Peer', idOrName);
      return peer;
    },
  };

  function checkTarget(peer) {
    if (peer.transport === 'ssh' && !SSH_TARGET.test(peer.target)) throw invalidParams('ssh target must look like user@host or host');
    if (peer.transport === 'exec') transportSpec(peer); // validates the template
  }

  function client(peer) {
    let c = clients.get(peer.id);
    if (!c) {
      c = new RemoteClient(transportSpec(peer));
      c.on('event', (event) => bus.forward({ ...event, peer: peer.id }));
      c.on('status', (status) => bus.publish('peer.status', { peerId: peer.id, name: peer.name, ...status }));
      clients.set(peer.id, c);
    }
    return c;
  }

  function drop(peerId) {
    clients.get(peerId)?.close();
    clients.delete(peerId);
  }

  const manager = {
    store,
    list: () => store.list().map((p) => ({ ...p, status: clients.get(p.id)?.status() || { state: 'disconnected' }, command: safeDisplay(p) })),

    add(input) {
      const v = validatePeer(input);
      checkTarget(v);
      if (db.get('SELECT 1 AS x FROM peers WHERE name = ?', [v.name])) throw conflict(`A peer named "${v.name}" already exists`);
      const id = newId('per');
      const ts = now();
      db.run('INSERT INTO peers (id, name, transport, target, remote_command, options, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        v.name,
        v.transport,
        v.target,
        v.remoteCommand || 'todo-devs',
        toJson(v.options || {}),
        ts,
        ts,
      ]);
      bus.publish('peer.created', { peer: store.get(id) });
      return store.get(id);
    },

    update(idOrName, input) {
      const cur = store.get(idOrName);
      const v = validatePeer(input, { partial: true });
      const next = { ...cur, ...v };
      checkTarget(next);
      db.run('UPDATE peers SET name = ?, transport = ?, target = ?, remote_command = ?, options = ?, updated_at = ? WHERE id = ?', [next.name, next.transport, next.target, next.remoteCommand, toJson(next.options), now(), cur.id]);
      drop(cur.id); // reconnect with the new settings
      bus.publish('peer.updated', { peer: store.get(cur.id) });
      return store.get(cur.id);
    },

    remove(idOrName) {
      const peer = store.get(idOrName);
      drop(peer.id);
      db.run('DELETE FROM peers WHERE id = ?', [peer.id]);
      bus.publish('peer.deleted', { peerId: peer.id });
      return { ok: true };
    },

    async connect(idOrName) {
      const peer = store.get(idOrName);
      const info = await client(peer).connect();
      return { peerId: peer.id, info };
    },

    disconnect(idOrName) {
      const peer = store.get(idOrName);
      drop(peer.id);
      bus.publish('peer.status', { peerId: peer.id, name: peer.name, state: 'disconnected' });
      return { ok: true };
    },

    /** Proxies one RPC call to a peer; errors keep their JSON-RPC code. */
    async call(idOrName, method, params) {
      if (typeof method !== 'string') throw new RpcError(ErrorCode.INVALID_REQUEST, 'Invalid request');
      const peer = store.get(idOrName);
      try {
        return await client(peer).call(method, params);
      } catch (err) {
        if (typeof err.code === 'number') throw new RpcError(err.code, err.message, err.data);
        throw new RpcError(ErrorCode.UNAVAILABLE, `${peer.name}: ${err.message}`);
      }
    },

    closeAll() {
      for (const id of [...clients.keys()]) drop(id);
    },
  };
  return manager;
}

function safeDisplay(peer) {
  try {
    return transportSpec(peer).display;
  } catch (err) {
    return `invalid: ${err.message}`;
  }
}

export function registerPeerRpc(rpc, peers) {
  rpc.group('peers', {
    list: { handler: () => peers.list(), description: 'Configured remote sessions with connection status' },
    add: {
      handler: (p) => peers.add(p),
      description: 'Add a remote {name, target: "user@host", transport?: ssh|exec, remoteCommand?: "todo-devs", options?: {port, identityFile, sshArgs, remoteHome}}',
    },
    update: { handler: (p) => peers.update(check.string(p, 'id'), p), description: 'Update a remote (reconnects)' },
    remove: { handler: (p) => peers.remove(check.string(p, 'id')), description: 'Remove a remote' },
    connect: { handler: (p) => peers.connect(check.string(p, 'id')), description: 'Open the session and return the remote instance info' },
    disconnect: { handler: (p) => peers.disconnect(check.string(p, 'id')), description: 'Close the session' },
    ping: {
      handler: async (p) => {
        const started = Date.now();
        const res = await peers.call(check.string(p, 'id'), 'system.ping', {});
        return { ...res, latencyMs: Date.now() - started };
      },
      description: 'Round-trip check',
    },
  });
}
