import { parseJson, toJson } from '../core/db.js';
import { notFound } from '../core/errors.js';
import { newId, now } from '../core/ids.js';

const mapRun = (r) =>
  r && {
    id: r.id,
    projectId: r.project_id,
    taskId: r.task_id,
    agentId: r.agent_id,
    kind: r.kind,
    status: r.status,
    attempt: r.attempt,
    command: r.command,
    cwd: r.cwd,
    exitCode: r.exit_code,
    error: r.error,
    meta: parseJson(r.meta, {}),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };

/** Persistence for runs (one execution of an agent/workflow) and their log lines. */
export function createRunStore({ db, bus }) {
  const store = {
    create({ projectId = null, taskId = null, agentId = null, kind = 'task', attempt = 1, meta = {} }) {
      const id = newId('run');
      db.run('INSERT INTO runs (id, project_id, task_id, agent_id, kind, status, attempt, meta, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        projectId,
        taskId,
        agentId,
        kind,
        'running',
        attempt,
        toJson(meta),
        now(),
      ]);
      const run = store.get(id);
      bus.publish('run.started', { projectId, run });
      return run;
    },

    update(id, fields) {
      const cols = { status: 'status', command: 'command', cwd: 'cwd', exitCode: 'exit_code', error: 'error', finishedAt: 'finished_at' };
      const sets = [];
      const params = [];
      for (const [k, col] of Object.entries(cols)) {
        if (fields[k] === undefined) continue;
        sets.push(`${col} = ?`);
        params.push(fields[k]);
      }
      if (fields.meta) {
        sets.push('meta = ?');
        params.push(toJson({ ...store.get(id).meta, ...fields.meta }));
      }
      if (sets.length) db.run(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
      return store.get(id);
    },

    finish(id, { status, exitCode = null, error = null, meta }) {
      const run = store.update(id, { status, exitCode, error, finishedAt: now(), meta });
      bus.publish('run.finished', { projectId: run.projectId, run });
      return run;
    },

    get(id) {
      const run = mapRun(db.get('SELECT * FROM runs WHERE id = ?', [id]));
      if (!run) throw notFound('Run', id);
      return run;
    },

    list({ projectId, taskId, limit = 50 } = {}) {
      const where = [];
      const params = [];
      if (projectId) {
        where.push('project_id = ?');
        params.push(projectId);
      }
      if (taskId) {
        where.push('task_id = ?');
        params.push(taskId);
      }
      params.push(Math.min(limit, 500));
      return db.all(`SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, rowid DESC LIMIT ?`, params).map(mapRun);
    },

    log(run, stream, text) {
      if (!text) return;
      const ts = now();
      const { lastInsertRowid } = db.run('INSERT INTO run_logs (run_id, ts, stream, text) VALUES (?, ?, ?, ?)', [run.id, ts, stream, text]);
      bus.publish('run.log', { projectId: run.projectId, runId: run.id, taskId: run.taskId, id: Number(lastInsertRowid), ts, stream, text });
    },

    logs(runId, { afterId = 0, limit = 2000 } = {}) {
      return db.all('SELECT id, ts, stream, text FROM run_logs WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?', [runId, afterId, limit]);
    },

    /** Marks runs left 'running' by a crashed/stopped process as interrupted. */
    interruptOrphans() {
      const ids = db.all("SELECT id FROM runs WHERE status = 'running'").map((r) => r.id);
      if (ids.length) db.run("UPDATE runs SET status = 'interrupted', error = 'server stopped while running', finished_at = ? WHERE status = 'running'", [now()]);
      return ids;
    },
  };
  return store;
}
