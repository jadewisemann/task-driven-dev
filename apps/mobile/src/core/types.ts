/**
 * Shapes returned by the todo.devs JSON-RPC API (see src/server/domain/*.js on
 * the server). Only the fields the app uses are typed.
 */

export type TaskStatus = 'backlog' | 'todo' | 'running' | 'review' | 'done' | 'failed' | 'blocked';

export interface Project {
  id: string;
  name: string;
  description: string;
  repoPath: string | null;
}

export interface TaskResult {
  status?: string;
  summary?: string;
  commit?: string;
  [key: string]: unknown;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  complexity: number;
  position: number;
  assigneeId: string | null;
  labels: string[];
  dependsOn: string[];
  output: string | null;
  result: TaskResult | null;
  error: string | null;
  attempts: number;
  branch: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type Effort = 'low' | 'medium' | 'high' | 'max';

export interface Agent {
  id: string;
  name: string;
  role: string;
  persona: string;
  harness: string;
  model: string;
  effort: Effort;
  tier: 1 | 2 | 3;
  color: string;
  config: { autonomy: string; retries: number; workflowId: string | null; [key: string]: unknown };
  updatedAt: string;
}

export interface Harness {
  id: string;
  name: string;
  models: string[];
  installed: boolean;
}

export interface Run {
  id: string;
  projectId: string | null;
  taskId: string | null;
  agentId: string | null;
  kind: string;
  status: string;
  attempt: number;
  command: string | null;
  error: string | null;
  meta: { agentName?: string; taskTitle?: string; workflowName?: string; [key: string]: unknown };
  startedAt: string;
  finishedAt: string | null;
}

export interface LogLine {
  id: number;
  ts: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface SchedulerStatus {
  state: 'idle' | 'running' | 'waiting' | 'finished' | 'stopped';
  reason?: string | null;
  active?: string[];
  stats?: { succeeded: number; failed: number; retried: number; review: number };
  options?: { concurrency: number; reviewPolicy: ReviewPolicy };
}

export type ReviewPolicy = 'wait' | 'auto-approve';

export interface PlanTask {
  key: string;
  title: string;
  description: string;
  role: string;
  complexity: number;
  priority: number;
  dependsOn: string[];
  agentId: string | null;
  agentName?: string | null;
  assignReason?: string;
}

export type PlanStatus = 'planning' | 'draft' | 'failed' | 'discarded' | 'applied' | 'running' | 'finished' | 'incomplete';

export interface Plan {
  id: string;
  projectId: string;
  goal: string;
  source: string;
  status: PlanStatus;
  plan: { summary: string; tasks: PlanTask[]; warnings: string[] };
  taskIds: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskGraph {
  tasks: Task[];
  edges: { from: string; to: string }[];
  levels: Record<string, number>;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  scope: 'project' | 'agent';
  graph: { nodes: { id: string; type: string; name?: string; config?: Record<string, unknown> }[]; edges: unknown[] };
}

export interface Peer {
  id: string;
  name: string;
  transport: 'ssh' | 'exec';
  target: string;
  status: { state: 'disconnected' | 'connecting' | 'connected' | 'error'; error?: string | null; info?: { host?: string } | null };
}

export interface SystemInfo {
  name: string;
  version: string;
  host: string;
}

/** One event from the server bus, as delivered by the long-poll endpoint. */
export interface ServerEvent {
  cursor: number;
  seq: number;
  type: string;
  ts: string;
  payload: Record<string, any>;
  peer?: string;
}

export interface PollResponse {
  epoch: number;
  events: ServerEvent[];
  cursor: number;
  reset: boolean;
}
