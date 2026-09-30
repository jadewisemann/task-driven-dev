import type { TodoDevsClient } from './client.ts';
import type {
  Agent,
  Effort,
  Harness,
  LogLine,
  Peer,
  Plan,
  PlanTask,
  Project,
  ReviewPolicy,
  Run,
  SchedulerStatus,
  SystemInfo,
  Task,
  TaskGraph,
  TaskStatus,
  Workflow,
} from './types.ts';

/**
 * Typed wrappers for the RPC methods the app uses, bound to one session
 * (`peer` = null for the server itself, or a peer id for a remote machine
 * reached through it over SSH). `peers.*` always runs on the server itself.
 */
export function createApi(client: TodoDevsClient, peer: string | null = null) {
  const call = <T>(method: string, params: Record<string, unknown> = {}) => client.rpc<T>(method, params, { peer });
  const local = <T>(method: string, params: Record<string, unknown> = {}) => client.rpc<T>(method, params);

  return {
    peer,
    system: {
      info: () => call<SystemInfo>('system.info'),
    },
    projects: {
      list: () => call<Project[]>('projects.list'),
    },
    tasks: {
      list: (projectId: string) => call<Task[]>('tasks.list', { projectId }),
      get: (id: string) => call<Task>('tasks.get', { id }),
      graph: (projectId: string) => call<TaskGraph>('tasks.graph', { projectId }),
      create: (input: { projectId: string; title: string; description?: string; status?: TaskStatus; assigneeId?: string | null; dependsOn?: string[] }) => call<Task>('tasks.create', input),
      update: (id: string, patch: Partial<Pick<Task, 'title' | 'description' | 'priority' | 'complexity'>> & { dependsOn?: string[] }) => call<Task>('tasks.update', { id, ...patch }),
      move: (id: string, status: TaskStatus) => call<Task>('tasks.move', { id, status }),
      assign: (taskId: string, agentId: string | null) => call<Task>('tasks.assign', { taskId, agentId }),
      run: (taskId: string, force = false) => call<{ started: boolean }>('tasks.run', { taskId, force }),
      cancel: (taskId: string) => call<{ cancelled: boolean }>('tasks.cancel', { taskId }),
      retry: (taskId: string) => call<Task>('tasks.retry', { taskId }),
      remove: (id: string) => call<{ ok: boolean }>('tasks.delete', { id }),
    },
    agents: {
      list: () => call<Agent[]>('agents.list'),
      update: (id: string, patch: { model?: string; effort?: Effort; tier?: number; persona?: string }) => call<Agent>('agents.update', { id, ...patch }),
      harnesses: () => call<Harness[]>('harnesses.list'),
    },
    scheduler: {
      status: (projectId: string) => call<SchedulerStatus>('scheduler.status', { projectId }),
      start: (projectId: string, opts: { concurrency?: number; reviewPolicy?: ReviewPolicy } = {}) => call<SchedulerStatus>('scheduler.start', { projectId, ...opts }),
      stop: (projectId: string) => call<SchedulerStatus>('scheduler.stop', { projectId }),
    },
    runs: {
      list: (params: { projectId?: string; taskId?: string; limit?: number }) => call<Run[]>('runs.list', params),
      get: (id: string) => call<Run>('runs.get', { id }),
      logs: (runId: string, afterId = 0) => call<LogLine[]>('runs.logs', { runId, afterId }),
      cancel: (id: string) => call<{ cancelled: boolean }>('runs.cancel', { id }),
    },
    orchestrator: {
      plan: (input: { projectId: string; goal: string; autoRun?: boolean; reviewPolicy?: ReviewPolicy; concurrency?: number; orchestratorId?: string }) => call<Plan>('orchestrator.plan', input),
      list: (projectId: string) => call<Plan[]>('orchestrator.list', { projectId }),
      get: (planId: string) => call<Plan>('orchestrator.get', { planId }),
      run: (planId: string, opts: { tasks?: PlanTask[]; reviewPolicy?: ReviewPolicy; concurrency?: number } = {}) => call<Plan>('orchestrator.run', { planId, ...opts }),
      apply: (planId: string, tasks?: PlanTask[]) => call<Plan>('orchestrator.apply', { planId, ...(tasks ? { tasks } : {}) }),
      discard: (planId: string) => call<Plan>('orchestrator.discard', { planId }),
    },
    workflows: {
      list: (projectId: string) => call<Workflow[]>('workflows.list', { projectId, scope: 'project' }),
      run: (id: string, projectId: string, input: unknown) =>
        call<{ runId: string; status: string; result?: { text?: unknown; json?: unknown } | null; error?: string }>('workflows.run', { id, projectId, input, wait: true }),
    },
    peers: {
      list: () => local<Peer[]>('peers.list'),
      connect: (id: string) => local<{ peerId: string }>('peers.connect', { id }),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
