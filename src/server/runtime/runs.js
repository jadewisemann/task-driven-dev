import { parseJson, toJson } from '../core/db.js';
import { notFound } from '../core/errors.js';
import { newId, now } from '../core/ids.js';

const FLUSH_MS = 120;
const FLUSH_BYTES = 16 * 1024;
/** Stored log bytes per run; beyond this a single truncation marker is written. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;

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

/**
 * Persistence for runs (one execution of an agent/workflow) and their log lines.
 * Log output is coalesced per run (≈120 ms / 16 KB) so a chatty agent produces a
 * handful of inserts + `run.log` events per second instead of one per chunk.
 */
export function createRunStore({ db, bus }) {
  const buffers = new Map(); // runId -> { run, parts: [{stream, text}], size, timer, stored, capped }
  let closed = false;

  function flush(runId) {
    const buf = buffers.get(runId);
    if (!buf || buf.parts.length === 0) return;
    clearTimeout(buf.timer);
    buf.timer = null;
    const parts = buf.parts;
    buf.parts = [];
    buf.size = 0;
    if (closed) return;
    for (const { stream, text } of parts) {
      const ts = now();
      const { lastInsertRowid } = db.run('INSERT INTO run_logs (run_id, ts, stream, text) VALUES (?, ?, ?, ?)', [runId, ts, stream, text]);
      bus.publish('run.log', { projectId: buf.run.projectId, runId, taskId: buf.run.taskId, id: Number(lastInsertRowid), ts, stream, text });
    }
  }

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
      if (closed) return null;
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
      flush(id);
      buffers.delete(id);
      const run = store.update(id, { status, exitCode, error, finishedAt: now(), meta });
      if (run) bus.publish('run.finished', { projectId: run.projectId, run });
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

    /** Buffers a log chunk; consecutive chunks of the same stream are merged. */
    log(run, stream, text) {
      if (!text || closed) return;
      let buf = buffers.get(run.id);
      if (!buf) {
        buf = { run, parts: [], size: 0, timer: null, stored: 0, capped: false };
        buffers.set(run.id, buf);
      }
      if (buf.capped) return;
      if (buf.stored + text.length > MAX_LOG_BYTES) {
        buf.capped = true;
        text = `\n[log truncated: more than ${MAX_LOG_BYTES / 1024 / 1024} MB of output — see task output for the tail]\n`;
        stream = 'system';
      }
      buf.stored += text.length;
      const last = buf.parts[buf.parts.length - 1];
      if (last && last.stream === stream) last.text += text;
      else buf.parts.push({ stream, text });
      buf.size += text.length;
      if (buf.size >= FLUSH_BYTES || stream === 'system') flush(run.id);
      else if (!buf.timer) buf.timer = setTimeout(() => flush(run.id), FLUSH_MS);
    },

    logs(runId, { afterId = 0, limit = 2000 } = {}) {
      return db.all('SELECT id, ts, stream, text FROM run_logs WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?', [runId, afterId, limit]);
    },

    /** Marks runs left 'running' by a crashed/stopped process as interrupted and returns them. */
    interruptOrphans() {
      const orphans = db.all("SELECT * FROM runs WHERE status = 'running'").map(mapRun);
      if (orphans.length) db.run("UPDATE runs SET status = 'interrupted', error = 'server stopped while running', finished_at = ? WHERE status = 'running'", [now()]);
      return orphans;
    },

    /** Flushes pending logs and turns further writes into no-ops (called on shutdown). */
    close() {
      for (const id of buffers.keys()) flush(id);
      buffers.clear();
      closed = true;
    },
  };
  return store;
}
