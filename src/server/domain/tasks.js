import { parseJson, toJson } from '../core/db.js';
import { check, conflict, invalidParams, notFound } from '../core/errors.js';
import { newId, now } from '../core/ids.js';
import { topoSort, wouldCreateCycle } from './dag.js';

/** Board columns, in display order. `blocked` = an upstream task failed. */
export const TASK_STATUSES = ['backlog', 'todo', 'running', 'review', 'done', 'failed', 'blocked'];

/** camelCase field -> [column, kind]. kind: 'json' columns are (de)serialised. */
const FIELDS = {
  title: ['title'],
  description: ['description'],
  status: ['status'],
  priority: ['priority'],
  complexity: ['complexity'],
  position: ['position'],
  assigneeId: ['assignee_id'],
  labels: ['labels', 'json'],
  input: ['input', 'json'],
  output: ['output'],
  result: ['result', 'json'],
  error: ['error'],
  attempts: ['attempts'],
  startedAt: ['started_at'],
  finishedAt: ['finished_at'],
};

function mapRow(r, dependsOn = []) {
  if (!r) return null;
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    complexity: r.complexity,
    position: r.position,
    assigneeId: r.assignee_id,
    labels: parseJson(r.labels, []),
    input: parseJson(r.input, null),
    output: r.output,
    result: parseJson(r.result, null),
    error: r.error,
    attempts: r.attempts,
    dependsOn,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function createTaskService({ db, bus }) {
  const depsOf = (taskId) => db.all('SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY rowid', [taskId]).map((r) => r.depends_on);

  /** Edges (prerequisite -> dependent) for a whole project. */
  const edges = (projectId) =>
    db
      .all('SELECT d.depends_on AS "from", d.task_id AS "to" FROM task_deps d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?', [projectId])
      .map((r) => ({ from: r.from, to: r.to }));

  const publish = (type, task, extra = {}) => bus.publish(type, { projectId: task.projectId, task, ...extra });

  function assertDependencies(task, dependsOn) {
    const unique = [...new Set(dependsOn)];
    if (unique.includes(task.id)) throw invalidParams('A task cannot depend on itself');
    if (unique.length === 0) return unique;
    const placeholders = unique.map(() => '?').join(',');
    const found = db.all(`SELECT id, project_id FROM tasks WHERE id IN (${placeholders})`, unique);
    if (found.length !== unique.length) {
      const missing = unique.filter((id) => !found.some((f) => f.id === id));
      throw notFound('Task', missing.join(', '));
    }
    if (found.some((f) => f.project_id !== task.projectId)) throw invalidParams('Dependencies must belong to the same project');
    const others = edges(task.projectId).filter((e) => e.to !== task.id);
    const accepted = [];
    for (const dep of unique) {
      if (wouldCreateCycle([...others, ...accepted.map((a) => ({ from: a, to: task.id }))], dep, task.id)) {
        throw conflict(`Dependency would create a cycle: ${dep} -> ${task.id}`);
      }
      accepted.push(dep);
    }
    return unique;
  }

  function writeDependencies(taskId, dependsOn) {
    db.run('DELETE FROM task_deps WHERE task_id = ?', [taskId]);
    for (const dep of dependsOn) db.run('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)', [taskId, dep]);
  }

  /** Drag-and-drop uses midpoints; renumber a column once two positions get too close. */
  function rebalanceIfCrowded(projectId, status) {
    const rows = db.all('SELECT id, position FROM tasks WHERE project_id = ? AND status = ? ORDER BY position, created_at', [projectId, status]);
    const crowded = rows.some((r, i) => i > 0 && r.position - rows[i - 1].position < 1e-6);
    if (!crowded) return;
    rows.forEach((r, i) => db.run('UPDATE tasks SET position = ? WHERE id = ?', [i + 1, r.id]));
  }

  function nextPosition(projectId, status) {
    const row = db.get('SELECT MAX(position) AS p FROM tasks WHERE project_id = ? AND status = ?', [projectId, status]);
    return (row?.p ?? 0) + 1;
  }

  const svc = {
    edges,

    list({ projectId, status } = {}) {
      const where = [];
      const params = [];
      if (projectId) {
        where.push('project_id = ?');
        params.push(projectId);
      }
      if (status) {
        where.push('status = ?');
        params.push(status);
      }
      const rows = db.all(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY position, created_at`, params);
      const deps = new Map();
      const depRows = projectId
        ? db.all('SELECT d.task_id, d.depends_on FROM task_deps d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ? ORDER BY d.rowid', [projectId])
        : db.all('SELECT task_id, depends_on FROM task_deps ORDER BY rowid');
      for (const d of depRows) {
        if (!deps.has(d.task_id)) deps.set(d.task_id, []);
        deps.get(d.task_id).push(d.depends_on);
      }
      return rows.map((r) => mapRow(r, deps.get(r.id) || []));
    },

    get(id) {
      const task = mapRow(db.get('SELECT * FROM tasks WHERE id = ?', [id]), depsOf(id));
      if (!task) throw notFound('Task', id);
      return task;
    },

    create(input) {
      const id = newId('tsk');
      const ts = now();
      const status = input.status || 'backlog';
      const task = db.tx(() => {
        db.run(
          `INSERT INTO tasks (id, project_id, title, description, status, priority, complexity, position, assignee_id, labels, input, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            input.projectId,
            input.title,
            input.description || '',
            status,
            input.priority ?? 1,
            input.complexity ?? 2,
            input.position ?? nextPosition(input.projectId, status),
            input.assigneeId || null,
            toJson(input.labels || []),
            toJson(input.input),
            ts,
            ts,
          ],
        );
        if (input.dependsOn?.length) {
          writeDependencies(id, assertDependencies({ id, projectId: input.projectId }, input.dependsOn));
        }
        return svc.get(id);
      });
      publish('task.created', task);
      return task;
    },

    /** Updates any subset of FIELDS plus `dependsOn` (full replacement). */
    update(id, patch) {
      const current = svc.get(id);
      const sets = [];
      const params = [];
      for (const [key, value] of Object.entries(patch)) {
        const field = FIELDS[key];
        if (!field) continue;
        const [column, kind] = field;
        sets.push(`${column} = ?`);
        params.push(kind === 'json' ? toJson(value) : value);
      }
      if (patch.status && patch.status !== current.status && patch.position === undefined) {
        sets.push('position = ?');
        params.push(nextPosition(current.projectId, patch.status));
      }
      const task = db.tx(() => {
        if (sets.length) {
          sets.push('updated_at = ?');
          params.push(now(), id);
          db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params);
        }
        if (patch.dependsOn) writeDependencies(id, assertDependencies(current, patch.dependsOn));
        if (patch.position !== undefined) rebalanceIfCrowded(current.projectId, patch.status || current.status);
        return svc.get(id);
      });
      publish('task.updated', task, { previousStatus: current.status, changes: Object.keys(patch) });
      return task;
    },

    addDependency(taskId, dependsOn) {
      const task = svc.get(taskId);
      if (task.dependsOn.includes(dependsOn)) return task;
      return svc.update(taskId, { dependsOn: [...task.dependsOn, dependsOn] });
    },

    removeDependency(taskId, dependsOn) {
      const task = svc.get(taskId);
      return svc.update(taskId, { dependsOn: task.dependsOn.filter((d) => d !== dependsOn) });
    },

    /** Deletes a task. Dependents lose that edge, so they are re-published as updated. */
    delete(id) {
      const task = svc.get(id);
      const dependents = db.all('SELECT task_id FROM task_deps WHERE depends_on = ?', [id]).map((r) => r.task_id);
      db.run('DELETE FROM tasks WHERE id = ?', [id]);
      bus.publish('task.deleted', { projectId: task.projectId, taskId: id, affectedTaskIds: dependents });
      for (const depId of dependents) publish('task.updated', svc.get(depId), { changes: ['dependsOn'] });
      return { ok: true, affectedTaskIds: dependents };
    },

    /** Tasks + edges + topological levels for flow views. */
    graph(projectId) {
      const tasks = svc.list({ projectId });
      const e = edges(projectId);
      const { order, levels, cycle } = topoSort(
        tasks.map((t) => t.id),
        e,
      );
      return { tasks, edges: e, order, levels, cycle };
    },
  };
  return svc;
}

