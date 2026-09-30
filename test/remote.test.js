import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createLineReader } from '../src/remote/jsonl.js';
import { transportSpec } from '../src/server/remote/peers.js';
import { cli, FIXTURES, fakeSshEnv, makeApp, onCleanup, setup, sleep, startDaemon, tmpHome, waitFor } from './helpers.js';

const SSH = join(FIXTURES, 'bin', 'ssh');

/** Peers spawn `ssh` / `todo-devs` from PATH: point PATH at the fake ones for this process. */
function useFakeSsh(t) {
  const env = fakeSshEnv();
  setEnv(t, env);
  return env;
}

/** Sets env vars for one test and restores (or deletes) them afterwards. */
function setEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  onCleanup(t, () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('jsonl: partial lines, oversize discard, throwing handlers are isolated', async () => {
  const stream = new PassThrough();
  const got = [];
  const errors = [];
  createLineReader(stream, (m) => (m.boom ? (() => { throw new Error('boom'); })() : got.push(m)), { onError: (e) => errors.push(e.message), maxLine: 1000 });
  stream.write('{"a":1}\n{"bo');
  stream.write('om":true}\n' + 'x'.repeat(3000));
  stream.write('{"tail":1}\n{"b":2}\n');
  await sleep(10);
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
  assert.equal(errors.length, 2);
});

test('peers: ssh argv hardening', async (t) => {
  const spec = (options) => transportSpec({ transport: 'ssh', target: 'u@h', remoteCommand: 'todo-devs', options }).args;
  assert.deepEqual(spec({}).slice(-3), ['--', 'u@h', 'todo-devs rpc']);
  assert.equal(spec({ remoteHome: "~/my dir/it's" }).at(-1), `todo-devs rpc --home ~/'my dir/it'\\''s'`);
  const app = makeApp(t);
  await assert.rejects(app.call('peers.add', { name: 'x', target: '-oProxyCommand=evil' }), /user@host/);
  await assert.rejects(app.call('peers.add', { name: 'x', target: 'a@b', remoteCommand: 'todo-devs; rm -rf /' }), /remoteCommand/);
  await assert.rejects(app.call('peers.add', { name: 'x', target: 'a@b', options: { sshArgs: ['-oProxyCommand=touch /tmp/pwn'] } }), /not allowed/);
  await assert.rejects(app.call('peers.add', { name: 'x', target: 'a@b', options: { sshCommand: '/bin/sh' } }), /ssh binary/);
  const ok = await app.call('peers.add', { name: 'x', target: 'a@b', options: { sshArgs: ['-o', 'StrictHostKeyChecking=accept-new', '-J', 'jump@bastion'] } });
  assert.deepEqual(ok.options.sshArgs, ['-o', 'StrictHostKeyChecking=accept-new', '-J', 'jump@bastion']);
});

test('peers: ssh session to an embedded remote, event relay, blocked methods, reconnect', async (t) => {
  useFakeSsh(t);
  const app = makeApp(t);
  const remoteHome = tmpHome(t);
  const log = join(tmpHome(t), 'ssh.log');
  setEnv(t, { FAKE_SSH_LOG: log });
  await app.call('peers.add', { name: 'box', target: 'dev@box.local', options: { sshCommand: SSH, remoteHome, port: 2222 } });
  const call = (method, params = {}) => app.dispatch({ jsonrpc: '2.0', id: 1, method, params, peer: 'box' }).then((r) => (r.error ? Promise.reject(Object.assign(new Error(r.error.message), r.error)) : r.result));

  const info = await call('system.info');
  assert.equal(info.home, remoteHome);
  assert.match(readFileSync(log, 'utf8'), /-p 2222 -- dev@box\.local todo-devs rpc --home/);
  const relayed = [];
  app.bus.subscribeAll((e) => e.peer && relayed.push(e.type));
  const [project] = await call('projects.list');
  const task = await call('tasks.create', { projectId: project.id, title: 'remote task' });
  await waitFor(() => relayed.includes('task.created'));
  assert.equal((await app.call('tasks.list')).length, 0, 'nothing was created locally');
  await assert.rejects(app.peers.call('box', 'peers.list', {}), /not available/);
  await assert.rejects(app.peers.call('box', 'system.pairing', {}), /not available/);
  await assert.rejects(call('nope.x'), (e) => e.code === -32601);
  app.peers.disconnect('box');
  assert.equal((await call('tasks.get', { id: task.id })).title, 'remote task', 'lazy reconnect');
});

test('peers: remote with a running server forwards calls and relays its events', async (t) => {
  const env = useFakeSsh(t);
  const remoteHome = tmpHome(t);
  const daemon = await startDaemon(t, remoteHome, [], env);
  const app = makeApp(t);
  await app.call('peers.add', { name: 'srv', transport: 'exec', target: `todo-devs rpc --home ${remoteHome}` });
  const { info } = await app.call('peers.connect', { id: 'srv' });
  assert.equal(info.mode, 'daemon');
  assert.equal(info.pid, daemon.child.pid);
  const relayed = [];
  app.bus.subscribeAll((e) => e.peer && relayed.push(e.type));
  const call = (method, params = {}) => app.dispatch({ jsonrpc: '2.0', id: 1, method, params, peer: 'srv' }).then((r) => r.result);
  const [project] = await call('projects.list');
  const mock = (await call('agents.list')).find((a) => a.harness === 'mock');
  await call('tasks.create', { projectId: project.id, title: 'run me remotely', status: 'todo', assigneeId: mock.id });
  await call('scheduler.start', { projectId: project.id });
  await waitFor(() => relayed.includes('scheduler.finished'), { timeoutMs: 20000 });
  const tasks = await (await fetch(`${daemon.url}/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'tasks.list', params: { projectId: project.id } }) })).json();
  assert.deepEqual(tasks.result.map((x) => x.status), ['done']);
});

test('peers: a hostile peer cannot crash the server, forge frames or touch local tasks', async (t) => {
  const app = makeApp(t);
  const { project, mock } = await setup(app);
  setEnv(t, { TODO_DEVS_MOCK_DELAY_MS: '1200' });
  const task = await app.call('tasks.create', { projectId: project.id, title: 'local', status: 'todo', assigneeId: mock.id });
  const evil = join(tmpHome(t), 'evil.sh');
  writeFileSync(
    evil,
    // printf, not echo: dash/macOS sh echo would turn the "\\n" inside the JSON into real newlines.
    `#!/bin/sh
printf '%s\\n' '{"jsonrpc":"2.0","method":"hello","params":{"host":"evil","mode":"daemon"}}'
printf '%s\\n' 'null' '42'
printf '%s\\n' '{"jsonrpc":"2.0","method":"event","params":{"seq":"1\\ndata: {}\\n","type":"task.deleted","payload":{"projectId":"${project.id}","taskId":"${task.id}"}}}'
sleep 1
`,
  );
  chmodSync(evil, 0o755);
  await app.call('peers.add', { name: 'evil', transport: 'exec', target: evil });
  const relayed = [];
  app.bus.subscribeAll((e) => e.peer && relayed.push(e));
  const run = app.runner.executeTask(task.id);
  await app.call('peers.connect', { id: 'evil' });
  const res = await run;
  assert.equal(res.outcome, 'done', 'the relayed task.deleted did not cancel the local run');
  await waitFor(() => relayed.length > 0);
  assert.equal(relayed[0].seq, 0, 'non-numeric seq is sanitized');
});

test('cli: status/peer ping through one ssh session; run/plan need a server', async (t) => {
  const env = useFakeSsh(t);
  const home = tmpHome(t);
  const remoteHome = tmpHome(t);
  const log = join(tmpHome(t), 'ssh.log');
  const run = (...args) => cli([...args, '--home', home], { env: { ...env, FAKE_SSH_LOG: log } });
  assert.equal((await run('peer', 'add', 'box', 'dev@box', '--remote-home', remoteHome)).code, 0);
  const status = await run('status', '--peer', 'box');
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /scheduler: idle/);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'one command = one ssh session');
  assert.match((await run('peer', 'ping', 'box')).stdout, /box: .* ms/);
  const noDaemon = await run('run');
  assert.equal(noDaemon.code, 1);
  assert.match(noDaemon.stderr, /needs a running server/);
  assert.match((await run('plan', 'x', '--peer', 'box')).stderr, /needs a running server on box/);
});
