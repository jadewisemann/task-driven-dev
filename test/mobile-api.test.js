import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PairingCodes, loadOrCreateToken, rotateToken, tokenMatches } from '../src/server/core/auth.js';
import { EventBus } from '../src/server/core/events.js';
import { EventHistory } from '../src/server/core/history.js';
import { cli, rpc, sleep, startDaemon, tmpHome } from './helpers.js';

const NET = ['--host', '0.0.0.0'];

test('auth: persisted 0600 token, atomic rotate, corrupt file is an error', (t) => {
  const home = tmpHome(t);
  const token = loadOrCreateToken(home);
  assert.equal(loadOrCreateToken(home), token);
  assert.equal(statSync(join(home, 'auth.json')).mode & 0o777, 0o600);
  chmodSync(join(home, 'auth.json'), 0o644);
  loadOrCreateToken(home);
  assert.equal(statSync(join(home, 'auth.json')).mode & 0o777, 0o600, 'loose permissions are tightened');
  assert.notEqual(rotateToken(home), token);
  writeFileSync(join(home, 'auth.json'), '{oops');
  assert.throws(() => loadOrCreateToken(home), /corrupt/);
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('abc', undefined), false);
});

test('pairing codes: single use, normalized input, rate limited', () => {
  const codes = new PairingCodes('TOKEN');
  const { code } = codes.create();
  assert.match(code, /^[A-Z2-9]{10}$/);
  assert.equal(codes.redeem(`${code.slice(0, 5).toLowerCase()}-${code.slice(5)}`), 'TOKEN');
  assert.equal(codes.redeem(code), null, 'second use fails');
  for (let i = 0; i < 8; i++) codes.redeem('AAAAAAAAAA');
  assert.throws(() => codes.redeem('AAAAAAAAAA'), /Too many/);
});

test('event history: cursors, peer filter, restart and overflow resets, waiters', async () => {
  const bus = new EventBus();
  const history = new EventHistory(bus, { capacity: 5 });
  const head = await history.wait(0, () => true);
  bus.publish('a', {});
  bus.relay({ seq: 1, type: 'remote', payload: {}, peer: 'p1' });
  const local = history.since(head.cursor, (e) => !e.peer);
  assert.deepEqual(local.events.map((e) => e.type), ['a']);
  assert.equal(local.cursor, head.cursor + 2, 'non-matching entries still advance the cursor');
  assert.equal(history.since(1, () => true).reset, true, 'cursor from another process');
  assert.equal(history.since(head.cursor + 999, () => true).reset, true, 'cursor ahead of the server');
  for (let i = 0; i < 10; i++) bus.publish('x', {});
  assert.equal(history.since(head.cursor, () => true).reset, true, 'fell behind the buffer');
  const pending = history.wait(history.cursor, () => true, { timeoutMs: 5000 });
  bus.publish('wake', {});
  assert.deepEqual((await pending).events.map((e) => e.type), ['wake']);
  const t0 = Date.now();
  const idle = history.wait(history.cursor, () => true, { timeoutMs: 5000 });
  history.close();
  await idle;
  assert.ok(Date.now() - t0 < 1000, 'close releases waiters');
});

test('network mode: token gate, one-time pairing, long-poll, restart keeps token and resets cursors', async (t) => {
  const home = tmpHome(t);
  let daemon = await startDaemon(t, home, NET);
  const token = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')).token;
  assert.equal(daemon.token, token);
  assert.ok(!daemon.output().includes(token), 'the token is not printed');
  const T = { 'x-todo-devs-token': token };
  assert.equal((await rpc(daemon.url, 'system.ping')).status, 401);
  assert.equal((await rpc(daemon.url, 'system.ping', {}, { 'x-todo-devs-token': 'nope' })).status, 401);
  assert.equal((await rpc(daemon.url, 'system.ping', {}, T)).status, 200);
  assert.equal((await fetch(`${daemon.url}/`)).headers.get('referrer-policy'), 'no-referrer');

  const pairing = (await rpc(daemon.url, 'system.pairing', {}, T)).body.result;
  assert.ok(!JSON.stringify(pairing).includes(token), 'links never contain the token');
  const redeem = (code) => fetch(`${daemon.url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).then(async (r) => [r.status, await r.json()]);
  assert.deepEqual(await redeem(pairing.code), [200, { token }]);
  assert.equal((await redeem(pairing.code))[0], 403);

  const poll = (after, timeout = 5) => fetch(`${daemon.url}/api/events/poll?after=${after}&timeout=${timeout}`, { headers: T }).then((r) => r.json());
  const head = await poll(0);
  const pending = poll(head.cursor, 10);
  await sleep(200);
  const [project] = (await rpc(daemon.url, 'projects.list', {}, T)).body.result;
  await rpc(daemon.url, 'tasks.create', { projectId: project.id, title: 'from phone' }, T);
  const got = await pending;
  assert.deepEqual(got.events.map((e) => e.type), ['task.created']);
  assert.equal(got.epoch, head.epoch);

  await daemon.stop();
  daemon = await startDaemon(t, home, NET);
  assert.equal((await rpc(daemon.url, 'system.ping', {}, T)).status, 200, 'paired devices survive restarts');
  const res = await fetch(`${daemon.url}/api/events/poll?after=${got.cursor}&timeout=1`, { headers: T }).then((r) => r.json());
  assert.equal(res.reset, true);
  assert.notEqual(res.epoch, got.epoch);

  const pair = await cli(['pair', '--home', home]);
  assert.equal(pair.code, 0, pair.stderr);
  assert.match(pair.stdout, /Pairing code [A-Z2-9]{10}/);
});
