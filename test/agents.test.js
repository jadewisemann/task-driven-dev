import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTaskContext } from '../src/server/agents/context.js';
import { SECRET_MASK } from '../src/server/domain/agents.js';
import { inferTier, prepareInvocation, splitCommand } from '../src/server/harness/registry.js';
import { makeApp } from './helpers.js';

test('splitCommand: quoting and Windows paths', () => {
  assert.deepEqual(splitCommand(`mycli "C:\\Users\\me" --x 'a b' "q\\"q"`), ['mycli', 'C:\\Users\\me', '--x', 'a b', 'q"q']);
  assert.deepEqual(splitCommand('  '), []);
  assert.throws(() => splitCommand('"open'), /Unterminated/);
});

test('inferTier matches whole words (gemini is not "mini")', () => {
  const tiers = Object.fromEntries(['gemini-2.5-pro', 'gemini-2.5-flash', 'gpt-5-mini', 'gpt-5', 'sonnet', 'opus', 'claude-haiku-4.5'].map((m) => [m, inferTier(m)]));
  assert.deepEqual(tiers, { 'gemini-2.5-pro': 3, 'gemini-2.5-flash': 1, 'gpt-5-mini': 1, 'gpt-5': 3, sonnet: 2, opus: 3, 'claude-haiku-4.5': 1 });
});

test('agents: starter team seeded once, config validated, secrets redacted', async (t) => {
  const app = makeApp(t);
  const agents = await app.call('agents.list');
  assert.deepEqual(agents.map((a) => a.name).sort(), ['Atlas', 'Forge', 'Lens', 'Mocky', 'Sprint']);
  await assert.rejects(app.call('agents.create', { name: 'x', harness: 'custom', config: { command: '  ' } }), /command template/);
  await assert.rejects(app.call('agents.create', { name: 'x', harness: 'mock', config: { bogus: 1 } }), /Unknown config keys/);
  await assert.rejects(app.call('agents.create', { name: 'x', harness: 'mock', config: { contextGraph: { includeSiblings: 'false' } } }), /boolean/);
  await assert.rejects(app.call('agents.create', { name: 'x', harness: 'mock', config: { env: ['x'] } }), /object of strings/);

  const created = await app.call('agents.create', { name: 'Sec', harness: 'claude-code', model: 'sonnet', config: { env: { API_KEY: 'secret123' } } });
  assert.deepEqual(created.config.env, { API_KEY: SECRET_MASK });
  await app.call('agents.update', { id: created.id, config: { env: { API_KEY: SECRET_MASK, OTHER: 'v' } } });
  assert.deepEqual(app.services.agents.get(created.id).config.env, { API_KEY: 'secret123', OTHER: 'v' }, 'mask keeps the stored value');

  for (const a of await app.call('agents.list')) await app.call('agents.delete', { id: a.id });
  app.services.agents.seedStarterTeam();
  assert.equal((await app.call('agents.list')).length, 0, 'deleting everyone is respected');
});

test('invocations: prompt via stdin, autonomy flags, extraArgs before positionals, size guard', async (t) => {
  const app = makeApp(t);
  const base = app.services.agents.get((await app.call('agents.create', { name: 'I', harness: 'claude-code', model: 'sonnet', effort: 'high', config: { extraArgs: ['--verbose'] } })).id);
  const claude = prepareInvocation(base, { prompt: 'P', system: 'S' });
  assert.equal(claude.stdin, 'P');
  assert.equal(claude.env.MAX_THINKING_TOKENS, '24000');
  assert.ok(claude.args.includes('--allowedTools'));
  const codex = prepareInvocation({ ...base, harness: 'codex' }, { prompt: 'P' });
  assert.deepEqual(codex.args.slice(-2), ['--verbose', '-'], 'codex reads the prompt from stdin');
  const aider = prepareInvocation({ ...base, harness: 'aider' }, { prompt: 'P', promptFile: '/tmp/p.md' });
  assert.equal(aider.promptFile, '/tmp/p.md');
  assert.throws(() => prepareInvocation({ ...base, harness: 'kiro-cli' }, { prompt: 'x'.repeat(200_000) }), /too large/);
  const shell = { ...base, harness: 'shell', config: { ...base.config, command: 'echo agent', allowTaskCommand: false } };
  assert.deepEqual(prepareInvocation(shell, { shellCommand: 'rm -rf /' }).args, ['-c', 'echo agent'], 'task commands need opt-in');
  assert.deepEqual(prepareInvocation({ ...shell, config: { ...shell.config, allowTaskCommand: true } }, { shellCommand: 'echo task' }).args, ['-c', 'echo task']);
  assert.deepEqual(prepareInvocation({ ...base, harness: 'mock' }, { prompt: 'x' }), { kind: 'builtin', harness: 'mock' });
});

test('context graph: upstream outputs, downstream list, budget', async (t) => {
  const app = makeApp(t);
  const [p] = await app.call('projects.list');
  const a = await app.call('tasks.create', { projectId: p.id, title: 'Design schema' });
  await app.services.tasks.update(a.id, { output: 'o'.repeat(50_000), result: { summary: 'schema done' } });
  const b = await app.call('tasks.create', { projectId: p.id, title: 'Build API', dependsOn: [a.id] });
  await app.call('tasks.create', { projectId: p.id, title: 'Write docs', dependsOn: [b.id] });
  const agent = app.services.agents.list().find((x) => x.name === 'Forge');
  const ctx = buildTaskContext({ agent, task: app.services.tasks.get(b.id), project: p, tasks: app.services.tasks.list({ projectId: p.id }), edges: app.services.tasks.edges(p.id) });
  assert.match(ctx.system, /Forge/);
  assert.match(ctx.prompt, /# Task: Build API/);
  assert.match(ctx.prompt, /Summary: schema done/);
  assert.match(ctx.prompt, /- Write docs/);
  assert.ok(ctx.prompt.length < 10_000, 'predecessor output is truncated to the per-task limit');
  const preview = await app.call('agents.preview', { agentId: agent.id, taskId: b.id });
  assert.equal(preview.invocation.kind, 'process');
});

test('tasks.assign validates agents and agent delete unassigns', async (t) => {
  const app = makeApp(t);
  const [p] = await app.call('projects.list');
  const agent = (await app.call('agents.list'))[0];
  const task = await app.call('tasks.create', { projectId: p.id, title: 'x' });
  await assert.rejects(app.call('tasks.assign', { taskId: task.id, agentId: 'agt_nope' }), /not found/);
  await app.call('tasks.assign', { taskId: task.id, agentId: agent.id });
  const res = await app.call('agents.delete', { id: agent.id });
  assert.deepEqual(res.unassignedTaskIds, [task.id]);
  assert.equal((await app.call('tasks.get', { id: task.id })).assigneeId, null);
});
