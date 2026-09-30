// Tests for the React-free app core (src/core). Run with Node's type stripping:
//   node --test "test/*.test.ts"
// The server tests talk to a real todo.devs server from this repository.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApi } from '../src/core/api.ts';
import { COLUMNS, groupByColumn, lanes, progress, taskActions, timeAgo } from '../src/core/board.ts';
import { ApiError, NETWORK, TodoDevsClient, normalizeBaseUrl } from '../src/core/client.ts';
import { EventFeed, type FeedStatus } from '../src/core/events.ts';
import { hostOf, isValidCode, normalizeCode, parsePairingLink } from '../src/core/links.ts';
import type { Task } from '../src/core/types.ts';
// Plain JS modules of the server (this file is not type-checked by the app's tsconfig).
import { createApp } from '../../../src/server/app.js';
import { PairingCodes } from '../../../src/server/core/auth.js';
import { createHttpServer } from '../../../src/server/http/server.js';

process.env.TODO_DEVS_MOCK_DELAY_MS = '40';
const TOKEN = 'x'.repeat(32);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A network-mode server (token + pairing) on a random port, restartable on the same home/port. */
async function startServer(t: TestContext, existingHome?: string, port = 0) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'mobile-core-'));
  const app = createApp({ home, log: () => {} });
  const pairing = new PairingCodes(TOKEN);
  const server = createHttpServer(app, { token: TOKEN, pairing });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await app.close();
  };
  // Only the call that created the home removes it (a restarted server reuses it).
  t.after(async () => {
    await stop();
    if (!existingHome) rmSync(home, { recursive: true, force: true });
  });
  return { app, pairing, home, port: server.address().port as number, url: `http://127.0.0.1:${server.address().port}`, stop };
}

test('normalizeBaseUrl and pairing links', () => {
  assert.equal(normalizeBaseUrl('192.168.0.5'), 'http://192.168.0.5:7420');
  assert.equal(normalizeBaseUrl('Box.tail1.ts.net:7420/'), 'http://box.tail1.ts.net:7420');
  assert.equal(normalizeBaseUrl('https://a.b'), 'https://a.b');
  assert.equal(normalizeBaseUrl('[fd00::1]'), 'http://[fd00::1]:7420');
  assert.throws(() => normalizeBaseUrl('not an address'));
  assert.equal(normalizeCode('abcde-fghjk'), 'ABCDEFGHJK');
  assert.equal(isValidCode('abcde-fghjk'), true);
  assert.equal(isValidCode('abc'), false);
  assert.deepEqual(parsePairingLink('todo-devs://pair?url=http%3A%2F%2F100.64.0.2%3A7420&code=abcde-fghjk&name=box'), { url: 'http://100.64.0.2:7420', code: 'ABCDEFGHJK', name: 'box' });
  assert.deepEqual(parsePairingLink('http://10.0.0.2:7420/#pair=ABCDEFGHJK'), { url: 'http://10.0.0.2:7420', code: 'ABCDEFGHJK' });
  assert.equal(parsePairingLink('hello'), null);
  assert.equal(hostOf('http://[::1]:7420'), '[::1]');
});

test('board helpers: columns, progress, lanes, actions', () => {
  const task = (id: string, status: Task['status'], dependsOn: string[] = [], extra: Partial<Task> = {}) => ({ id, status, dependsOn, position: 1, priority: 1, assigneeId: 'agt', ...extra }) as Task;
  const tasks = [task('a', 'done'), task('b', 'todo', ['a']), task('c', 'blocked', ['b']), task('d', 'todo', ['b'])];
  const groups = groupByColumn(tasks);
  assert.equal(groups.failed!.length, 1, 'blocked shows in the failed column');
  assert.equal(COLUMNS.length, 6);
  assert.deepEqual(progress(tasks), { total: 4, done: 1, running: 0, review: 0, failed: 1, ratio: 0.25 });
  const byId = new Map(tasks.map((x) => [x.id, x]));
  assert.equal(taskActions(byId.get('b')!, byId).canRun, true);
  assert.equal(taskActions(byId.get('d')!, byId).canForceRun, true);
  assert.deepEqual(lanes({ tasks, edges: [], levels: { a: 0, b: 1, c: 2, d: 2 } }).map((l) => l.map((x) => x.id)), [['a'], ['b'], ['c', 'd']]);
  assert.equal(timeAgo(new Date(Date.now() - 120_000).toISOString()), '2m ago');
});

