import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTaskContext } from '../agents/context.js';
import { conflict } from '../core/errors.js';
import { now } from '../core/ids.js';
import { prepareInvocation } from '../harness/registry.js';
import { runMockAgent } from './mock.js';
import { runProcess } from './process.js';
import { boardStatusFor, parseResult } from './result.js';
import { commitAll, ensureWorktree, isGitRepo, scratchDir } from './worktree.js';

const MAX_OUTPUT = 100_000;
const tail = (text, n = 4000) => (text && text.length > n ? `…${text.slice(-n)}` : text || '');

/** Abort reasons: 'stop' (scheduler stopped → task returns to todo) or 'cancel' (user cancelled → failed). */
export const ABORT_STOP = 'stop';
export const ABORT_CANCEL = 'cancel';

/** Internal writes bypass the "task is running" guard on tasks.update. */
const INTERNAL = { internal: true };

/**
 * Executes agents. `runAgent` is the single place where a harness is invoked
 * (tasks, workflow nodes and the orchestrator all go through it);
 * `executeTask` wraps it with task bookkeeping, worktrees and result parsing.
 */
export function createRunner({ bus, services, runs, home, log = console.error }) {
  const controllers = new Map(); // runId -> AbortController
  const activeByTask = new Map(); // taskId -> { runId, projectId }
  const inflight = new Set(); // promises of executing tasks (awaited on shutdown)

  // While a task runs, only the runner may change its status (a drag to Done would let successors start early).
  services.tasks.guardUpdate = (task, patch, opts) => {
    if (!opts?.internal && patch.status && patch.status !== task.status && activeByTask.has(task.id)) {
      throw conflict(`"${task.title}" is running — cancel it before moving it`);
    }
  };
  // Deleting a running task cancels its agent.
  bus.subscribe((e) => {
    if (e.type === 'task.deleted' && activeByTask.has(e.payload.taskId)) runner.cancelTask(e.payload.taskId, ABORT_CANCEL);
  });

  const runner = {
    /**
     * Optional hook (workflow feature): executes an agent's node graph instead
     * of a single harness call. ({agent, task, project, context, cwd, run, signal, attempt}) => {code, output, stderr, result, cancelled?, timedOut?, truncated?}
     */
    agentGraphExecutor: null,

    isTaskActive: (taskId) => activeByTask.has(taskId),
    activeCount: (projectId) => [...activeByTask.values()].filter((a) => a.projectId === projectId).length,

    /**
     * Runs one agent invocation and streams its output into `run`'s log.
     * @returns {Promise<{code: number|null, output: string, stderr: string, result: object|null, cancelled: boolean, timedOut: boolean, truncated: boolean}>}
     */
    async runAgent({ agent, prompt, system, cwd, input = null, attempt = 1, run, signal }) {
      const onData = (stream, text) => runs.log(run, stream, text);
      if (signal?.aborted) return { code: null, output: '', stderr: 'cancelled', result: null, cancelled: true, timedOut: false, truncated: false };
      let invocation;
      try {
        invocation = prepareInvocation(agent, {
          prompt,
          system,
          cwd,
          shellCommand: input && typeof input === 'object' ? input.command : undefined,
          promptFile: home ? join(home, 'runs', run.id, 'prompt.md') : undefined,
        });
      } catch (err) {
        runs.log(run, 'stderr', `${err.message}\n`);
        return { code: 2, output: '', stderr: err.message, result: null, cancelled: false, timedOut: false, truncated: false };
      }
      let res;
      if (invocation.kind === 'builtin') {
        runs.update(run.id, { command: `builtin:${agent.harness}`, cwd });
        res = await runMockAgent({ agent, prompt, input, attempt, signal, onData });
      } else {
        if (invocation.promptFile) {
          mkdirSync(join(invocation.promptFile, '..'), { recursive: true });
          writeFileSync(invocation.promptFile, invocation.promptFileContent, { mode: 0o600 });
        }
        runs.update(run.id, { command: invocation.display, cwd });
        runs.log(run, 'system', `$ ${invocation.display}\n  (cwd: ${cwd})\n`);
        res = await runProcess({
          command: invocation.command,
          args: invocation.args,
          env: invocation.env,
          cwd,
          stdin: invocation.stdin,
          timeoutMs: (agent.config.timeoutSec || 1800) * 1000,
          signal,
          onData,
          // Recorded so a restarted server can kill agents orphaned by a crash.
          onSpawn: (pid) => runs.update(run.id, { meta: { pid } }),
        });
      }
      if (res.timedOut) runs.log(run, 'system', `timed out after ${agent.config.timeoutSec}s\n`);
      return { code: res.code, output: res.stdout, stderr: res.stderr, result: parseResult(res.stdout), cancelled: res.cancelled, timedOut: res.timedOut, truncated: Boolean(res.truncated) };
    },

    /** Picks the working directory: task worktree > project repo > scratch dir. */
    async prepareWorkspace({ task, project, agent, run, attempt }) {
      const repo = project.repoPath;
      if (repo && agent.config.useWorktree && (await isGitRepo(repo))) {
        const all = services.tasks.list({ projectId: project.id });
        const upstreamBranches = task.dependsOn.map((id) => all.find((t) => t.id === id)?.branch).filter(Boolean);
        const wt = await ensureWorktree({
          repoPath: repo,
          root: join(home || repo, 'worktrees', project.id),
          task,
          baseRef: project.settings.baseBranch || 'HEAD',
          upstreamBranches,
          clean: attempt > 1 && agent.config.cleanOnRetry !== false,
          log: (line) => runs.log(run, 'system', `${line}\n`),
        });
        // Persist immediately so a rename or crash can never orphan the branch.
        services.tasks.update(task.id, { branch: wt.branch, worktreePath: wt.path }, INTERNAL);
        return { cwd: wt.path, worktree: wt };
      }
      if (repo) return { cwd: repo, worktree: null };
      return { cwd: scratchDir(home, task), worktree: null };
    },

    /**
     * Runs a task with its assignee and records the outcome on the task.
     * Resolves with { task, run, outcome } where outcome is 'done' | 'review' | 'failed' | 'stopped' | 'cancelled'.
     */
    executeTask(taskId, options) {
      const promise = runner._executeTask(taskId, options);
      inflight.add(promise);
      promise.then(
        () => inflight.delete(promise),
        () => inflight.delete(promise),
      );
      return promise;
    },

    async _executeTask(taskId, { attempt } = {}) {
      if (activeByTask.has(taskId)) throw conflict(`Task is already running: ${taskId}`);
      const task = services.tasks.get(taskId);
      const project = services.projects.get(task.projectId);
      if (!task.assigneeId) throw conflict(`Task "${task.title}" has no assignee`);
      const agent = services.agents.get(task.assigneeId);
      attempt = attempt ?? task.attempts + 1;

      const run = runs.create({ projectId: project.id, taskId, agentId: agent.id, kind: 'task', attempt, meta: { agentName: agent.name, model: agent.model, harness: agent.harness, taskTitle: task.title } });
      const controller = new AbortController();
      controllers.set(run.id, controller);
      activeByTask.set(taskId, { runId: run.id, projectId: project.id });

      let outcome = 'failed';
      let res = null;
      let workspace = null;
      let error = null;
      let commit = null;
      let finalTask = null;
      try {
        services.tasks.update(taskId, { status: 'running', attempts: attempt, startedAt: now(), finishedAt: null, error: null }, INTERNAL);
        runs.log(run, 'system', `▶ ${agent.name} (${agent.harness}/${agent.model || 'default'}, effort ${agent.effort}) — attempt ${attempt}\n`);
        try {
          workspace = await runner.prepareWorkspace({ task, project, agent, run, attempt });
          const fresh = services.tasks.get(taskId);
          const context = buildTaskContext({ agent, task: fresh, project, tasks: services.tasks.list({ projectId: project.id }), edges: services.tasks.edges(project.id) });
          const conflicts = workspace.worktree?.conflicts || [];
          if (conflicts.length) {
            context.prompt += `\n\n### Integration warning\nThese predecessor branches could NOT be merged into your worktree automatically: ${conflicts.join(', ')}.\nIntegrate their changes if your task depends on them, and report "needs_review" if you cannot.`;
          }
          const exec = agent.config.workflowId && runner.agentGraphExecutor ? runner.agentGraphExecutor : null;
          if (controller.signal.aborted) res = { code: null, output: '', stderr: '', result: null, cancelled: true };
          else if (exec) res = await exec({ agent, task: fresh, project, context, cwd: workspace.cwd, run, signal: controller.signal, attempt });
          else res = await runner.runAgent({ agent, prompt: context.prompt, system: context.system, cwd: workspace.cwd, input: fresh.input, attempt, run, signal: controller.signal });

          if (res.cancelled || controller.signal.aborted) {
            outcome = controller.signal.reason === ABORT_STOP ? 'stopped' : 'cancelled';
          } else {
            outcome = boardStatusFor(res.result, res.code === 0, { truncated: res.truncated });
            if (outcome === 'failed') error = res.timedOut ? `Timed out after ${agent.config.timeoutSec}s` : tail(res.stderr) || res.result?.summary || `Exited with code ${res.code}`;
            if (outcome === 'done' && conflicts.length) {
              outcome = 'review';
              error = `Predecessor branches not merged: ${conflicts.join(', ')}`;
            }
          }
        } catch (err) {
          error = err.message;
          runs.log(run, 'stderr', `${err.message}\n`);
        }

        if (workspace?.worktree && (outcome === 'done' || outcome === 'review')) {
          try {
            commit = await commitAll({ repoPath: project.repoPath, path: workspace.cwd, message: `todo-devs: ${task.title}\n\nTask ${task.id} by ${agent.name}` });
            if (commit) runs.log(run, 'system', `committed ${commit.slice(0, 10)} on ${workspace.worktree.branch}\n`);
          } catch (err) {
            // Successors merge this branch: without the commit they would silently miss the work.
            outcome = 'review';
            error = `Work finished but could not be committed (e.g. a pre-commit hook): ${err.message}`;
            runs.log(run, 'stderr', `${error}\n`);
          }
        }

        const boardStatus = { done: 'done', review: 'review', failed: 'failed', stopped: 'todo', cancelled: 'failed' }[outcome];
        const result = res?.result ? { ...res.result, ...(commit ? { commit } : {}) } : commit ? { commit } : null;
        try {
          finalTask = services.tasks.update(
            taskId,
            {
              status: boardStatus,
              output: res ? (res.output || '').slice(-MAX_OUTPUT) : null,
              result,
              error: outcome === 'cancelled' ? 'Cancelled by user' : outcome === 'stopped' ? null : error,
              finishedAt: now(),
            },
            INTERNAL,
          );
        } catch (err) {
          error = error || err.message; // e.g. the task was deleted mid-run
        }
      } finally {
        // Always release the task and close the run, whatever happened above.
        controllers.delete(run.id);
        activeByTask.delete(taskId);
        try {
          const finished = runs.finish(run.id, {
            status: outcome === 'done' || outcome === 'review' ? 'succeeded' : outcome,
            exitCode: res?.code ?? null,
            error,
            meta: { outcome, commit, conflicts: workspace?.worktree?.conflicts || [] },
          });
          if (finished) runs.log(finished, 'system', `■ ${outcome}${error ? `: ${error.split('\n')[0]}` : ''}\n`);
        } catch (err) {
          log(err);
        }
      }
      return { task: finalTask || { id: taskId, projectId: project.id, assigneeId: agent.id, status: 'deleted' }, run: runs.get(run.id), outcome };
    },

    /** Aborts a run. reason: ABORT_STOP | ABORT_CANCEL */
    cancelRun(runId, reason = ABORT_CANCEL) {
      const controller = controllers.get(runId);
      if (!controller) return false;
      controller.abort(reason);
      return true;
    },

    cancelTask(taskId, reason = ABORT_CANCEL) {
      const active = activeByTask.get(taskId);
      return active ? runner.cancelRun(active.runId, reason) : false;
    },

    /** Aborts every run and waits (up to `waitMs`) for them to record their outcome. */
    async cancelAll(reason = ABORT_STOP, waitMs = 8000) {
      for (const controller of controllers.values()) controller.abort(reason);
      if (!inflight.size) return;
      await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, waitMs).unref())]);
    },

    /** After a restart: kill agents orphaned by a crash, close their runs, send tasks back to todo. */
    recoverInterrupted() {
      for (const run of runs.interruptOrphans()) {
        if (run.meta.pid && process.platform !== 'win32') {
          try {
            process.kill(-run.meta.pid, 'SIGTERM');
          } catch {
            /* already gone */
          }
        }
      }
      for (const task of services.tasks.list({ status: 'running' })) {
        services.tasks.update(task.id, { status: 'todo', error: 'Interrupted by server restart' }, INTERNAL);
      }
    },
  };
  return runner;
}
