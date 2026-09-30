import { agentSystemPrompt } from '../agents/context.js';
import { parseJson, toJson } from '../core/db.js';
import { check, invalidParams, notFound } from '../core/errors.js';
import { newId, now } from '../core/ids.js';
import { runGraph, validateGraph } from '../workflow/engine.js';
import { MAX_TASKS_PER_RUN, MAX_TASK_DEPTH, nodeTypeList } from '../workflow/nodes.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { workflowTemplates } from '../workflow/templates.js';

export const WORKFLOW_SCOPES = ['project', 'agent'];

const mapRow = (r) =>
  r && {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    description: r.description,
    scope: r.scope,
    graph: parseJson(r.graph, { nodes: [], edges: [] }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

const preview = (value, max = 4000) => {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text && text.length > max ? `${text.slice(0, max)}…` : value;
};

export function createWorkflowService({ db, bus }) {
  const svc = {
    list({ projectId, scope } = {}) {
      const where = [];
      const params = [];
      if (projectId) {
        // Agent-scoped graphs are global (agents are shared across projects).
        where.push('(project_id = ? OR project_id IS NULL)');
        params.push(projectId);
      }
      if (scope) {
        where.push('scope = ?');
        params.push(scope);
      }
      return db.all(`SELECT * FROM workflows ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY scope, name`, params).map(mapRow);
    },

    get(id) {
      const wf = mapRow(db.get('SELECT * FROM workflows WHERE id = ?', [id]));
      if (!wf) throw notFound('Workflow', id);
      return wf;
    },

    create({ name, description = '', scope = 'project', projectId = null, graph }) {
      const id = newId('wfl');
      const ts = now();
      db.run('INSERT INTO workflows (id, project_id, name, description, scope, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        scope === 'agent' ? null : projectId,
        name,
        description,
        scope,
        toJson(graph || { nodes: [], edges: [] }),
        ts,
        ts,
      ]);
      const wf = svc.get(id);
      bus.publish('workflow.created', { projectId: wf.projectId, workflow: wf });
      return wf;
    },

    update(id, patch) {
      const cur = svc.get(id);
      const next = { ...cur, ...patch };
      db.run('UPDATE workflows SET name = ?, description = ?, graph = ?, updated_at = ? WHERE id = ?', [next.name, next.description, toJson(next.graph), now(), id]);
      const wf = svc.get(id);
      bus.publish('workflow.updated', { projectId: wf.projectId, workflow: wf });
      return wf;
    },

    delete(id, { agents }) {
      const wf = svc.get(id);
      db.run('DELETE FROM workflows WHERE id = ?', [id]);
      for (const agent of agents.list().filter((a) => a.config.workflowId === id)) agents.update(agent.id, { config: { workflowId: null } });
      bus.publish('workflow.deleted', { projectId: wf.projectId, workflowId: id });
      return { ok: true };
    },
  };
  return svc;
}

/**
 * Runs workflow graphs: standalone (project workflows, manual or via RPC) and
 * as an agent's own node graph when that agent executes a task.
 */
export function createWorkflowRunner({ bus, services, runner, runs, home, log = console.error }) {
  const controllers = new Map(); // runId -> AbortController
  const inflight = new Set();

  /**
   * Services a graph can use. Tracks flags (truncated / timed out agent output)
   * so the caller can report them, and limits task creation so a graph that
   * creates tasks for an agent running the same graph cannot recurse forever.
   * `depth` = how many graph-created tasks lead to this run.
   */
  function makeEnv({ owner, run, cwd, projectId, signal, attempt, vars, depth = 0 }) {
    let created = 0;
    const env = {
      cwd,
      projectId,
      flags: { truncated: false, timedOut: false },
      async runAgent(ref, { prompt, system }) {
        let agent;
        if (ref === 'self') {
          if (!owner) throw new Error('agent "self" only exists in agent graphs — pick a specific agent');
          agent = owner;
        } else agent = services.agents.get(ref);
        runs.log(run, 'system', `→ ${agent.name} (${agent.harness}/${agent.model || 'default'})\n`);
        const sys = system ?? (ref === 'self' && vars.system ? vars.system : agentSystemPrompt(agent));
        const res = await runner.runAgent({ agent, prompt, system: sys, cwd, attempt, run, signal });
        env.flags.truncated ||= Boolean(res.truncated);
        env.flags.timedOut ||= Boolean(res.timedOut);
        return res;
      },
      async createTask(spec) {
        if (!projectId) throw new Error('Create task needs a project (run the workflow from a project)');
        if (depth >= MAX_TASK_DEPTH) throw new Error(`Create task refused: already ${depth} levels of graph-created tasks (limit ${MAX_TASK_DEPTH})`);
        if (++created > MAX_TASKS_PER_RUN) throw new Error(`Create task refused: more than ${MAX_TASKS_PER_RUN} tasks in one run`);
        if (spec.assigneeId) services.agents.get(spec.assigneeId);
        return services.tasks.create({ ...spec, projectId, input: { createdBy: { runId: run.id, depth: depth + 1 } } });
      },
    };
    return env;
  }

  /** Working directory for standalone runs: project repo, else a per-run scratch dir (never the server cwd). */
  function scratchCwd(project, runId) {
    if (project?.repoPath) return project.repoPath;
    const dir = join(home || process.cwd(), 'scratch', runId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function nodeReporter(run, workflowId) {
    return (evt) => bus.publish('workflow.node', { projectId: run.projectId, runId: run.id, taskId: run.taskId, workflowId, ...evt, output: preview(evt.output) });
  }

  const wfRunner = {
    /** Starts a standalone run. Resolves immediately with the run unless `wait`. */
    async start(workflowId, { input, projectId, wait = false } = {}) {
      const wf = services.workflows.get(workflowId);
      if (wf.scope === 'agent') throw invalidParams('Agent graphs run when their agent executes a task; run a project workflow instead');
      const pid = wf.projectId || projectId || null;
      const project = pid ? services.projects.get(pid) : null; // validate before creating the run
      const vars = input ?? wf.graph.nodes.find((n) => n.type === 'trigger')?.config?.sample ?? {};
      const run = runs.create({ projectId: pid, kind: 'workflow', meta: { workflowId, workflowName: wf.name } });
      const controller = new AbortController();
      controllers.set(run.id, controller);
      runs.log(run, 'system', `▶ workflow "${wf.name}"\n`);
      bus.publish('workflow.run.started', { projectId: pid, runId: run.id, workflowId });
      const promise = runGraph({
        graph: wf.graph,
        vars,
        env: makeEnv({ owner: null, run, cwd: scratchCwd(project, run.id), projectId: pid, signal: controller.signal, attempt: 1, vars }),
        signal: controller.signal,
        onNode: nodeReporter(run, workflowId),
        log: (text, stream) => runs.log(run, stream || 'system', text),
      })
        .then((res) => {
          runs.finish(run.id, { status: res.status, error: res.error || null, meta: { result: preview(res.result), failedNode: res.failedNode } });
          bus.publish('workflow.run.finished', { projectId: pid, runId: run.id, workflowId, status: res.status, error: res.error, result: preview(res.result) });
          return res;
        })
        .catch((err) => {
          log(err);
          runs.finish(run.id, { status: 'failed', error: err.message });
          return { status: 'failed', error: err.message };
        })
        .finally(() => controllers.delete(run.id));
      inflight.add(promise);
      promise.finally(() => inflight.delete(promise));
      if (wait) return { runId: run.id, ...(await promise) };
      return { runId: run.id, status: 'running' };
    },

    cancel(runId) {
      const c = controllers.get(runId);
      if (!c) return false;
      c.abort();
      return true;
    },

    /** Shutdown: abort every standalone run and wait briefly for them to record their outcome. */
    async cancelAll(waitMs = 8000) {
      for (const c of controllers.values()) c.abort();
      if (inflight.size) await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, waitMs).unref())]);
    },

    /** runner.agentGraphExecutor: executes the agent's node graph for a task. */
    async executeAgentGraph({ agent, task, project, context, cwd, run, signal, attempt }) {
      const wf = services.workflows.get(agent.config.workflowId);
      if (wf.scope !== 'agent') throw new Error(`Workflow "${wf.name}" is a project workflow; pick an agent graph for ${agent.name}`);
      const vars = {
        task: { id: task.id, title: task.title, description: task.description, input: task.input, labels: task.labels },
        prompt: context.prompt,
        system: context.system,
        cwd,
        attempt,
      };
      runs.log(run, 'system', `graph "${wf.name}" (${wf.graph.nodes.length} nodes)\n`);
      const env = makeEnv({ owner: agent, run, cwd, projectId: project.id, signal, attempt, vars, depth: task.input?.createdBy?.depth || 0 });
      const res = await runGraph({ graph: wf.graph, vars, env, signal, onNode: nodeReporter(run, wf.id), log: (text, stream) => runs.log(run, stream || 'system', text) });

      const toText = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v, null, 2));
      let text = toText(res.result?.text);
      let json = res.result?.json && typeof res.result.json === 'object' && !Array.isArray(res.result.json) ? res.result.json : null;
      if (res.status === 'succeeded' && !res.result) {
        // The graph ended without reaching an Output node: never report that as a silent success.
        text = toText(res.lastOutput?.text ?? res.lastOutput);
        json = { status: 'needs_review', summary: `Graph "${wf.name}" finished without reaching an Output node` };
      }
      return {
        code: res.status === 'succeeded' ? 0 : 1,
        output: json ? `${text}\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n` : text,
        stderr: res.error ? `${res.failedNode ? `[${res.failedNode}] ` : ''}${res.error}` : '',
        result: json,
        cancelled: res.status === 'cancelled',
        timedOut: env.flags.timedOut,
        truncated: env.flags.truncated,
      };
    },
  };
  return wfRunner;
}