test('client: pairing, RPC errors, unreachable server', async (t) => {
  const srv = await startServer(t);
  const { code } = srv.pairing.create();
  assert.equal(await TodoDevsClient.pair(srv.url, code), TOKEN);
  await assert.rejects(TodoDevsClient.pair(srv.url, code), (e: ApiError) => e.code === 403);
  const client = new TodoDevsClient({ baseUrl: srv.url, token: TOKEN });
  const api = createApi(client);
  await assert.rejects(api.tasks.get('nope'), (e: ApiError) => e.code === -32004);
  await assert.rejects(new TodoDevsClient({ baseUrl: srv.url, token: 'wrong' }).rpc('system.ping'), (e: ApiError) => e.code === 401);
  await assert.rejects(new TodoDevsClient({ baseUrl: '127.0.0.1:1', token: TOKEN }).rpc('system.ping'), (e: ApiError) => e.code === NETWORK);

  const [project] = await api.projects.list();
  const mock = (await api.agents.list()).find((a) => a.harness === 'mock')!;
  const a = await api.tasks.create({ projectId: project!.id, title: 'A', status: 'todo', assigneeId: mock.id });
  await api.tasks.create({ projectId: project!.id, title: 'B', status: 'todo', assigneeId: mock.id, dependsOn: [a.id] });
  await api.scheduler.start(project!.id, { reviewPolicy: 'wait' });
  for (let i = 0; i < 100 && (await api.scheduler.status(project!.id)).state !== 'finished'; i++) await sleep(100);
  const tasks = await api.tasks.list(project!.id);
  assert.deepEqual(tasks.map((x) => x.status), ['done', 'done']);
  const graph = await api.tasks.graph(project!.id);
  assert.deepEqual(lanes(graph).map((l) => l.map((x) => x.title)), [['A'], ['B']]);
});

test('event feed: reset first, live events, reset again after a server restart', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'mobile-core-'));
  let srv = await startServer(t, home);
  const client = new TodoDevsClient({ baseUrl: srv.url, token: TOKEN });
  const feed = new EventFeed(client, { pollTimeoutSec: 1 });
  const log: string[] = [];
  feed.onReset(() => log.push('RESET'));
  feed.subscribe((e) => log.push(e.type));
  const statuses: FeedStatus[] = [];
  feed.onStatus((s) => statuses.push(s));
  t.after(() => feed.stop());
  feed.start();
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 200 && !pred(); i++) await sleep(50);
    assert.ok(pred(), `timed out; log: ${log.join(' ')}`);
  };
  await until(() => log.includes('RESET'));
  const api = createApi(client);
  const [project] = await api.projects.list();
  await api.tasks.create({ projectId: project!.id, title: 'x' });
  await until(() => log.includes('task.created'));

  const { port } = srv;
  await srv.stop();
  await until(() => statuses.includes('offline'));
  srv = await startServer(t, home, port);
  t.after(() => rmSync(home, { recursive: true, force: true })); // after both servers stopped (hooks run in order)
  await until(() => log.filter((x) => x === 'RESET').length === 2);
  assert.equal(feed.status, 'live');
});

test('event feed: a removed remote session is terminal ("gone")', async (t) => {
  const srv = await startServer(t);
  const feed = new EventFeed(new TodoDevsClient({ baseUrl: srv.url, token: TOKEN }), { peer: 'per_deleted' });
  const errors: string[] = [];
  feed.onStatus((s, e) => s === 'gone' && errors.push(e || ''));
  t.after(() => feed.stop());
  feed.start();
  for (let i = 0; i < 100 && !errors.length; i++) await sleep(20);
  assert.match(errors[0] ?? '', /Unknown peer/);
});

test('workflows.run returns immediately with a run id', async (t) => {
  const srv = await startServer(t);
  const client = new TodoDevsClient({ baseUrl: srv.url, token: TOKEN });
  const api = createApi(client);
  const [project] = await api.projects.list();
  const mock = (await api.agents.list()).find((a) => a.harness === 'mock')!;
  const wf = await client.rpc<{ id: string }>('workflows.create', {
    name: 'slow',
    projectId: project!.id,
    graph: {
      nodes: [{ id: 's', type: 'trigger' }, { id: 'a', type: 'agent', config: { agentId: mock.id, prompt: 'hi', }, }, { id: 'o', type: 'output' }],
      edges: [{ id: 'e1', from: 's', fromPort: 'out', to: 'a', toPort: 'in' }, { id: 'e2', from: 'a', fromPort: 'out', to: 'o', toPort: 'in' }],
    },
  });
  const res = await api.workflows.run(wf.id, project!.id, {});
  assert.equal(res.status, 'running');
  assert.match(res.runId, /^run_/);
});
