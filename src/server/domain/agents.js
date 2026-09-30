import { parseJson, toJson } from '../core/db.js';
import { check, invalidParams, notFound } from '../core/errors.js';
import { newId, now } from '../core/ids.js';
import { DEFAULT_CONTEXT_GRAPH, buildTaskContext } from '../agents/context.js';
import { AUTONOMY, EFFORTS, HARNESSES, TIERS, inferTier, listHarnesses, prepareInvocation, splitCommand } from '../harness/registry.js';

/** Default execution config merged under every agent's stored (sparse) config. */
export const DEFAULT_AGENT_CONFIG = Object.freeze({
  contextGraph: DEFAULT_CONTEXT_GRAPH,
  autonomy: 'auto', // safe | auto | full — see harness registry
  workflowId: null, // agent-level node graph (workflow feature)
  useWorktree: true, // run inside a per-task git worktree when the project has a repo
  retries: 1,
  timeoutSec: 1800,
  maxTurns: null,
  command: '', // shell/custom harness template
  allowTaskCommand: false, // shell harness: let task input {"command"} override the agent command
  extraArgs: [],
  env: {},
});

/** Placeholder returned instead of env values so secrets never leave the server. */
export const SECRET_MASK = '••••••';

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

/** Public view of an agent: env values are masked. */
export function redactAgent(agent) {
  if (!agent) return agent;
  const env = Object.fromEntries(Object.keys(agent.config.env || {}).map((k) => [k, SECRET_MASK]));
  return { ...agent, config: { ...agent.config, env } };
}

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
    config: { autonomy: 'safe' },
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

/** Cross-field checks that need the final harness + config. */
function assertRunnable(harness, config) {
  if (harness === 'custom') {
    const tokens = splitCommand(config.command || '');
    if (tokens.length === 0 || tokens[0] === '{stdin}') throw invalidParams('custom harness needs a command template, e.g. "mycli --model {model} {prompt}"');
  }
}