export function registerTaskRpc(rpc, tasks, projects) {
  const patchFrom = (p) => {
    const patch = {};
    if (p.title !== undefined) patch.title = check.string(p, 'title');
    if (p.description !== undefined) patch.description = check.string(p, 'description', { allowEmpty: true });
    if (p.status !== undefined) patch.status = check.oneOf(p, 'status', TASK_STATUSES);
    if (p.priority !== undefined) patch.priority = check.number(p, 'priority', { min: 0, max: 3, integer: true });
    if (p.complexity !== undefined) patch.complexity = check.number(p, 'complexity', { min: 1, max: 5, integer: true });
    if (p.position !== undefined) patch.position = check.number(p, 'position');
    if (p.assigneeId !== undefined) patch.assigneeId = p.assigneeId === null ? null : check.string(p, 'assigneeId');
    if (p.labels !== undefined) patch.labels = check.stringArray(p, 'labels');
    if (p.dependsOn !== undefined) patch.dependsOn = check.stringArray(p, 'dependsOn');
    if (p.input !== undefined) patch.input = p.input;
    return patch;
  };

  rpc.group('tasks', {
    statuses: { handler: () => TASK_STATUSES, description: 'List task statuses (board columns)' },
    list: {
      handler: (p) => tasks.list({ projectId: check.string(p, 'projectId', { optional: true }), status: check.oneOf(p, 'status', TASK_STATUSES, { optional: true }) }),
      description: 'List tasks {projectId?, status?}',
    },
    get: { handler: (p) => tasks.get(check.string(p, 'id')), description: 'Get a task' },
    create: {
      handler: (p) => {
        const projectId = check.string(p, 'projectId');
        projects.get(projectId);
        return tasks.create({ ...patchFrom(p), projectId, title: check.string(p, 'title') });
      },
      description: 'Create a task {projectId, title, description?, status?, priority?, complexity?, assigneeId?, dependsOn?}',
    },
    update: { handler: (p) => tasks.update(check.string(p, 'id'), patchFrom(p)), description: 'Update task fields' },
    move: {
      handler: (p) =>
        tasks.update(check.string(p, 'id'), {
          status: check.oneOf(p, 'status', TASK_STATUSES),
          ...(p.position !== undefined ? { position: check.number(p, 'position') } : {}),
        }),
      description: 'Move a task to a column {id, status, position?}',
    },
    delete: { handler: (p) => tasks.delete(check.string(p, 'id')), description: 'Delete a task' },
    addDependency: {
      handler: (p) => tasks.addDependency(check.string(p, 'taskId'), check.string(p, 'dependsOn')),
      description: 'Make taskId wait for dependsOn',
    },
    removeDependency: {
      handler: (p) => tasks.removeDependency(check.string(p, 'taskId'), check.string(p, 'dependsOn')),
      description: 'Remove a dependency edge',
    },
    graph: { handler: (p) => tasks.graph(check.string(p, 'projectId')), description: 'Dependency graph with topological levels' },
  });
}
