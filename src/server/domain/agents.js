import { parseJson, toJson } from '../core/db.js';
import { check, invalidParams, notFound } from '../core/errors.js';
import { newId, now } from '../core/ids.js';
import { DEFAULT_CONTEXT_GRAPH, buildTaskContext } from '../agents/context.js';
import { EFFORTS, HARNESSES, TIERS, inferTier, listHarnesses, prepareInvocation } from '../harness/registry.js';

/** Default execution config merged under every agent's stored config. */
export const DEFAULT_AGENT_CONFIG = Object.freeze({
  contextGraph: DEFAULT_CONTEXT_GRAPH,
  workflowId: null, // agent-level node graph (workflow feature)
  useWorktree: true, // run inside a per-task git worktree when the project has a repo
  retries: 1,
  timeoutSec: 1800,
  maxTurns: null,
  command: '', // shell/custom harness template
  extraArgs: [],
  env: {},
});

const mergeConfig = (stored = {}) => ({
  ...DEFAULT_AGENT_CONFIG,
  ...stored,
  contextGraph: { ...DEFAULT_CONTEXT_GRAPH, ...(stored.contextGraph || {}) },
});

const mapRow = (r) =>
  r && {
    id: r.id,
    name: r.name,
    role: r.role,
    persona: r.persona,
    harness: r.harness,
    model: r.model,
    effort: r.effort,
    tier: r.tier,
    color: r.color,
    config: mergeConfig(parseJson(r.config, {})),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

/** A starter team so the board is usable immediately; the mock agent works without any CLI installed. */
const STARTER_TEAM = [
  {
    name: 'Atlas',
    role: 'orchestrator',
    harness: 'claude-code',
    model: 'opus',
    effort: 'high',
    tier: 3,
    color: '#7c5cff',
    persona: 'Senior tech lead. Breaks goals into small, verifiable tasks with clear dependencies and assigns the cheapest capable teammate.',
  },
  {
    name: 'Forge',
    role: 'engineer',
    harness: 'claude-code',
    model: 'sonnet',
    effort: 'medium',
    tier: 2,
    color: '#4da3ff',
    persona: 'Pragmatic full-stack engineer. Writes clean, tested, minimal changes that follow existing conventions.',
  },
  {
    name: 'Sprint',
    role: 'engineer',
    harness: 'codex',
    model: 'gpt-5-mini',
    effort: 'low',
    tier: 1,
    color: '#4dd4ac',
    persona: 'Fast implementer for small, well-specified tasks: boilerplate, renames, simple fixes.',
  },
  {
    name: 'Lens',
    role: 'reviewer',
    harness: 'claude-code',
    model: 'sonnet',
    effort: 'high',
    tier: 2,
    color: '#ffb547',
    persona: 'Meticulous code reviewer. Checks correctness, security and tests. Reports needs_review when something is off.',
  },
  {
    name: 'Mocky',
    role: 'generalist',
    harness: 'mock',
    model: 'mock-small',
    effort: 'low',
    tier: 1,
    color: '#b77cff',
    persona: 'Simulated teammate used for dry runs. Completes any task with a deterministic summary.',
  },
];

export function createAgentService({ db, bus }) {
  const svc = {
    list() {
      return db.all('SELECT * FROM agents ORDER BY tier DESC, name').map(mapRow);
    },

    get(id) {
      const agent = mapRow(db.get('SELECT * FROM agents WHERE id = ?', [id]));
      if (!agent) throw notFound('Agent', id);
      return agent;
    },

    create(input) {
      const id = newId('agt');
      const ts = now();
      const tier = input.tier ?? inferTier(input.model);
      db.run(
        `INSERT INTO agents (id, name, role, persona, harness, model, effort, tier, color, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.name, input.role || 'generalist', input.persona || '', input.harness, input.model || '', input.effort || 'medium', tier, input.color || '#7c5cff', toJson(input.config || {}), ts, ts],
      );
      const agent = svc.get(id);
      bus.publish('agent.created', { agent });
      return agent;
    },

    update(id, patch) {
      const current = svc.get(id);
      const storedConfig = parseJson(db.get('SELECT config FROM agents WHERE id = ?', [id]).config, {});
      const config = patch.config
        ? { ...storedConfig, ...patch.config, contextGraph: { ...(storedConfig.contextGraph || {}), ...(patch.config.contextGraph || {}) } }
        : storedConfig;
      const next = { ...current, ...patch };
      db.run('UPDATE agents SET name = ?, role = ?, persona = ?, harness = ?, model = ?, effort = ?, tier = ?, color = ?, config = ?, updated_at = ? WHERE id = ?', [
        next.name,
        next.role,
        next.persona,
        next.harness,
        next.model,
        next.effort,
        next.tier,
        next.color,
        toJson(config),
        now(),
        id,
      ]);
      const agent = svc.get(id);
      bus.publish('agent.updated', { agent });
      return agent;
    },

    /** Deletes an agent and unassigns its tasks (each unassigned task is re-published). */
    delete(id, { tasks }) {
      svc.get(id);
      const assigned = db.all('SELECT id FROM tasks WHERE assignee_id = ?', [id]).map((r) => r.id);
      db.tx(() => {
        db.run('UPDATE tasks SET assignee_id = NULL, updated_at = ? WHERE assignee_id = ?', [now(), id]);
        db.run('DELETE FROM agents WHERE id = ?', [id]);
      });
      bus.publish('agent.deleted', { agentId: id, unassignedTaskIds: assigned });
      for (const taskId of assigned) {
        const task = tasks.get(taskId);
        bus.publish('task.updated', { projectId: task.projectId, task, changes: ['assigneeId'] });
      }
      return { ok: true, unassignedTaskIds: assigned };
    },

    seedStarterTeam() {
      if (db.get('SELECT COUNT(*) AS n FROM agents').n > 0) return;
      for (const member of STARTER_TEAM) svc.create(member);
    },
  };
  return svc;
}

function agentPatchFrom(p) {
  const patch = {};
  if (p.name !== undefined) patch.name = check.string(p, 'name');
  if (p.role !== undefined) patch.role = check.string(p, 'role');
  if (p.persona !== undefined) patch.persona = check.string(p, 'persona', { allowEmpty: true });
  if (p.harness !== undefined) patch.harness = check.oneOf(p, 'harness', Object.keys(HARNESSES));
  if (p.model !== undefined) patch.model = check.string(p, 'model', { allowEmpty: true });
  if (p.effort !== undefined) patch.effort = check.oneOf(p, 'effort', EFFORTS);
  if (p.tier !== undefined) patch.tier = check.oneOf(p, 'tier', TIERS);
  if (p.color !== undefined) {
    patch.color = check.string(p, 'color');
    if (!/^#[0-9a-f]{3,8}$/i.test(patch.color)) throw invalidParams('"color" must be a hex color');
  }
  if (p.config !== undefined) patch.config = validateConfig(p.config);
  return patch;
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalidParams('"config" must be an object');
  const out = { ...config };
  if (out.retries !== undefined) out.retries = check.number(out, 'retries', { min: 0, max: 10, integer: true });
  if (out.timeoutSec !== undefined) out.timeoutSec = check.number(out, 'timeoutSec', { min: 5, max: 86400, integer: true });
  if (out.maxTurns !== undefined && out.maxTurns !== null) out.maxTurns = check.number(out, 'maxTurns', { min: 1, max: 1000, integer: true });
  if (out.extraArgs !== undefined) out.extraArgs = check.stringArray(out, 'extraArgs');
  if (out.env !== undefined) {
    if (typeof out.env !== 'object' || out.env === null || Object.values(out.env).some((v) => typeof v !== 'string')) {
      throw invalidParams('"config.env" must be an object of strings');
    }
  }
  if (out.contextGraph !== undefined) {
    const g = out.contextGraph;
    if (typeof g !== 'object' || g === null) throw invalidParams('"config.contextGraph" must be an object');
    if (g.upstreamDepth !== undefined) check.number(g, 'upstreamDepth', { min: 0, max: 20, integer: true });
    if (g.maxUpstreamChars !== undefined) check.number(g, 'maxUpstreamChars', { min: 100, max: 200000, integer: true });
  }
  return out;
}

export function registerAgentRpc(rpc, { agents, tasks, projects }) {
  /** Everything needed to show/run an agent against a task: context + resolved command. */
  function preview(agentId, taskId) {
    const agent = agents.get(agentId);
    const task = tasks.get(taskId);
    const project = projects.get(task.projectId);
    const context = buildTaskContext({ agent, task, project, tasks: tasks.list({ projectId: task.projectId }), edges: tasks.edges(task.projectId) });
    let invocation;
    try {
      invocation = prepareInvocation(agent, { prompt: context.prompt, system: context.system, shellCommand: task.input?.command });
    } catch (err) {
      invocation = { kind: 'error', error: err.message };
    }
    return { ...context, invocation: invocation.kind === 'process' ? { kind: 'process', display: invocation.display, env: invocation.env } : invocation };
  }

  rpc.group('agents', {
    list: { handler: () => agents.list(), description: 'List agent profiles' },
    get: { handler: (p) => agents.get(check.string(p, 'id')), description: 'Get an agent profile' },
    create: {
      handler: (p) => agents.create({ ...agentPatchFrom(p), name: check.string(p, 'name'), harness: check.oneOf(p, 'harness', Object.keys(HARNESSES)) }),
      description: 'Create an agent {name, harness, role?, persona?, model?, effort?, tier?, color?, config?}',
    },
    update: { handler: (p) => agents.update(check.string(p, 'id'), agentPatchFrom(p)), description: 'Update an agent profile' },
    delete: { handler: (p) => agents.delete(check.string(p, 'id'), { tasks }), description: 'Delete an agent (its tasks become unassigned)' },
    preview: {
      handler: (p) => preview(check.string(p, 'agentId'), check.string(p, 'taskId')),
      description: 'Show the exact prompt/context and command an agent would get for a task',
    },
  });

  rpc.group('harnesses', {
    list: { handler: () => listHarnesses(), description: 'Available harnesses and whether their CLI is installed' },
    options: {
      handler: () => ({ efforts: EFFORTS, tiers: TIERS, defaults: DEFAULT_AGENT_CONFIG }),
      description: 'Allowed effort levels, tiers and default agent config',
    },
  });

  rpc.register(
    'tasks.assign',
    (p) => {
      const taskId = check.string(p, 'taskId');
      const agentId = p.agentId === null ? null : check.string(p, 'agentId');
      if (agentId) agents.get(agentId);
      return tasks.update(taskId, { assigneeId: agentId });
    },
    'Assign an agent to a task {taskId, agentId|null}',
  );
}
