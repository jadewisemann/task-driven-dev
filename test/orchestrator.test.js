import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignAgents } from '../src/server/orchestrator/assigner.js';
import { heuristicPlan, normalizePlan } from '../src/server/orchestrator/planner.js';
import { makeApp, nextEvent, setup, sleep, tmpHome, waitFor } from './helpers.js';

const shape = (goal) => heuristicPlan(goal).tasks.map((t) => `${t.key}:${t.role}${t.dependsOn.length ? `<${t.dependsOn.join('+')}` : ''}`);

test('heuristic planner: Korean and English, lists, parallel vs ordered', () => {
  assert.deepEqual(shape('로그인 API를 만들고 그 다음 로그인 화면을 만든다. 그리고 테스트를 작성한다'), ['t1:backend', 't2:frontend<t1', 't3:qa<t1+t2', 't4:reviewer<t3']);
  assert.deepEqual(shape('Add Stripe checkout: backend endpoint, checkout page, webhooks, tests'), ['t1:backend', 't2:frontend', 't3:engineer', 't4:qa<t1+t2+t3', 't5:reviewer<t4']);
  assert.deepEqual(shape('- Build API\n- Build UI\n- Write docs'), ['t1:backend', 't2:frontend', 't3:writer<t1+t2', 't4:reviewer<t3']);
  assert.deepEqual(shape('1. Design schema\n2. Build API\n3. Write tests'), ['t1:backend', 't2:backend<t1', 't3:qa<t1+t2', 't4:reviewer<t3']);
  assert.equal(heuristicPlan('Add authentication, a firstName field').tasks[1].dependsOn.length, 0, '"then"/"first" inside words are not ordering');
});

test('normalizePlan: drops unknown deps and breaks only real cycles', () => {
  const p = normalizePlan({ tasks: [{ key: 'C', title: 'C', dependsOn: ['A'] }, { key: 'A', title: 'A', dependsOn: ['B', 'zz'] }, { key: 'B', title: 'B', dependsOn: ['A'] }] });
  assert.deepEqual(Object.fromEntries(p.tasks.map((t) => [t.key, t.dependsOn])), { C: ['A'], A: [], B: ['A'] });
  assert.equal(p.warnings.length, 2);
});

test('assigner: capable first, cheapest tier, no needless orchestrator borrowing', () => {
  const team = [
    { id: 'L', name: 'Lead', role: 'orchestrator', tier: 3 },
    { id: 'B', name: 'Bee', role: 'backend', tier: 2 },
    { id: 'W', name: 'Wri', role: 'writer', tier: 3 },
    { id: 'S', name: 'Small', role: 'engineer', tier: 1 },
  ];
  const [hard, easy] = assignAgents([{ key: 'a', role: 'backend', complexity: 4 }, { key: 'b', role: 'engineer', complexity: 1, agent: 'Wri' }], team);
  assert.equal(hard.agentName, 'Wri');
  assert.equal(easy.agentName, 'Small', 'over-powered suggestion is not honoured');
  const [lead] = assignAgents([{ key: 'c', role: 'backend', complexity: 5 }], team.filter((a) => a.id !== 'W'));
  assert.equal(lead.agentName, 'Lead');
});

test('orchestrator: plan & run to finished; plan-scoped scheduling', async (t) => {
  const app = makeApp(t);
  const { project, mock } = await setup(app, { allMock: true });
  const unrelated = await app.call('tasks.create', { projectId: project.id, title: 'unrelated', status: 'todo', assigneeId: mock.id });
  const finished = nextEvent(app, (e) => e.type === 'plan.updated' && ['finished', 'incomplete'].includes(e.payload.plan.status), 30000);
  const plan = await app.call('orchestrator.plan', { projectId: project.id, goal: 'Build a signup API, then a signup page, then write tests', autoRun: true, reviewPolicy: 'auto-approve' });
  assert.equal(plan.status, 'planning');
  const done = (await finished).payload.plan;
  assert.equal(done.status, 'finished');
  assert.equal(done.taskIds.length, 4);
  assert.match(done.summary, /4\/4 done/);
  assert.equal((await app.call('tasks.get', { id: unrelated.id })).status, 'todo', 'unrelated cards are not run');
});

test('orchestrator: apply validates edits; discard sticks; restart fails stuck plans', async (t) => {
  const home = tmpHome(t);
  let app = makeApp(t, { home });
  const { project, agents } = await setup(app);
  const lead = agents.find((a) => a.role === 'orchestrator');
  await app.call('agents.update', { id: lead.id, harness: 'shell', config: { command: 'sleep 2; echo nothing' } });
  const p1 = await app.call('orchestrator.plan', { projectId: project.id, goal: 'A, B', autoRun: true });
  await sleep(200);
  await app.call('orchestrator.discard', { planId: p1.id });
  await sleep(2500);
  assert.equal((await app.call('orchestrator.get', { planId: p1.id })).status, 'discarded');
  assert.equal((await app.call('tasks.list', { projectId: project.id })).length, 0);

  await app.call('agents.update', { id: lead.id, harness: 'mock' });
  const p2 = await app.call('orchestrator.plan', { projectId: project.id, goal: 'Fix typo in README; refactor auth architecture' });
  const draft = await waitFor(async () => {
    const p = await app.call('orchestrator.get', { planId: p2.id });
    return p.status === 'draft' && p;
  });
  await assert.rejects(app.call('orchestrator.apply', { planId: p2.id, tasks: [draft.plan.tasks[0], draft.plan.tasks[0]] }), /Duplicate task key/);
  const edited = draft.plan.tasks.slice(0, 2).map((t) => ({ ...t, agentId: null }));
  const applied = await app.call('orchestrator.apply', { planId: p2.id, tasks: edited });
  assert.equal(applied.taskIds.length, 2);
  assert.ok((await app.call('tasks.list', { projectId: project.id })).every((x) => x.assigneeId));

  await app.call('agents.update', { id: lead.id, harness: 'shell', config: { command: 'sleep 5' } });
  const stuck = await app.call('orchestrator.plan', { projectId: project.id, goal: 'X then Y' });
  await app.close();
  app = makeApp(t, { home, recover: true });
  assert.equal((await app.call('orchestrator.get', { planId: stuck.id })).status, 'failed');
});
