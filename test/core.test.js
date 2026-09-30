import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { Database } from '../src/server/core/db.js';
import { EventBus } from '../src/server/core/events.js';
import { ancestors, descendants, topoSort, wouldCreateCycle } from '../src/server/domain/dag.js';
import { listen, makeApp, rpc } from './helpers.js';

test('dag: cycle detection, topo levels, ancestors/descendants', () => {
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'a', to: 'd' },
  ];
  assert.equal(wouldCreateCycle(edges, 'c', 'a'), true);
  assert.equal(wouldCreateCycle(edges, 'd', 'c'), false);
  assert.equal(wouldCreateCycle(edges, 'x', 'x'), true);
  const { order, levels, cycle } = topoSort(['a', 'b', 'c', 'd'], edges);
  assert.deepEqual(cycle, []);
  assert.equal(order[0], 'a');
  assert.deepEqual(levels, { a: 0, b: 1, d: 1, c: 2 });
  assert.deepEqual([...descendants(edges, 'a')].sort(), ['b', 'c', 'd']);
  assert.deepEqual(ancestors(edges, 'c', 1), ['b']);
  assert.deepEqual(ancestors(edges, 'c'), ['b', 'a']);
  assert.deepEqual(topoSort(['x', 'y'], [{ from: 'x', to: 'y' }, { from: 'y', to: 'x' }]).cycle.sort(), ['x', 'y']);
});

test('db: nested tx rolls back only the savepoint; async callbacks are refused', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (x)');
  db.tx(() => {
    db.run('INSERT INTO t VALUES (1)');
    assert.throws(() =>
      db.tx(() => {
        db.run('INSERT INTO t VALUES (2)');
        throw new Error('inner');
      }),
    );
  });
  assert.deepEqual(db.all('SELECT x FROM t').map((r) => r.x), [1]);
  assert.throws(() => db.tx(async () => {}), /synchronous/);
  db.migrate([{ id: 'm1', up: 'CREATE TABLE m (y)' }]);
  db.migrate([{ id: 'm1', up: 'CREATE TABLE m (y)' }]); // idempotent
  db.close();
});

test('event bus isolates throwing listeners and separates relayed events', () => {
  const errors = [];
  const bus = new EventBus({ onListenerError: (e) => errors.push(e.message) });
  const local = [];
  const all = [];
  bus.subscribe(() => {
    throw new Error('boom');
  });
  bus.subscribe((e) => local.push(e.type));
  bus.subscribeAll((e) => all.push(e.type));
  bus.publish('a.b', {});
  bus.relay({ seq: 1, type: 'remote.x', payload: {}, peer: 'p' });
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(local, ['a.b']);
  assert.deepEqual(all, ['a.b', 'remote.x']);
});

test('tasks: dependencies, cycles, cross-project deps, delete re-publishes dependents', async (t) => {
  const app = makeApp(t);
  const [p] = await app.call('projects.list');
  const other = await app.call('projects.create', { name: 'other' });
  const a = await app.call('tasks.create', { projectId: p.id, title: 'A' });
  const b = await app.call('tasks.create', { projectId: p.id, title: 'B', dependsOn: [a.id] });
  await assert.rejects(app.call('tasks.addDependency', { taskId: a.id, dependsOn: b.id }), /cycle/);
  const x = await app.call('tasks.create', { projectId: other.id, title: 'X' });
  await assert.rejects(app.call('tasks.update', { id: b.id, dependsOn: [x.id] }), /same project/);
  await assert.rejects(app.call('tasks.update', { id: b.id, priority: 1.5 }), /integer/);
  const graph = await app.call('tasks.graph', { projectId: p.id });
  assert.deepEqual(graph.edges, [{ from: a.id, to: b.id }]);
  const events = [];
  app.bus.subscribe((e) => events.push(e));
  const res = await app.call('tasks.delete', { id: a.id });
  assert.deepEqual(res.affectedTaskIds, [b.id]);
  assert.ok(events.some((e) => e.type === 'task.updated' && e.payload.task.id === b.id));
  assert.deepEqual((await app.call('tasks.get', { id: b.id })).dependsOn, []);
});

test('tasks: positions rebalance when midpoints get crowded', async (t) => {
  const app = makeApp(t);
  const [p] = await app.call('projects.list');
  const a = await app.call('tasks.create', { projectId: p.id, title: 'A', status: 'todo' });
  const b = await app.call('tasks.create', { projectId: p.id, title: 'B', status: 'todo' });
  await app.call('tasks.move', { id: b.id, status: 'todo', position: a.position + 1e-9 });
  const list = await app.call('tasks.list', { projectId: p.id, status: 'todo' });
  assert.deepEqual(list.map((x) => x.position), [1, 2]);
});

/** fetch() cannot forge the Host header; node:http can. */
function statusWithHost(base, path, host) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: u.hostname, port: u.port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('http: host/origin/content-type guards, malformed URL, token mode', async (t) => {
  const app = makeApp(t);
  const { url } = await listen(t, app);
  const ping = (headers = {}, body = '{"method":"system.ping"}') => fetch(`${url}/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await ping()).status, 200);
  assert.equal((await ping({ 'content-type': 'text/plain;application/json' })).status, 415);
  assert.equal((await ping({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await ping({ origin: url })).status, 200);
  assert.equal((await ping({}, 'null')).status, 400);
  assert.equal(await statusWithHost(url, '/api/health', 'evil.com'), 403, 'DNS-rebinding style Host is refused');
  assert.equal((await fetch(`${url}/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`${url}/`)).status, 200);
  const unknown = await rpc(url, 'nope.x');
  assert.equal(unknown.body.error.code, -32601);

  const secured = await listen(t, app, { token: 't'.repeat(32) });
  assert.equal((await rpc(secured.url, 'system.ping')).status, 401);
  assert.equal((await rpc(secured.url, 'system.ping', {}, { 'x-todo-devs-token': 't'.repeat(32) })).status, 200);
  assert.equal(await statusWithHost(secured.url, '/', 'phone.lan'), 200, 'token mode accepts any Host');
  assert.equal((await fetch(`${secured.url}/api/rpc?token=${'t'.repeat(32)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"method":"system.ping"}' })).status, 401, 'query tokens are not accepted for RPC');
});

test('sse stream delivers published events with numeric ids', async (t) => {
  const app = makeApp(t);
  const { url } = await listen(t, app);
  const controller = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: controller.signal });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  await app.call('projects.create', { name: 'sse' });
  let text = '';
  while (!text.includes('project.created')) text += (await reader.read()).value;
  controller.abort();
  assert.match(text, /id: \d+\ndata: \{.*"type":"project\.created"/);
});
