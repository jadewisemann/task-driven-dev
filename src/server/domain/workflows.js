import { agentSystemPrompt } from '../agents/context.js';
import { parseJson, toJson } from '../core/db.js';
import { check, invalidParams, notFound } from '../core/errors.js';
import { newId, now } from '../core/ids.js';
import { runGraph, validateGraph } from '../workflow/engine.js';
import { nodeTypeList } from '../workflow/nodes.js';
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
export function createWorkflowRunner({ bus, services, runner, runs, log = console.error }) {
  const controllers = new Map(); // runId -> AbortController

  function makeEnv({ owner, run, cwd, projectId, signal, attempt, vars }) {
    return {
      cwd,
      projectId,
      async runAgent(ref, { prompt, system }) {
        let agent;
        if (ref === 'self') {
          if (!owner) throw new Error('agent "self" only exists in agent graphs — pick a specific agent');
          agent = owner;
        } else agent = services.agents.get(ref);
        runs.log(run, 'system', `→ ${agent.name} (${agent.harness}/${agent.model || 'default'})\n`);
        const sys = system ?? (ref === 'self' && vars.system ? vars.system : agentSystemPrompt(agent));
        return runner.runAgent({ agent, prompt, system: sys, cwd, attempt, run, signal });
      },
      async createTask(spec) {
        if (!projectId) throw new Error('Create task needs a project (run the workflow from a project)');
        if (spec.assigneeId) services.agents.get(spec.assigneeId);
        return services.tasks.create({ ...spec, projectId });
      },
    };
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
      const vars = input ?? wf.graph.nodes.find((n) => n.type === 'trigger')?.config?.sample ?? {};
      const run = runs.create({ projectId: pid, kind: 'workflow', meta: { workflowId, workflowName: wf.name } });
      const controller = new AbortController();
      controllers.set(run.id, controller);
      runs.log(run, 'system', `▶ workflow "${wf.name}"\n`);
      bus.publish('workflow.run.started', { projectId: pid, runId: run.id, workflowId });
      const project = pid ? services.projects.get(pid) : null;
      const promise = runGraph({
        graph: wf.graph,
        vars,
        env: makeEnv({ owner: null, run, cwd: project?.repoPath || undefined, projectId: pid, signal: controller.signal, attempt: 1, vars }),
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
      if (wait) return { runId: run.id, ...(await promise) };
      return { runId: run.id, status: 'running' };
    },

    cancel(runId) {
      const c = controllers.get(runId);
      if (!c) return false;
      c.abort();
      return true;
    },

    /** runner.agentGraphExecutor: executes the agent's node graph for a task. */
    async executeAgentGraph({ agent, task, project, context, cwd, run, signal, attempt }) {
      const wf = services.workflows.get(agent.config.workflowId);
      const vars = {
        task: { id: task.id, title: task.title, description: task.description, input: task.input, labels: task.labels },
        prompt: context.prompt,
        system: context.system,
        cwd,
        attempt,
      };
      runs.log(run, 'system', `graph "${wf.name}" (${wf.graph.nodes.length} nodes)\n`);
      const res = await runGraph({
        graph: wf.graph,
        vars,
        env: makeEnv({ owner: agent, run, cwd, projectId: project.id, signal, attempt, vars }),
        signal,
        onNode: nodeReporter(run, wf.id),
        log: (text, stream) => runs.log(run, stream || 'system', text),
      });
      const last = res.result || (res.lastOutput && typeof res.lastOutput === 'object' ? { text: res.lastOutput.text, json: res.lastOutput.json } : { text: res.lastOutput });
      const text = typeof last?.text === 'string' ? last.text : last?.text === undefined ? '' : JSON.stringify(last.text, null, 2);
      const json = last?.json && typeof last.json === 'object' && !Array.isArray(last.json) ? last.json : null;
      const ok = res.status === 'succeeded';
      return {
        code: ok ? 0 : 1,
        output: json ? `${text}\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n` : text,
        stderr: res.error || '',
        result: json,
        cancelled: res.status === 'cancelled',
        timedOut: false,
        truncated: false,
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
