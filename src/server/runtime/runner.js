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

/**
 * Executes agents. `runAgent` is the single place where a harness is invoked
 * (tasks, workflow nodes and the orchestrator all go through it);
 * `executeTask` wraps it with task bookkeeping, worktrees and result parsing.
 */
export function createRunner({ bus, services, runs, home }) {
  const controllers = new Map(); // runId -> AbortController
  const activeByTask = new Map(); // taskId -> runId
  const inflight = new Set(); // promises of executing tasks (awaited on shutdown)

  const runner = {
    /**
     * Optional hook (workflow feature): executes an agent's node graph instead
     * of a single harness call. ({agent, task, project, context, cwd, run, signal}) => {code, output, stderr, result}
     */
    agentGraphExecutor: null,

    isTaskActive: (taskId) => activeByTask.has(taskId),

    /**
     * Runs one agent invocation and streams its output into `run`'s log.
     * @returns {Promise<{code: number|null, output: string, stderr: string, result: object|null, cancelled: boolean, timedOut: boolean}>}
     */
    async runAgent({ agent, prompt, system, cwd, input = null, attempt = 1, run, signal }) {
      const onData = (stream, text) => runs.log(run, stream, text);
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
        return { code: 2, output: '', stderr: err.message, result: null, cancelled: false, timedOut: false };
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
        });
      }
      if (res.timedOut) runs.log(run, 'system', `timed out after ${agent.config.timeoutSec}s\n`);
      return { code: res.code, output: res.stdout, stderr: res.stderr, result: parseResult(res.stdout), cancelled: res.cancelled, timedOut: res.timedOut };
    },

    /** Picks the working directory: task worktree > project repo > scratch dir. */
    async prepareWorkspace({ task, project, agent, run }) {
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
          log: (line) => runs.log(run, 'system', `${line}\n`),
        });
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

      const run = runs.create({ projectId: project.id, taskId, agentId: agent.id, kind: 'task', attempt, meta: { agentName: agent.name, model: agent.model, harness: agent.harness } });
      const controller = new AbortController();
      controllers.set(run.id, controller);
      activeByTask.set(taskId, run.id);
      services.tasks.update(taskId, { status: 'running', attempts: attempt, startedAt: now(), finishedAt: null, error: null });
      runs.log(run, 'system', `▶ ${agent.name} (${agent.harness}/${agent.model || 'default'}, effort ${agent.effort}) — attempt ${attempt}\n`);

      let outcome = 'failed';
      let res = null;
      let workspace = null;
      let error = null;
      try {
        workspace = await runner.prepareWorkspace({ task, project, agent, run });
        const fresh = services.tasks.get(taskId);
        const context = buildTaskContext({ agent, task: fresh, project, tasks: services.tasks.list({ projectId: project.id }), edges: services.tasks.edges(project.id) });
        const exec = agent.config.workflowId && runner.agentGraphExecutor ? runner.agentGraphExecutor : null;
        res = exec
          ? await exec({ agent, task: fresh, project, context, cwd: workspace.cwd, run, signal: controller.signal, attempt })
          : await runner.runAgent({ agent, prompt: context.prompt, system: context.system, cwd: workspace.cwd, input: fresh.input, attempt, run, signal: controller.signal });
        if (res.cancelled || controller.signal.aborted) {
          outcome = controller.signal.reason === ABORT_STOP ? 'stopped' : 'cancelled';
        } else {
          outcome = boardStatusFor(res.result, res.code === 0);
          if (outcome === 'failed') error = res.timedOut ? `Timed out after ${agent.config.timeoutSec}s` : tail(res.stderr) || res.result?.summary || `Exited with code ${res.code}`;
        }
      } catch (err) {
        error = err.message;
        runs.log(run, 'stderr', `${err.message}\n`);
      }

      let commit = null;
      if (workspace?.worktree && (outcome === 'done' || outcome === 'review')) {
        try {
          commit = await commitAll({ repoPath: project.repoPath, path: workspace.cwd, message: `todo-devs: ${task.title}\n\nTask ${task.id} by ${agent.name}` });
          if (commit) runs.log(run, 'system', `committed ${commit.slice(0, 10)} on ${workspace.worktree.branch}\n`);
        } catch (err) {
          runs.log(run, 'stderr', `commit failed: ${err.message}\n`);
        }
      }

      const boardStatus = { done: 'done', review: 'review', failed: 'failed', stopped: 'todo', cancelled: 'failed' }[outcome];
      const result = res?.result ? { ...res.result, ...(commit ? { commit } : {}) } : commit ? { commit } : null;
      const updated = services.tasks.update(taskId, {
        status: boardStatus,
        output: res ? res.output.slice(-MAX_OUTPUT) : null,
        result,
        error: outcome === 'cancelled' ? 'Cancelled by user' : outcome === 'stopped' ? null : error,
        finishedAt: now(),
        ...(workspace?.worktree ? { branch: workspace.worktree.branch, worktreePath: workspace.cwd } : {}),
      });
      const finished = runs.finish(run.id, {
        status: outcome === 'done' || outcome === 'review' ? 'succeeded' : outcome,
        exitCode: res?.code ?? null,
        error,
        meta: { outcome, commit, conflicts: workspace?.worktree?.conflicts || [] },
      });
      runs.log(finished, 'system', `■ ${outcome}${error ? `: ${error.split('\n')[0]}` : ''}\n`);
      controllers.delete(run.id);
      activeByTask.delete(taskId);
      return { task: updated, run: finished, outcome };
    },

    /** Aborts a run. reason: ABORT_STOP | ABORT_CANCEL */
    cancelRun(runId, reason = ABORT_CANCEL) {
      const controller = controllers.get(runId);
      if (!controller) return false;
      controller.abort(reason);
      return true;
    },

    cancelTask(taskId, reason = ABORT_CANCEL) {
      const runId = activeByTask.get(taskId);
      return runId ? runner.cancelRun(runId, reason) : false;
    },

    /** Aborts every run and waits (up to `waitMs`) for them to record their outcome. */
    async cancelAll(reason = ABORT_STOP, waitMs = 8000) {
      for (const controller of controllers.values()) controller.abort(reason);
      if (!inflight.size) return;
      await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, waitMs).unref())]);
    },

    /** After a restart: interrupted runs are closed and their tasks go back to todo. */
    recoverInterrupted() {
      runs.interruptOrphans();
      for (const task of services.tasks.list({ status: 'running' })) {
        services.tasks.update(task.id, { status: 'todo', error: 'Interrupted by server restart' });
      }
    },
  };
  return runner;
}
