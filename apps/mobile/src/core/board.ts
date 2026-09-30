import type { Agent, PlanStatus, Task, TaskGraph, TaskStatus } from './types.ts';

export interface Column {
  id: string;
  title: string;
  statuses: TaskStatus[];
}

/** Same columns as the web board. */
export const COLUMNS: Column[] = [
  { id: 'backlog', title: 'Backlog', statuses: ['backlog'] },
  { id: 'todo', title: 'To do', statuses: ['todo'] },
  { id: 'running', title: 'Running', statuses: ['running'] },
  { id: 'review', title: 'Review', statuses: ['review'] },
  { id: 'done', title: 'Done', statuses: ['done'] },
  { id: 'failed', title: 'Failed', statuses: ['failed', 'blocked'] },
];

export const STATUS_COLORS: Record<TaskStatus, string> = {
  backlog: '#6b7280',
  todo: '#4da3ff',
  running: '#ffb547',
  review: '#b77cff',
  done: '#4dd4ac',
  failed: '#ff5c7a',
  blocked: '#ff8a4d',
};

export const PRIORITY_LABELS = ['low', 'normal', 'high', 'urgent'];

export function groupByColumn(tasks: Task[]): Record<string, Task[]> {
  const out: Record<string, Task[]> = Object.fromEntries(COLUMNS.map((c) => [c.id, [] as Task[]]));
  for (const t of tasks) {
    const col = COLUMNS.find((c) => c.statuses.includes(t.status));
    if (col) out[col.id].push(t);
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.position - b.position);
  return out;
}

/** Predecessors that are not done yet. */
export function waitingOn(task: Task, byId: Map<string, Task>): Task[] {
  return task.dependsOn.map((id) => byId.get(id)).filter((t): t is Task => Boolean(t) && t!.status !== 'done');
}

export function progress(tasks: Task[]) {
  const count = (...s: TaskStatus[]) => tasks.filter((t) => s.includes(t.status)).length;
  return { total: tasks.length, done: count('done'), running: count('running'), review: count('review'), failed: count('failed', 'blocked'), ratio: tasks.length ? count('done') / tasks.length : 0 };
}

/** Flow lanes for the orchestrator screen: tasks grouped by topological level. */
export function lanes(graph: TaskGraph): Task[][] {
  const out: Task[][] = [];
  for (const t of graph.tasks) {
    const level = graph.levels[t.id] ?? 0;
    (out[level] ||= []).push(t);
  }
  return out.filter(Boolean).map((lane) => lane.sort((a, b) => b.priority - a.priority || a.position - b.position));
}

/** Which actions make sense for a task in its current state. */
export function taskActions(task: Task, byId: Map<string, Task>) {
  const blockedBy = waitingOn(task, byId);
  return {
    canRun: task.status !== 'running' && Boolean(task.assigneeId) && blockedBy.length === 0,
    canForceRun: task.status !== 'running' && Boolean(task.assigneeId) && blockedBy.length > 0,
    canCancel: task.status === 'running',
    canRetry: ['failed', 'blocked', 'review', 'done'].includes(task.status),
    canApprove: task.status === 'review',
    canMove: task.status !== 'running',
    blockedBy,
  };
}

export const agentLabel = (agent: Agent | undefined) => (agent ? `${agent.name} · ${agent.model || agent.harness}` : 'Unassigned');

export const initials = (name = '?') =>
  name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  planning: 'Planning…',
  draft: 'Draft — review & run',
  failed: 'Planning failed',
  discarded: 'Discarded',
  applied: 'On the board',
  running: 'Running',
  finished: 'Finished',
  incomplete: 'Finished with failures',
};

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