export function createAgentService({ db, bus }) {
  const storedConfig = (id) => parseJson(db.get('SELECT config FROM agents WHERE id = ?', [id])?.config, {});

  const svc = {
    list() {
      return db.all('SELECT * FROM agents ORDER BY tier DESC, name').map(mapRow);
    },

    /** Full agent including secrets — for the runner only; RPC returns redactAgent(). */
    get(id) {
      const agent = mapRow(db.get('SELECT * FROM agents WHERE id = ?', [id]));
      if (!agent) throw notFound('Agent', id);
      return agent;
    },

    create(input) {
      const id = newId('agt');
      const ts = now();
      const tier = input.tier ?? inferTier(input.model);
      const config = input.config || {};
      assertRunnable(input.harness, mergeConfig(config));
      db.run(
        `INSERT INTO agents (id, name, role, persona, harness, model, effort, tier, color, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.name, input.role || 'generalist', input.persona || '', input.harness, input.model || '', input.effort || 'medium', tier, input.color || '#7c5cff', toJson(config), ts, ts],
      );
      const agent = svc.get(id);
      bus.publish('agent.created', { agent: redactAgent(agent) });
      return agent;
    },

    /**
     * Partial update. `config` is merged key-by-key into the stored overrides
     * (contextGraph deep-merged; env/extraArgs replaced). Env entries whose value
     * is the secret mask keep their stored value; a null config value resets
     * that key to its default.
     */
    update(id, patch) {
      const agent = db.tx(() => {
        const current = svc.get(id);
        const stored = storedConfig(id);
        let config = stored;
        if (patch.config) {
          config = { ...stored, ...patch.config };
          if (patch.config.contextGraph) config.contextGraph = { ...(stored.contextGraph || {}), ...patch.config.contextGraph };
          if (patch.config.env) {
            config.env = Object.fromEntries(Object.entries(patch.config.env).map(([k, v]) => [k, v === SECRET_MASK ? stored.env?.[k] : v]).filter(([, v]) => typeof v === 'string'));
          }
          for (const [k, v] of Object.entries(config)) if (v === null && k !== 'workflowId' && k !== 'maxTurns') delete config[k];
        }
        const next = { ...current, ...patch };
        assertRunnable(next.harness, mergeConfig(config));
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
        return svc.get(id);
      });
      bus.publish('agent.updated', { agent: redactAgent(agent) });
      return agent;
    },

    /** Deletes an agent and unassigns its tasks (each unassigned task is re-published). */
    delete(id, { tasks }) {
      const assigned = db.tx(() => {
        svc.get(id);
        const rows = db.all('SELECT id FROM tasks WHERE assignee_id = ?', [id]).map((r) => r.id);
        db.run('UPDATE tasks SET assignee_id = NULL, updated_at = ? WHERE assignee_id = ?', [now(), id]);
        db.run('DELETE FROM agents WHERE id = ?', [id]);
        return rows;
      });
      bus.publish('agent.deleted', { agentId: id, unassignedTaskIds: assigned });
      for (const taskId of assigned) {
        const task = tasks.get(taskId);
        bus.publish('task.updated', { projectId: task.projectId, task, previousStatus: task.status, changes: ['assigneeId'] });
      }
      return { ok: true, unassignedTaskIds: assigned };
    },

    /** Seeds the starter team exactly once per database (deleting everyone later is respected). */
    seedStarterTeam() {
      const seeded = db.tx(() => {
        if (db.get("SELECT 1 AS ok FROM meta WHERE key = 'starter_team_seeded'")) return false;
        db.run("INSERT INTO meta (key, value) VALUES ('starter_team_seeded', ?)", [now()]);
        if (db.get('SELECT COUNT(*) AS n FROM agents').n > 0) return false;
        for (const member of STARTER_TEAM) svc.create(member);
        return true;
      });
      return seeded;
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

const CONTEXT_BOOLEANS = ['includeUpstreamOutputs', 'includeDownstream', 'includeSiblings', 'includeProjectBrief'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whitelists and type-checks agent config. `null` means "reset to default". */
function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalidParams('"config" must be an object');
  const unknown = Object.keys(config).filter((k) => !(k in DEFAULT_AGENT_CONFIG));
  if (unknown.length) throw invalidParams(`Unknown config keys: ${unknown.join(', ')}`);
  const out = {};
  const set = (key, fn) => {
    if (config[key] === undefined) return;
    out[key] = config[key] === null ? null : fn();
  };
  const bool = (obj, key) => {
    if (typeof obj[key] !== 'boolean') throw invalidParams(`"${key}" must be a boolean`);
    return obj[key];
  };
  set('autonomy', () => check.oneOf(config, 'autonomy', AUTONOMY));
  set('workflowId', () => check.string(config, 'workflowId'));
  set('useWorktree', () => bool(config, 'useWorktree'));
  set('allowTaskCommand', () => bool(config, 'allowTaskCommand'));
  set('retries', () => check.number(config, 'retries', { min: 0, max: 10, integer: true }));
  set('timeoutSec', () => check.number(config, 'timeoutSec', { min: 5, max: 86400, integer: true }));
  set('maxTurns', () => check.number(config, 'maxTurns', { min: 1, max: 1000, integer: true }));
  set('command', () => {
    const cmd = check.string(config, 'command', { allowEmpty: true });
    try {
      splitCommand(cmd);
    } catch (err) {
      throw invalidParams(err.message);
    }
    return cmd;
  });
  set('extraArgs', () => check.stringArray(config, 'extraArgs'));
  set('env', () => {
    const env = config.env;
    if (typeof env !== 'object' || Array.isArray(env)) throw invalidParams('"config.env" must be an object of strings');
    for (const [k, v] of Object.entries(env)) {
      if (!ENV_NAME.test(k)) throw invalidParams(`Invalid env var name: ${k}`);
      if (typeof v !== 'string') throw invalidParams(`env ${k} must be a string`);
    }
    return env;
  });
  set('contextGraph', () => {
    const g = config.contextGraph;
    if (typeof g !== 'object' || Array.isArray(g)) throw invalidParams('"config.contextGraph" must be an object');
    const extra = Object.keys(g).filter((k) => !(k in DEFAULT_CONTEXT_GRAPH));
    if (extra.length) throw invalidParams(`Unknown contextGraph keys: ${extra.join(', ')}`);
    if (g.upstreamDepth !== undefined) check.number(g, 'upstreamDepth', { min: 0, max: 20, integer: true });
    if (g.maxUpstreamChars !== undefined) check.number(g, 'maxUpstreamChars', { min: 100, max: 50000, integer: true });
    if (g.maxPromptChars !== undefined) check.number(g, 'maxPromptChars', { min: 2000, max: 400000, integer: true });
    for (const key of CONTEXT_BOOLEANS) if (g[key] !== undefined) bool(g, key);
    return { ...g };
  });
  return out;
}

export function registerAgentRpc(rpc, { agents, tasks, projects }) {
  /** Everything needed to show/run an agent against a task: context + resolved command (secrets masked). */
  function preview(agentId, taskId) {
    const agent = agents.get(agentId);
    const task = tasks.get(taskId);
    const project = projects.get(task.projectId);
    const context = buildTaskContext({ agent, task, project, tasks: tasks.list({ projectId: task.projectId }), edges: tasks.edges(task.projectId) });
    let invocation;
    try {
      const inv = prepareInvocation(redactAgent(agent), { prompt: context.prompt, system: context.system, shellCommand: task.input?.command });
      invocation = inv.kind === 'process' ? { kind: 'process', display: inv.display, env: inv.env } : inv;
    } catch (err) {
      invocation = { kind: 'error', error: err.message };
    }
    return { ...context, invocation };
  }

  rpc.group('agents', {
    list: { handler: () => agents.list().map(redactAgent), description: 'List agent profiles' },
    get: { handler: (p) => redactAgent(agents.get(check.string(p, 'id'))), description: 'Get an agent profile' },
    create: {
      handler: (p) => redactAgent(agents.create({ ...agentPatchFrom(p), name: check.string(p, 'name'), harness: check.oneOf(p, 'harness', Object.keys(HARNESSES)) })),
      description: 'Create an agent {name, harness, role?, persona?, model?, effort?, tier?, color?, config?}',
    },
    update: { handler: (p) => redactAgent(agents.update(check.string(p, 'id'), agentPatchFrom(p))), description: 'Update an agent profile (config is merged)' },
    delete: { handler: (p) => agents.delete(check.string(p, 'id'), { tasks }), description: 'Delete an agent (its tasks become unassigned)' },
    preview: {
      handler: (p) => preview(check.string(p, 'agentId'), check.string(p, 'taskId')),
      description: 'Show the exact prompt/context and command an agent would get for a task',
    },
  });

  rpc.group('harnesses', {
    list: { handler: () => listHarnesses(), description: 'Available harnesses and whether their CLI is installed' },
    options: {
      handler: () => ({ efforts: EFFORTS, tiers: TIERS, autonomy: AUTONOMY, defaults: DEFAULT_AGENT_CONFIG }),
      description: 'Allowed effort levels, tiers, autonomy levels and default agent config',
    },
    inferTier: { handler: (p) => inferTier(check.string(p, 'model', { allowEmpty: true })), description: 'Guess a model tier from its name' },
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
