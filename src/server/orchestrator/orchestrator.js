import { parseJson, toJson } from '../core/db.js';
import { check, conflict, invalidParams, notFound } from '../core/errors.js';
import { newId, now } from '../core/ids.js';
import { agentSystemPrompt } from '../agents/context.js';
import { topoSort } from '../domain/dag.js';
import { REVIEW_POLICIES } from '../runtime/scheduler.js';
import { assignAgents } from './assigner.js';
import { buildPlanningPrompt, heuristicPlan, normalizePlan } from './planner.js';

const mapRow = (r) =>
  r && {
    id: r.id,
    projectId: r.project_id,
    goal: r.goal,
    orchestratorId: r.orchestrator_id,
    source: r.source,
    status: r.status, // planning | draft | failed | discarded | applied | running | finished | incomplete
    plan: parseJson(r.plan, { summary: '', tasks: [], warnings: [] }),
    taskIds: parseJson(r.task_ids, []),
    summary: r.summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

/**
 * Orchestrator mode: a high-tier agent turns a natural-language goal into a
 * dependency-ordered plan, the assigner hands each task to the cheapest capable
 * agent, and the scheduler runs everything to completion.
 *
 *   goal ──plan()──▶ draft ──apply()──▶ board tasks ──run()──▶ scheduler ──▶ finished (+ summary)
 */
export function createOrchestrator({ db, bus, services, runner, runs, scheduler, log = console.error }) {
  const store = {
    get(id) {
      const plan = mapRow(db.get('SELECT * FROM plans WHERE id = ?', [id]));
      if (!plan) throw notFound('Plan', id);
      return plan;
    },
    list(projectId, limit = 20) {
      return db.all('SELECT * FROM plans WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', [projectId, limit]).map(mapRow);
    },
    update(id, fields) {
      const cols = { status: 'status', source: 'source', summary: 'summary', orchestratorId: 'orchestrator_id' };
      const sets = [];
      const params = [];
      for (const [k, col] of Object.entries(cols)) {
        if (fields[k] === undefined) continue;
        sets.push(`${col} = ?`);
        params.push(fields[k]);
      }
      if (fields.plan) {
        sets.push('plan = ?');
        params.push(toJson(fields.plan));
      }
      if (fields.taskIds) {
        sets.push('task_ids = ?');
        params.push(toJson(fields.taskIds));
      }
      sets.push('updated_at = ?');
      db.run(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`, [...params, now(), id]);
      const plan = store.get(id);
      bus.publish('plan.updated', { projectId: plan.projectId, plan });
      return plan;
    },
  };

  /** The planner: explicit choice, else the strongest orchestrator-role agent, else the strongest agent. */
  function pickOrchestrator(orchestratorId) {
    if (orchestratorId) return services.agents.get(orchestratorId);
    const agents = services.agents.list();
    return agents.filter((a) => a.role === 'orchestrator').sort((a, b) => b.tier - a.tier)[0] || [...agents].sort((a, b) => b.tier - a.tier)[0] || null;
  }

  const planning = new Map(); // planId -> AbortController (background planning runs)
  let closed = false; // set on shutdown: background planning must not touch the DB afterwards

  async function producePlan(plan, orchestrator) {
    const controller = new AbortController();
    planning.set(plan.id, controller);
    let run = null;
    const warnings = [];
    // A plan discarded (or otherwise moved on) while the model was thinking must stay that way.
    const stillPlanning = () => !closed && !controller.signal.aborted && store.get(plan.id).status === 'planning';
    const current = () => (closed ? plan : store.get(plan.id));
    try {
      const project = services.projects.get(plan.projectId);
      const agents = services.agents.list();
      run = runs.create({ projectId: project.id, agentId: orchestrator?.id, kind: 'orchestration', meta: { planId: plan.id, agentName: orchestrator?.name, taskTitle: `Plan: ${plan.goal.slice(0, 60)}` } });
      let draft = null;
      let source = 'heuristic';
      if (orchestrator && orchestrator.harness !== 'mock') {
        const prompt = buildPlanningPrompt({ goal: plan.goal, project, agents, existingTasks: services.tasks.list({ projectId: project.id }) });
        runs.log(run, 'system', `planning with ${orchestrator.name} (${orchestrator.harness}/${orchestrator.model || 'default'})\n`);
        const res = await runner.runAgent({ agent: orchestrator, prompt, system: agentSystemPrompt(orchestrator), cwd: project.repoPath || undefined, run, signal: controller.signal });
        if (!stillPlanning()) {
          if (!closed) runs.finish(run.id, { status: 'cancelled', error: 'plan discarded' });
          return current();
        }
        if (res.code === 0 && Array.isArray(res.result?.tasks) && res.result.tasks.length) {
          draft = normalizePlan(res.result);
          source = 'agent';
        } else {
          warnings.push(res.code === 0 ? `${orchestrator.name} did not return a task list; used the built-in planner` : `${orchestrator.name} failed (${(res.stderr || '').split('\n')[0] || `code ${res.code}`}); used the built-in planner`);
        }
      } else {
        runs.log(run, 'system', orchestrator ? `${orchestrator.name} uses the mock harness — using the built-in planner\n` : 'no agents — using the built-in planner\n');
      }
      if (!draft) draft = heuristicPlan(plan.goal);
      if (draft.tasks.length === 0) throw new Error('The plan is empty — describe the goal in more detail');
      const tasks = assignAgents(draft.tasks, agents);
      const final = { summary: draft.summary, tasks, warnings: [...warnings, ...draft.warnings] };
      runs.log(run, 'system', `plan ready: ${tasks.length} tasks (${source})\n${tasks.map((t) => `  - ${t.title} → ${t.agentName || 'unassigned'} [c${t.complexity}]`).join('\n')}\n`);
      runs.finish(run.id, { status: 'succeeded', meta: { tasks: tasks.length, source } });
      if (!stillPlanning()) return current();
      return store.update(plan.id, { status: 'draft', source, plan: final });
    } catch (err) {
      if (closed) return plan;
      if (run) {
        runs.log(run, 'stderr', `${err.message}\n`);
        runs.finish(run.id, { status: 'failed', error: err.message });
      }
      if (!stillPlanning()) return current();
      return store.update(plan.id, { status: 'failed', summary: err.message, plan: { summary: '', tasks: [], warnings: [...warnings, err.message] } });
    } finally {
      planning.delete(plan.id);
    }
  }

  const TERMINAL = new Set(['done', 'failed', 'blocked']);

  /** Marks running/applied plans finished once every one of their tasks is terminal. */
  function closeFinishedPlans(projectId) {
    for (const row of db.all("SELECT id FROM plans WHERE project_id = ? AND status IN ('running', 'applied')", [projectId])) {
      const plan = store.get(row.id);
      if (!plan.taskIds.length) continue;
      const tasks = plan.taskIds.map((id) => db.get('SELECT status FROM tasks WHERE id = ?', [id])).filter(Boolean);
      if (!tasks.every((t) => TERMINAL.has(t.status))) continue;
      const clean = tasks.every((t) => t.status === 'done');
      store.update(plan.id, { status: clean ? 'finished' : 'incomplete', summary: orchestrator.summarize(plan.id) });
    }
  }

  const orchestrator = {
    store,

    /**
     * Starts planning in the background (a real model may take minutes).
     * Resolves immediately with the plan in status "planning"; `plan.updated`
     * events report progress. With autoRun the plan is applied and run as soon as it is ready.
     */
    plan({ projectId, goal, orchestratorId, autoRun = false, runOptions = {} }) {
      services.projects.get(projectId);
      const agent = pickOrchestrator(orchestratorId);
      const id = newId('pln');
      const ts = now();
      db.run('INSERT INTO plans (id, project_id, goal, orchestrator_id, source, status, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        projectId,
        goal,
        agent?.id || null,
        'pending',
        'planning',
        toJson({ summary: '', tasks: [], warnings: [] }),
        ts,
        ts,
      ]);
      const plan = store.get(id);
      bus.publish('plan.created', { projectId, plan });
      producePlan(plan, agent)
        .then((ready) => (autoRun && ready.status === 'draft' ? orchestrator.run(ready.id, runOptions) : ready))
        .catch((err) => {
          log(err);
          // Surface auto-run failures on the plan instead of leaving a silent draft.
          try {
            const p = store.get(id);
            store.update(id, { plan: { ...p.plan, warnings: [...(p.plan.warnings || []), `Auto-run failed: ${err.message}`] } });
          } catch {
            /* plan deleted */
          }
        });
      return plan;
    },

    /**
     * Turns a draft into board tasks (todo, with dependencies and assignees).
     * `edits` may replace the task list (titles, agents, removed tasks) from the UI.
     */
    apply(planId, { tasks: edited } = {}) {
      const plan = store.get(planId);
      if (plan.status !== 'draft') throw conflict(`Plan is ${plan.status}, not a draft`);
      let tasks = plan.plan.tasks;
      let warnings = plan.plan.warnings || [];
      if (edited) {
        // Keys identify tasks across edits, so they must be explicit and unique.
        const keys = new Set();
        for (const t of edited) {
          if (!t || typeof t.key !== 'string' || !t.key.trim()) throw invalidParams('Every edited task needs a key');
          if (keys.has(t.key)) throw invalidParams(`Duplicate task key: ${t.key}`);
          if (typeof t.title !== 'string' || !t.title.trim()) throw invalidParams(`Task ${t.key} needs a title`);
          if (t.agentId !== undefined && t.agentId !== null && typeof t.agentId !== 'string') throw invalidParams(`Task ${t.key}: agentId must be a string`);
          keys.add(t.key);
        }
        const normalized = normalizePlan({ tasks: edited });
        warnings = [...warnings, ...normalized.warnings];
        const original = new Map(plan.plan.tasks.map((t) => [t.key, t]));
        const editedByKey = new Map(edited.map((t) => [t.key, t]));
        tasks = normalized.tasks.map((t) => {
          const before = original.get(t.key);
          let agentId = editedByKey.get(t.key).agentId || null;
          // Complexity changed but the agent was left as proposed: pick again for the new difficulty.
          if (before && agentId === before.agentId && before.complexity !== t.complexity) agentId = null;
          return { ...t, agentId, agentName: null, assignReason: agentId ? 'chosen by you' : '' };
        });
        const kept = new Map();
        for (const t of tasks) if (t.agentId) kept.set(t.agentId, (kept.get(t.agentId) || 0) + 1);
        const filled = new Map(assignAgents(tasks.filter((t) => !t.agentId), services.agents.list(), kept).map((t) => [t.key, t]));
        tasks = tasks.map((t) => filled.get(t.key) || t);
      }
      // Validate every assignee before writing anything (no half-created plans / phantom events).
      for (const t of tasks) if (t.agentId) services.agents.get(t.agentId);
      const { order } = topoSort(
        tasks.map((t) => t.key),
        tasks.flatMap((t) => t.dependsOn.map((d) => ({ from: d, to: t.key }))),
      );
      const byKey = new Map(tasks.map((t) => [t.key, t]));
      const label = `plan:${plan.id.split('_')[1].slice(0, 5)}`;
      const ids = db.tx(() => {
        const keyToId = new Map();
        for (const key of order) {
          const t = byKey.get(key);
          const created = services.tasks.create({
            projectId: plan.projectId,
            title: t.title,
            description: t.description,
            status: 'todo',
            priority: t.priority,
            complexity: t.complexity,
            assigneeId: t.agentId || null,
            labels: [label, t.role],
            dependsOn: t.dependsOn.map((d) => keyToId.get(d)).filter(Boolean),
          });
          keyToId.set(key, created.id);
        }
        return order.map((k) => keyToId.get(k));
      });
      return store.update(planId, { status: 'applied', taskIds: ids, plan: { ...plan.plan, tasks, warnings } });
    },

    /**
     * Applies (if needed) and runs the plan's tasks to completion. The scheduler
     * session is scoped to the plan's tasks, so unrelated cards on the board are
     * not executed. If a session is already live the tasks join it (its options win).
     */
    run(planId, { concurrency = 2, reviewPolicy = 'wait', tasks } = {}) {
      let plan = store.get(planId);
      if (plan.status === 'draft') plan = orchestrator.apply(planId, { tasks });
      if (!['applied', 'running', 'incomplete'].includes(plan.status)) throw conflict(`Plan is ${plan.status}`);
      const warnings = [...(plan.plan.warnings || [])];
      if (scheduler.extend(plan.projectId, plan.taskIds)) {
        const live = scheduler.status(plan.projectId);
        if (live.options?.reviewPolicy !== reviewPolicy || live.options?.concurrency !== concurrency) {
          warnings.push(`Joined the running scheduler, which uses review policy "${live.options?.reviewPolicy}" and ${live.options?.concurrency} parallel agents`);
        }
      } else {
        scheduler.start(plan.projectId, { concurrency, reviewPolicy, includeBacklog: false, taskIds: plan.taskIds });
      }
      return store.update(planId, { status: 'running', plan: { ...plan.plan, warnings } });
    },

    discard(planId) {
      const plan = store.get(planId);
      if (!['draft', 'failed', 'planning'].includes(plan.status)) throw conflict(`Cannot discard a ${plan.status} plan`);
      planning.get(planId)?.abort(); // stop the planning model too
      return store.update(planId, { status: 'discarded' });
    },

    /** Startup: plans whose planning was cut off by a restart can never finish. */
    recoverInterrupted() {
      for (const row of db.all("SELECT id FROM plans WHERE status = 'planning'")) {
        store.update(row.id, { status: 'failed', summary: 'Planning was interrupted by a server restart' });
      }
    },

    /** Shutdown: abort background planning runs. */
    abortAll() {
      closed = true;
      for (const c of planning.values()) c.abort();
    },

    /** Summarises a finished plan from its tasks' outcomes. */
    summarize(planId) {
      const plan = store.get(planId);
      const tasks = plan.taskIds.map((id) => {
        try {
          return services.tasks.get(id);
        } catch {
          return null;
        }
      }).filter(Boolean);
      const count = (s) => tasks.filter((t) => t.status === s).length;
      const lines = tasks.map((t) => `- [${t.status}] ${t.title}${t.result?.summary ? ` — ${t.result.summary}` : t.error ? ` — ${t.error.split('\n')[0]}` : ''}`);
      return `${count('done')}/${tasks.length} done, ${count('failed')} failed, ${count('blocked')} blocked, ${count('review')} awaiting review\n${lines.join('\n')}`;
    },
  };

  // A plan is finished when all of its tasks are — however they were run (plan run, Run all, manual).
  bus.subscribe((e) => {
    if ((e.type === 'task.updated' || e.type === 'task.deleted') && e.payload.projectId) {
      try {
        closeFinishedPlans(e.payload.projectId);
      } catch (err) {
        log(err);
      }
    }
  });

  return orchestrator;
}

export function registerOrchestratorRpc(rpc, orchestrator) {
  const runOptions = (p) => ({
    concurrency: check.number(p, 'concurrency', { optional: true, min: 1, max: 16, integer: true }) ?? 2,
    reviewPolicy: check.oneOf(p, 'reviewPolicy', REVIEW_POLICIES, { optional: true }) ?? 'wait',
  });
  const editedTasks = (p) => {
    if (p.tasks === undefined) return undefined;
    if (!Array.isArray(p.tasks)) throw invalidParams('"tasks" must be an array');
    return p.tasks;
  };
  rpc.group('orchestrator', {
    plan: {
      handler: (p) =>
        orchestrator.plan({
          projectId: check.string(p, 'projectId'),
          goal: check.string(p, 'goal'),
          orchestratorId: check.string(p, 'orchestratorId', { optional: true }),
          autoRun: p.autoRun === true,
          runOptions: runOptions(p),
        }),
      description: 'Plan a natural-language goal into tasks (async; watch plan.updated) {projectId, goal, orchestratorId?, autoRun?, concurrency?, reviewPolicy?}',
    },
    apply: { handler: (p) => orchestrator.apply(check.string(p, 'planId'), { tasks: editedTasks(p) }), description: 'Create board tasks from a draft plan {planId, tasks?}' },
    run: {
      handler: (p) => orchestrator.run(check.string(p, 'planId'), { ...runOptions(p), tasks: editedTasks(p) }),
      description: 'Apply (if needed) and run a plan to completion {planId, tasks?, concurrency?, reviewPolicy?}',
    },
    discard: { handler: (p) => orchestrator.discard(check.string(p, 'planId')), description: 'Discard a draft plan' },
    get: { handler: (p) => orchestrator.store.get(check.string(p, 'planId')), description: 'Get a plan' },
    list: { handler: (p) => orchestrator.store.list(check.string(p, 'projectId')), description: 'Recent plans of a project' },
  });
}