function graphFrom(p) {
  const graph = p.graph;
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw invalidParams('"graph" must be {nodes: [], edges: []}');
  }
  return graph;
}

export function registerWorkflowRpc(rpc, { workflows, wfRunner, services }) {
  rpc.group('workflows', {
    nodeTypes: { handler: () => nodeTypeList(), description: 'Available node types with their config schema' },
    templates: { handler: () => workflowTemplates(services.agents.list()), description: 'Starter graphs' },
    list: {
      handler: (p) => workflows.list({ projectId: check.string(p, 'projectId', { optional: true }), scope: check.oneOf(p, 'scope', WORKFLOW_SCOPES, { optional: true }) }),
      description: 'List workflows {projectId?, scope?}',
    },
    get: { handler: (p) => workflows.get(check.string(p, 'id')), description: 'Get a workflow' },
    create: {
      handler: (p) => {
        const scope = check.oneOf(p, 'scope', WORKFLOW_SCOPES, { optional: true }) || 'project';
        const projectId = check.string(p, 'projectId', { optional: true });
        if (projectId) services.projects.get(projectId);
        let graph = p.graph ? graphFrom(p) : null;
        if (!graph && p.template) {
          const tpl = workflowTemplates(services.agents.list()).find((t) => t.key === p.template);
          if (!tpl) throw invalidParams(`Unknown template: ${p.template}`);
          graph = tpl.graph;
        }
        graph ||= { nodes: [{ id: 'start', type: 'trigger', name: 'Start', x: 60, y: 160, config: { sample: {} } }], edges: [] };
        return workflows.create({ name: check.string(p, 'name'), description: check.string(p, 'description', { optional: true, allowEmpty: true }) || '', scope, projectId, graph });
      },
      description: 'Create a workflow {name, scope?: project|agent, projectId?, graph? | template?}',
    },
    update: {
      handler: (p) => {
        const patch = {};
        if (p.name !== undefined) patch.name = check.string(p, 'name');
        if (p.description !== undefined) patch.description = check.string(p, 'description', { allowEmpty: true });
        if (p.graph !== undefined) patch.graph = graphFrom(p);
        return workflows.update(check.string(p, 'id'), patch);
      },
      description: 'Update a workflow (name, description, graph)',
    },
    delete: { handler: (p) => workflows.delete(check.string(p, 'id'), { agents: services.agents }), description: 'Delete a workflow (agents using it fall back to a single step)' },
    validate: { handler: (p) => ({ problems: validateGraph(p.graph ?? workflows.get(check.string(p, 'id')).graph) }), description: 'Check a graph {id} or {graph}' },
    run: {
      handler: (p) => wfRunner.start(check.string(p, 'id'), { input: p.input, projectId: check.string(p, 'projectId', { optional: true }), wait: p.wait === true }),
      description: 'Run a project workflow {id, input?, projectId?, wait?}',
    },
    cancel: { handler: (p) => ({ cancelled: wfRunner.cancel(check.string(p, 'runId')) }), description: 'Cancel a workflow run' },
  });
}
