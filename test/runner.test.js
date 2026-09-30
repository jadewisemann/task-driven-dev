import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProcess } from '../src/server/runtime/process.js';
import { boardStatusFor, parseResult } from '../src/server/runtime/result.js';
import { makeApp, nextEvent, setup, sleep } from './helpers.js';

test('process: background children cannot keep a run alive', async () => {
  const t0 = Date.now();
  const r = await runProcess({ command: 'sh', args: ['-c', 'sleep 30 & echo started'], timeoutMs: 5000 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'started');
  assert.ok(Date.now() - t0 < 3000);
});

test('process: timeout kills a SIGTERM-ignoring child', async () => {
  const r = await runProcess({ command: 'sh', args: ['-c', 'trap "" TERM; sleep 30'], timeoutMs: 300 });
  assert.equal(r.timedOut, true);
});

test('process: abort, missing command, utf8 tail capture', async () => {
  const controller = new AbortController();
  const pending = runProcess({ command: 'sleep', args: ['30'], signal: controller.signal });
  controller.abort();
  assert.equal((await pending).cancelled, true);
  assert.equal((await runProcess({ command: 'definitely-not-a-command-xyz' })).code, 127);
  const r = await runProcess({ command: process.execPath, args: ['-e', 'for(let i=0;i<60000;i++)process.stdout.write("한글텍스트 "+i+"\\n");console.log("```json\\n{\\"status\\":\\"needs_review\\"}\\n```")'] });
  assert.equal((r.stdout.match(/\uFFFD/g) || []).length, 0);
  assert.equal(parseResult(r.stdout).status, 'needs_review');
});

test('result parsing and board status mapping', () => {
  assert.deepEqual(parseResult('x\n```json\n{"status":"failed"}\n```\n'), { status: 'failed' });
  assert.equal(parseResult('no json'), null);
  assert.equal(boardStatusFor({ status: 'needs_review' }, true), 'review');
  assert.equal(boardStatusFor(null, false), 'failed');
  assert.equal(boardStatusFor(null, true, { truncated: true }), 'review');
  assert.equal(boardStatusFor(null, true), 'done');
});

test('scheduler: diamond DAG, retries, blocking, release after fix, stop', async (t) => {
  const app = makeApp(t);
  const { project, mock } = await setup(app);
  await app.call('agents.update', { id: mock.id, config: { retries: 1 } });
  const mk = (title, deps = [], input) => app.call('tasks.create', { projectId: project.id, title, status: 'todo', assigneeId: mock.id, dependsOn: deps, input });
  const A = await mk('A');
  const B = await mk('B', [A.id]);
  const C = await mk('C', [A.id], { mock: { fail: 1 } });
  const D = await mk('D', [B.id, C.id], { mock: { status: 'needs_review' } });
  const E = await mk('E', [], { mock: { fail: true } });
  const F = await mk('F', [E.id]);
  const started = [];
  app.bus.subscribe((e) => e.type === 'run.started' && started.push(e.payload.run.taskId));
  let finished = nextEvent(app, (e) => e.type === 'scheduler.finished');
  await app.call('scheduler.start', { projectId: project.id, concurrency: 2, reviewPolicy: 'auto-approve' });
  const done = await finished;
  assert.deepEqual(done.payload.scheduler.stats, { succeeded: 4, failed: 1, retried: 2, review: 0 });
  const status = async (x) => (await app.call('tasks.get', { id: x.id })).status;
  assert.equal(await status(D), 'done');
  assert.equal(await status(E), 'failed');
  assert.equal(await status(F), 'blocked');
  assert.ok(started.indexOf(A.id) < started.indexOf(B.id) && started.indexOf(B.id) < started.indexOf(D.id), 'dependency order');

  await app.call('tasks.update', { id: E.id, input: {} });
  await app.call('tasks.retry', { taskId: E.id });
  finished = nextEvent(app, (e) => e.type === 'scheduler.finished');
  await app.call('scheduler.start', { projectId: project.id });
  await finished;
  assert.equal(await status(F), 'done', 'blocked successor released after the fix');

  const G = await mk('G', [], { mock: { delayMs: 3000 } });
  await app.call('scheduler.start', { projectId: project.id });
  await sleep(200);
  await app.call('scheduler.stop', { projectId: project.id });
  await sleep(300);
  assert.equal(await status(G), 'todo', 'stopped task returns to todo');
});

test('runner: running tasks cannot be moved; deleting cancels; backlog is never promoted', async (t) => {
  const app = makeApp(t);
  const { project, mock } = await setup(app);
  const busy = await app.call('tasks.create', { projectId: project.id, title: 'busy', status: 'todo', assigneeId: mock.id, input: { mock: { delayMs: 800 } } });
  const run = app.runner.executeTask(busy.id);
  await sleep(50);
  await assert.rejects(app.call('tasks.move', { id: busy.id, status: 'done' }), /running/);
  await run;

  const doomed = await app.call('tasks.create', { projectId: project.id, title: 'doomed', status: 'todo', assigneeId: mock.id, input: { mock: { delayMs: 2000 } } });
  const pending = app.runner.executeTask(doomed.id);
  await sleep(50);
  await app.call('tasks.delete', { id: doomed.id });
  const res = await pending;
  assert.equal(res.outcome, 'cancelled');
  assert.equal(app.runner.isTaskActive(doomed.id), false);

  await app.call('agents.update', { id: mock.id, config: { retries: 0 } });
  const A = await app.call('tasks.create', { projectId: project.id, title: 'A fails', status: 'todo', assigneeId: mock.id, input: { mock: { fail: true } } });
  const B = await app.call('tasks.create', { projectId: project.id, title: 'B backlog', status: 'backlog', assigneeId: mock.id, dependsOn: [A.id] });
  let fin = nextEvent(app, (e) => e.type === 'scheduler.finished');
  await app.call('scheduler.start', { projectId: project.id });
  await fin;
  await app.call('tasks.update', { id: A.id, input: {} });
  await app.call('tasks.retry', { taskId: A.id });
  fin = nextEvent(app, (e) => e.type === 'scheduler.finished');
  await app.call('scheduler.start', { projectId: project.id });
  await fin;
  assert.equal((await app.call('tasks.get', { id: B.id })).status, 'backlog');
});

test('runs: logs are stored (coalesced) and runs.list/logs work', async (t) => {
  const app = makeApp(t);
  const { project, mock } = await setup(app);
  const task = await app.call('tasks.create', { projectId: project.id, title: 'x', status: 'todo', assigneeId: mock.id });
  await assert.rejects(app.call('tasks.run', { taskId: (await app.call('tasks.create', { projectId: project.id, title: 'unassigned' })).id }), /Assign/);
  const res = await app.runner.executeTask(task.id);
  assert.equal(res.outcome, 'done');
  const [run] = await app.call('runs.list', { taskId: task.id });
  assert.equal(run.status, 'succeeded');
  const logs = await app.call('runs.logs', { runId: run.id });
  assert.ok(logs.length > 0 && logs.length < 20);
  assert.match(logs.map((l) => l.text).join(''), /Mocky/);
});
