import { conflict } from '../core/errors.js';
import { ancestors, descendants } from '../domain/dag.js';
import { ABORT_STOP } from './runner.js';

export const REVIEW_POLICIES = ['wait', 'auto-approve'];
const TERMINAL = new Set(['done', 'failed', 'blocked']);
const INTERNAL = { internal: true };
/** Prefix of errors written when the scheduler blocks a task; only those are auto-released. */
const BLOCKED_PREFIX = 'Blocked:';

/**
 * Autonomous dependency-driven scheduler, one session per project.
 *
 *  - Picks `todo` tasks whose predecessors are all `done`, highest priority first,
 *    up to `concurrency` at once, and runs them with their assignee.
 *  - Retries failures up to the agent's `retries`; a permanent failure marks every
 *    transitive successor `blocked`. Blocked tasks are released automatically when
 *    their failed predecessor is retried and succeeds.
 *  - `review` results either wait for a human (policy "wait") or are accepted
 *    ("auto-approve").
 *  - Keeps going until every task is done/failed/blocked — reacting to board edits
 *    (new tasks, moved cards, approvals) while it runs.
 *
 * Session states: running | waiting (on review/assignees) | finished | stopped
 */
export function createScheduler({ bus, services, runner, log = console.error }) {
  const sessions = new Map();

  function snapshot(s) {
    if (!s) return { state: 'idle' };
    return {
      projectId: s.projectId,
      state: s.state,
      reason: s.reason,
      options: s.options,
      scope: s.scope ? [...s.scope] : null,
      active: [...s.active.keys()],
      stats: { ...s.stats },
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
    };
  }

  const publish = (s) => bus.publish('scheduler.updated', { projectId: s.projectId, scheduler: snapshot(s) });

  function requestTick(s) {
    if (s.tickTimer || s.closed) return;
    s.tickTimer = setTimeout(() => {
      s.tickTimer = null;
      try {
        tick(s);
      } catch (err) {
        log(err);
      }
    }, 30);
  }

  function blockSuccessors(s, taskId, edges, byId) {
    for (const id of descendants(edges, taskId)) {
      const t = byId.get(id);
      // Backlog cards are not scheduled, so they are left alone (and never promoted on release).
      if (t && !['done', 'blocked', 'backlog'].includes(t.status) && !s.active.has(id) && !runner.isTaskActive(id)) {
        services.tasks.update(id, { status: 'blocked', error: `${BLOCKED_PREFIX} predecessor "${byId.get(taskId)?.title || taskId}" failed` }, INTERNAL);
      }
    }
  }

  function onFinished(s, { task, outcome }) {
    s.active.delete(task.id);
    if (s.closed) return;
    if (outcome === 'failed') {
      const agent = task.assigneeId ? safeAgent(task.assigneeId) : null;
      const allowed = agent ? agent.config.retries : 0;
      const used = s.retries.get(task.id) || 0;
      if (used < allowed) {
        s.retries.set(task.id, used + 1);
        s.stats.retried++;
        services.tasks.update(task.id, { status: 'todo' }, INTERNAL);
      } else {
        s.stats.failed++;
        const edges = services.tasks.edges(s.projectId);
        const byId = new Map(services.tasks.list({ projectId: s.projectId }).map((t) => [t.id, t]));
        blockSuccessors(s, task.id, edges, byId);
      }
    } else if (outcome === 'review') {
      if (s.options.reviewPolicy === 'auto-approve') {
        services.tasks.update(task.id, { status: 'done' }, INTERNAL);
        s.stats.succeeded++;
      } else s.stats.review++;
    } else if (outcome === 'done') {
      s.stats.succeeded++;
    } else if (outcome === 'cancelled') {
      s.stats.failed++;
    }
    requestTick(s);
  }

  function safeAgent(id) {
    try {
      return services.agents.get(id);
    } catch {
      return null;
    }
  }

  function tick(s) {
    if (s.closed) return;
    const tasks = services.tasks.list({ projectId: s.projectId });
    const edges = services.tasks.edges(s.projectId);
    const byId = new Map(tasks.map((t) => [t.id, t]));

    // Release blocked tasks whose failure chain has been fixed; (re)block ones sitting behind a failure.
    for (const t of tasks) {
      const upstream = ancestors(edges, t.id);
      const failedUpstream = upstream.some((id) => byId.get(id)?.status === 'failed');
      // Only release cards the scheduler blocked itself; a card the user parked in Blocked stays there.
      if (t.status === 'blocked' && !failedUpstream && (t.error || '').startsWith(BLOCKED_PREFIX)) {
        services.tasks.update(t.id, { status: 'todo', error: null }, INTERNAL);
      } else if (t.status === 'todo' && failedUpstream && !s.active.has(t.id) && !runner.isTaskActive(t.id)) {
        services.tasks.update(t.id, { status: 'blocked', error: `${BLOCKED_PREFIX} a predecessor failed` }, INTERNAL);
      }
    }
    const current = services.tasks.list({ projectId: s.projectId });
    const now = new Map(current.map((t) => [t.id, t]));

    const inScope = (t) => !s.scope || s.scope.has(t.id);
    const ready = current
      .filter((t) => inScope(t) && t.status === 'todo' && !s.active.has(t.id) && !runner.isTaskActive(t.id))
      .filter((t) => t.dependsOn.every((id) => now.get(id)?.status === 'done'))
      .sort((a, b) => b.priority - a.priority || a.position - b.position);
    const unassigned = ready.filter((t) => !t.assigneeId || !safeAgent(t.assigneeId));
    const runnable = ready.filter((t) => !unassigned.includes(t));

    for (const t of runnable) {
      // Manual "Run now" runs in this project count toward the limit too.
      if (Math.max(s.active.size, runner.activeCount(s.projectId)) >= s.options.concurrency) break;
      const promise = runner
        .executeTask(t.id)
        .then((res) => onFinished(s, res))
        .catch((err) => {
          log(err);
          s.active.delete(t.id);
          requestTick(s);
        });
      s.active.set(t.id, promise);
    }

    // Decide the session state.
    const open = current.filter((t) => inScope(t) && !TERMINAL.has(t.status) && t.status !== 'backlog');
    let state = 'running';
    let reason = null;
    if (s.active.size === 0 && runner.activeCount(s.projectId) === 0) {
      if (open.length === 0) {
        state = 'finished';
      } else if (open.some((t) => t.status === 'review')) {
        state = 'waiting';
        reason = 'Waiting for review approval (move reviewed cards to Done)';
      } else if (unassigned.length) {
        state = 'waiting';
        reason = `Waiting for an assignee on: ${unassigned.map((t) => t.title).join(', ')}`;
      } else {
        const outside = open.filter((t) => t.status === 'todo' && t.dependsOn.some((id) => now.get(id)?.status === 'backlog'));
        state = 'waiting';
        reason = outside.length ? 'Waiting on predecessors still in Backlog' : 'Waiting';
      }
    }
    const changed = state !== s.state || reason !== s.reason || s.lastActive !== s.active.size;
    s.state = state;
    s.reason = reason;
    s.lastActive = s.active.size;
    if (state === 'finished') return finish(s, 'finished');
    if (changed) publish(s);
  }

  function finish(s, state) {
    s.closed = true;
    s.state = state;
    s.finishedAt = new Date().toISOString();
    clearTimeout(s.tickTimer);
    clearInterval(s.heartbeat);
    s.unsubscribe();
    publish(s);
    bus.publish(`scheduler.${state}`, { projectId: s.projectId, scheduler: snapshot(s) });
  }

  const scheduler = {
    REVIEW_POLICIES,

    /**
     * @param {string} projectId
     * @param {{concurrency?: number, includeBacklog?: boolean, reviewPolicy?: string, taskIds?: string[]}} [opts]
     *   taskIds: only schedule these tasks (e.g. one orchestrator plan); omit to run the whole board.
     */
    start(projectId, { concurrency = 2, includeBacklog = false, reviewPolicy = 'wait', taskIds } = {}) {
      services.projects.get(projectId);
      const existing = sessions.get(projectId);
      if (existing && !existing.closed) throw conflict('Scheduler is already running for this project');
      if (includeBacklog) {
        for (const t of services.tasks.list({ projectId, status: 'backlog' })) services.tasks.update(t.id, { status: 'todo' }, INTERNAL);
      }
      const s = {
        projectId,
        options: { concurrency, includeBacklog, reviewPolicy },
        scope: taskIds ? new Set(taskIds) : null,
        active: new Map(),
        retries: new Map(),
        stats: { succeeded: 0, failed: 0, retried: 0, review: 0 },
        state: 'running',
        reason: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        closed: false,
        tickTimer: null,
      };
      // React to board edits (new tasks, approvals, retries) while running.
      s.unsubscribe = bus.subscribe((e) => {
        if (e.payload?.projectId === projectId && (e.type.startsWith('task.') || e.type === 'agent.updated')) requestTick(s);
      });
      s.heartbeat = setInterval(() => requestTick(s), 5000);
      s.heartbeat.unref?.();
      sessions.set(projectId, s);
      publish(s);
      bus.publish('scheduler.started', { projectId, scheduler: snapshot(s) });
      tick(s);
      return snapshot(s);
    },

    /** Stops scheduling. Running tasks are aborted (and returned to todo) unless cancelRunning=false. */
    stop(projectId, { cancelRunning = true } = {}) {
      const s = sessions.get(projectId);
      if (!s || s.closed) return snapshot(s);
      if (cancelRunning) for (const taskId of s.active.keys()) runner.cancelTask(taskId, ABORT_STOP);
      finish(s, 'stopped');
      return snapshot(s);
    },

    status(projectId) {
      return snapshot(sessions.get(projectId));
    },

    /**
     * Adds tasks to a live session. Returns false when no session is live
     * (the caller should start one). Unscoped sessions already cover every task.
     */
    extend(projectId, taskIds) {
      const s = sessions.get(projectId);
      if (!s || s.closed) return false;
      if (s.scope) for (const id of taskIds) s.scope.add(id);
      requestTick(s);
      return true;
    },

    stopAll() {
      for (const projectId of sessions.keys()) scheduler.stop(projectId);
    },
  };
  return scheduler;
}
