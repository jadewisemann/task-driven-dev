import { check, conflict } from '../core/errors.js';
import { ABORT_CANCEL } from './runner.js';
import { REVIEW_POLICIES } from './scheduler.js';

export function registerRuntimeRpc(rpc, { runner, scheduler, runs, services, log }) {
  rpc.group('scheduler', {
    start: {
      handler: (p) =>
        scheduler.start(check.string(p, 'projectId'), {
          concurrency: check.number(p, 'concurrency', { optional: true, min: 1, max: 16, integer: true }) ?? 2,
          includeBacklog: p.includeBacklog === true,
          reviewPolicy: check.oneOf(p, 'reviewPolicy', REVIEW_POLICIES, { optional: true }) ?? 'wait',
        }),
      description: 'Run the project autonomously in dependency order until everything is done {projectId, concurrency?, includeBacklog?, reviewPolicy?: wait|auto-approve}',
    },
    stop: {
      handler: (p) => scheduler.stop(check.string(p, 'projectId'), { cancelRunning: p.cancelRunning !== false }),
      description: 'Stop the scheduler {projectId, cancelRunning?}',
    },
    status: { handler: (p) => scheduler.status(check.string(p, 'projectId')), description: 'Scheduler session state' },
  });

  rpc.group('runs', {
    list: {
      handler: (p) => runs.list({ projectId: check.string(p, 'projectId', { optional: true }), taskId: check.string(p, 'taskId', { optional: true }), limit: check.number(p, 'limit', { optional: true, min: 1, max: 500, integer: true }) }),
      description: 'Recent runs {projectId?, taskId?, limit?}',
    },
    get: { handler: (p) => runs.get(check.string(p, 'id')), description: 'Get a run' },
    logs: {
      handler: (p) => runs.logs(check.string(p, 'runId'), { afterId: check.number(p, 'afterId', { optional: true, integer: true }) ?? 0 }),
      description: 'Log lines of a run {runId, afterId?}',
    },
    cancel: { handler: (p) => ({ cancelled: runner.cancelRun(check.string(p, 'id'), ABORT_CANCEL) }), description: 'Cancel a running run' },
  });

  rpc.register(
    'tasks.run',
    (p) => {
      const task = services.tasks.get(check.string(p, 'taskId'));
      if (runner.isTaskActive(task.id)) throw conflict('Task is already running');
      if (!p.force) {
        const all = new Map(services.tasks.list({ projectId: task.projectId }).map((t) => [t.id, t]));
        const waiting = task.dependsOn.filter((id) => all.get(id)?.status !== 'done');
        if (waiting.length) throw conflict(`Predecessors not done yet: ${waiting.map((id) => all.get(id)?.title || id).join(', ')} (pass force: true to run anyway)`);
      }
      if (!task.assigneeId) throw conflict('Assign an agent first');
      // Fire and forget: progress arrives through run.* / task.* events.
      runner.executeTask(task.id).catch(log);
      return { started: true, taskId: task.id };
    },
    'Run a single task now with its assignee {taskId, force?}',
  );
  rpc.register('tasks.cancel', (p) => ({ cancelled: runner.cancelTask(check.string(p, 'taskId'), ABORT_CANCEL) }), 'Cancel a running task');
  rpc.register(
    'tasks.retry',
    (p) => {
      const task = services.tasks.get(check.string(p, 'taskId'));
      if (!['failed', 'blocked', 'review', 'done'].includes(task.status)) throw conflict(`Cannot retry a ${task.status} task`);
      return services.tasks.update(task.id, { status: 'todo', error: null });
    },
    'Put a failed/finished task back into To do',
  );
}
