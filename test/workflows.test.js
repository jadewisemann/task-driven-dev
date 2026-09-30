import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runGraph, validateGraph } from '../src/server/workflow/engine.js';
import { evaluateCondition, getPath, renderTemplate } from '../src/server/workflow/expr.js';
import { workflowTemplates } from '../src/server/workflow/templates.js';
import { makeApp, setup } from './helpers.js';

const edge = (id, from, to, fromPort = 'out') => ({ id, from, fromPort, to, toPort: 'in' });
const crashEnv = { runAgent: async () => ({ code: 1, output: 'boom', stderr: 'harness crashed', result: null }) };

test('expressions: paths, templates, conditions, prototype safety', () => {
  const scope = { input: { json: { status: 'approved', items: [{ id: 7 }] } }, visits: { review: 2 } };
  assert.equal(getPath(scope, 'input.json.items[0].id'), 7);
  assert.equal(getPath(scope, 'input.__proto__'), undefined);
  assert.deepEqual(renderTemplate('{{input.json}}', scope), scope.input.json);
  assert.equal(renderTemplate('n={{visits.review}}', scope), 'n=2');
  assert.equal(evaluateCondition({ path: 'input.json.status', op: 'eq', value: 'approved' }, scope), true);
  assert.equal(evaluateCondition({ path: 'visits.review', op: 'lt', value: 3 }, scope), true);
  assert.equal(evaluateCondition({ path: 'input.json', op: 'eq', value: { other: 1 } }, scope), false, 'objects compare structurally');
});

test('validation: types, start node, edge ids, router defaults', () => {
  assert.match(validateGraph({ nodes: [{ id: 'a', type: 'nope' }], edges: [] }).join(), /unknown type/);
  assert.match(validateGraph({ nodes: [{ id: 's', type: 'trigger' }, { id: 'o', type: 'output' }], edges: [{ from: 's', fromPort: 'out', to: 'o' }] }).join(), /string id/);
  const routerDefaults = { nodes: [{ id: 's', type: 'trigger' }, { id: 'r', type: 'router', config: {} }, { id: 'o', type: 'output' }], edges: [edge('a', 's', 'r'), edge('b', 'r', 'o', 'approved')] };
  assert.deepEqual(validateGraph(routerDefaults), []);
});

test('engine: unconnected error port fails the run; wired error port handles it', async () => {
  const loop = workflowTemplates([]).find((t) => t.key === 'implement-review-loop').graph;
  const crashed = await runGraph({ graph: loop, vars: { prompt: 'x', task: {} }, env: crashEnv });
  assert.equal(crashed.status, 'failed');
  assert.equal(crashed.failedNode, 'implement');
  const handled = await runGraph({
    graph: { nodes: [{ id: 's', type: 'trigger' }, { id: 'a', type: 'agent', config: { agentId: 'x' } }, { id: 'o', type: 'output', config: { text: 'handled {{input.error}}' } }], edges: [edge('e1', 's', 'a'), edge('e2', 'a', 'o', 'error')] },
    env: crashEnv,
  });
  assert.equal(handled.status, 'succeeded');
  assert.equal(handled.result.text, 'handled harness crashed');
});

test('engine: shell values are arguments, never shell code', async () => {
  const graph = { nodes: [{ id: 's', type: 'trigger' }, { id: 'sh', type: 'shell', config: { command: 'echo "{{input.text}}"' } }, { id: 'o', type: 'output', config: { text: '{{input.stdout}}' } }], edges: [edge('e1', 's', 'sh'), edge('e2', 'sh', 'o')] };
  const hostile = 'hi "$(echo PWNED)" `id` ; exit 9';
  const res = await runGraph({ graph, vars: { text: hostile }, env: { cwd: process.cwd() } });
  assert.equal(res.status, 'succeeded');
  assert.equal(res.result.text.trim(), hostile);
});

test('engine: loops are bounded and attributed; agent router failure does not fall through', async () => {
  const loop = structuredClone(workflowTemplates([]).find((t) => t.key === 'implement-review-loop').graph);
  loop.nodes.find((n) => n.id === 'route').config.rules[1].conditions = [];
  const env = { runAgent: async () => ({ code: 0, output: 'x', result: { status: 'changes_requested' } }) };
  const res = await runGraph({ graph: loop, vars: { prompt: 'x', task: {} }, env });
  assert.equal(res.status, 'failed');
  assert.match(res.error, /loop limit/);
  const router = { nodes: [{ id: 's', type: 'trigger' }, { id: 'r', type: 'router', config: { mode: 'agent', agentId: 'x', rules: [{ port: 'go', conditions: [] }] } }, { id: 'o', type: 'output' }], edges: [edge('a', 's', 'r'), edge('b', 'r', 'o', 'else')] };
  assert.equal((await runGraph({ graph: router, env: crashEnv })).status, 'failed');
});

test('workflows: templates run end to end with mock agents; agent graphs drive tasks', async (t) => {
  const app = makeApp(t);
  const { project, mock } = await setup(app, { allMock: true });
  const triage = await app.call('workflows.create', { name: 'triage', projectId: project.id, template: 'json-triage' });
  const r1 = await app.call('workflows.run', { id: triage.id, input: { type: 'bug', severity: 'critical', title: 'Crash' }, wait: true });
  assert.equal(r1.status, 'succeeded');
  const r2 = await app.call('workflows.run', { id: triage.id, input: { type: 'question', title: 'Why?' }, wait: true });
  assert.equal(r2.result.json.routed, 'none');
  const cards = await app.call('tasks.list', { projectId: project.id });
  assert.deepEqual(cards.map((c) => [c.title, c.priority]), [['[URGENT] Crash', 3]]);

  const fan = await app.call('workflows.create', { name: 'fan', projectId: project.id, template: 'fan-out-merge' });
  const fr = await app.call('workflows.run', { id: fan.id, wait: true });
  assert.equal(fr.status, 'succeeded');
  assert.equal(fr.nodes.merge.items.length, 2);

  const graph = await app.call('workflows.create', { name: 'loop', scope: 'agent', template: 'implement-review-loop' });
  await app.call('agents.update', { id: mock.id, config: { workflowId: graph.id } });
  const task = await app.call('tasks.create', { projectId: project.id, title: 'Add health endpoint', status: 'todo', assigneeId: mock.id });
  const res = await app.runner.executeTask(task.id);
  assert.equal(res.outcome, 'done');
  assert.equal(res.task.result.review.status, 'approved');

  const noOutput = await app.call('workflows.create', { name: 'noout', scope: 'agent', graph: { nodes: [{ id: 's', type: 'trigger' }, { id: 'a', type: 'agent', config: { agentId: 'self' } }], edges: [edge('e1', 's', 'a')] } });
  await app.call('agents.update', { id: mock.id, config: { workflowId: noOutput.id } });
  const t2 = await app.call('tasks.create', { projectId: project.id, title: 'y', status: 'todo', assigneeId: mock.id });
  assert.equal((await app.runner.executeTask(t2.id)).outcome, 'review', 'a graph without an Output node is never a silent success');

  await app.call('workflows.delete', { id: noOutput.id });
  assert.equal((await app.call('agents.get', { id: mock.id })).config.workflowId, null);

  const bad = await app.call('workflows.create', { name: 'bad', projectId: project.id, graph: { nodes: [{ id: 's', type: 'trigger' }, { id: 'c', type: 'task.create', config: { title: 'x', status: 'done' } }], edges: [edge('e', 's', 'c')] } });
  assert.match((await app.call('workflows.run', { id: bad.id, wait: true })).error, /backlog or todo/);
});
