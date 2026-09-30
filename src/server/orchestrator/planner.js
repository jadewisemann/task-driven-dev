import { topoSort } from '../domain/dag.js';

export const MAX_PLAN_TASKS = 40;

/** Prompt for the orchestrator model: turn a goal into a dependency-ordered task list. */
export function buildPlanningPrompt({ goal, project, agents, existingTasks = [] }) {
  const team = agents
    .filter((a) => a.role !== 'orchestrator')
    .map((a) => `- ${a.name}: role=${a.role}, tier=${a.tier} (${['', 'small/cheap', 'standard', 'frontier'][a.tier]}), model=${a.model || 'default'}. ${a.persona.split('\n')[0]}`)
    .join('\n');
  const open = existingTasks.filter((t) => t.status !== 'done').slice(0, 30);
  return [
    'You are the orchestrator of a team of AI agents. Break the goal below into small, independently verifiable tasks.',
    '',
    `Goal:\n${goal.trim()}`,
    project?.description?.trim() ? `\nProject brief:\n${project.description.trim()}` : '',
    open.length ? `\nAlready on the board (do not duplicate):\n${open.map((t) => `- ${t.title} (${t.status})`).join('\n')}` : '',
    `\nTeam:\n${team || '- (no agents)'}`,
    '',
    'Rules:',
    '- 2 to 15 tasks. Each task must be completable by one agent in one session.',
    '- dependsOn lists the keys of tasks that must finish first; maximise safe parallelism.',
    '- complexity 1 (trivial) … 5 (hard, needs the strongest model). Be honest: most tasks are 1-3.',
    '- Assign the CHEAPEST capable teammate: small-tier agents for simple work, frontier only for hard tasks.',
    '- End with a review/verification task when the goal involves code.',
    '',
    'Reply with ONLY a fenced ```json block:',
    '```json',
    '{"summary": "one line", "tasks": [{"key": "t1", "title": "...", "description": "acceptance criteria", "role": "engineer", "complexity": 2, "priority": 1, "agent": "<teammate name or empty>", "dependsOn": []}]}',
    '```',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

/**
 * Validates and normalises a plan coming from a model: unique keys, known
 * dependencies, no cycles (offending edges are dropped with a warning).
 * @returns {{summary: string, tasks: object[], warnings: string[]}}
 */
export function normalizePlan(raw) {
  const warnings = [];
  const list = Array.isArray(raw?.tasks) ? raw.tasks : [];
  if (list.length > MAX_PLAN_TASKS) warnings.push(`plan had ${list.length} tasks; kept the first ${MAX_PLAN_TASKS}`);
  const tasks = [];
  const keys = new Set();
  for (const [i, t] of list.slice(0, MAX_PLAN_TASKS).entries()) {
    if (!t || typeof t !== 'object' || typeof t.title !== 'string' || !t.title.trim()) {
      warnings.push(`task #${i + 1} has no title; skipped`);
      continue;
    }
    let key = typeof t.key === 'string' && t.key.trim() ? t.key.trim() : `t${i + 1}`;
    while (keys.has(key)) key = `${key}_`;
    keys.add(key);
    tasks.push({
      key,
      title: t.title.trim().slice(0, 200),
      description: typeof t.description === 'string' ? t.description.trim() : '',
      role: typeof t.role === 'string' && t.role.trim() ? t.role.trim().toLowerCase() : 'engineer',
      complexity: clampInt(t.complexity, 1, 5, 2),
      priority: clampInt(t.priority, 0, 3, 1),
      agent: typeof t.agent === 'string' ? t.agent.trim() : '',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d) => typeof d === 'string') : [],
    });
  }
  for (const t of tasks) {
    const unknown = t.dependsOn.filter((d) => !keys.has(d) || d === t.key);
    if (unknown.length) warnings.push(`"${t.title}": dropped unknown dependencies ${unknown.join(', ')}`);
    t.dependsOn = [...new Set(t.dependsOn.filter((d) => keys.has(d) && d !== t.key))];
  }
  // Break cycles: drop incoming edges of nodes Kahn's algorithm could not order.
  for (let guard = 0; guard < tasks.length; guard++) {
    const { cycle } = topoSort(
      tasks.map((t) => t.key),
      tasks.flatMap((t) => t.dependsOn.map((d) => ({ from: d, to: t.key }))),
    );
    if (!cycle.length) break;
    const victim = tasks.find((t) => t.key === cycle[0]);
    warnings.push(`"${victim.title}": removed dependencies ${victim.dependsOn.join(', ')} to break a cycle`);
    victim.dependsOn = victim.dependsOn.filter((d) => !cycle.includes(d));
  }
  return { summary: typeof raw?.summary === 'string' ? raw.summary : '', tasks, warnings };
}

// English keywords need word boundaries ("build" contains "ui", "docker" contains "doc").
const ROLE_RULES = [
  { role: 'reviewer', re: /\b(review|code review|audit)\b|리뷰|검토/i },
  { role: 'qa', re: /\b(tests?|testing|qa|e2e|coverage|verify|verification)\b|테스트|검증/i },
  { role: 'writer', re: /\b(docs?|documentation|readme|guide|changelog)\b|문서|가이드/i },
  { role: 'devops', re: /\b(deploy|deployment|ci|cd|docker|pipeline|infra|k8s|kubernetes)\b|배포|인프라/i },
  { role: 'frontend', re: /\b(ui|ux|frontend|pages?|components?|css|react|vue|dashboard|screen)\b|프론트|화면|페이지|컴포넌트/i },
  { role: 'backend', re: /\b(api|apis|backend|server|database|db|schema|endpoints?|rest|graphql)\b|백엔드|서버|스키마|엔드포인트|데이터베이스/i },
  { role: 'designer', re: /\b(design system|mockups?|wireframes?)\b|디자인/i },
];

const HARD = /\b(architecture|refactor\w*|migrat\w*|security|performance|distributed|concurren\w*|orchestrat\w*)\b|아키텍처|설계|리팩터|리팩토링|마이그레이션|보안|성능|동시성/i;
const EASY = /\b(typos?|rename|bump|readme|copy|config)\b|오타|이름 변경|문구|설정/i;

function guessComplexity(text) {
  if (HARD.test(text)) return 4;
  if (EASY.test(text)) return 1;
  return text.length > 120 ? 3 : 2;
}

const guessRole = (text) => ROLE_RULES.find((r) => r.re.test(text))?.role || 'engineer';

/**
 * Offline planner used when no real orchestrator model is available (mock
 * harness) or the model's answer was unusable. Splits the goal into steps and
 * infers roles, complexity and dependencies:
 *   - explicit ordering words ("then", "다음", "후에", numbered lists) chain steps;
 *   - tests / docs / review steps wait for all implementation steps before them;
 *   - consecutive implementation steps without ordering words run in parallel.
 */
export function heuristicPlan(goal) {
  const text = goal.trim();
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  let segments = lines.length > 1 ? lines : text.split(/(?<=[.!?。])\s+|;\s*|,?\s+(?:and then|then|그리고 나서|그 다음(?:에)?|다음에|한 후(?:에)?|하고 나서|이후(?:에)?)\s+|,?\s*(?:그리고|및)\s+/i);
  segments = segments.map((s) => s.trim().replace(/[.。]$/, '')).filter((s) => s.length > 2);
  if (segments.length === 0) segments = [text];
  const ordered = lines.length > 1 || /(then|다음|후에|나서|이후|먼저|first)/i.test(text);

  const tasks = segments.slice(0, 15).map((seg, i) => ({
    key: `t${i + 1}`,
    title: seg.length > 90 ? `${seg.slice(0, 87)}…` : seg,
    description: seg,
    role: guessRole(seg),
    complexity: guessComplexity(seg),
    priority: 1,
    agent: '',
    dependsOn: [],
  }));
  const isFollowUp = (t) => ['qa', 'writer', 'reviewer', 'devops'].includes(t.role);
  tasks.forEach((t, i) => {
    if (i === 0) return;
    if (isFollowUp(t)) {
      t.dependsOn = tasks.slice(0, i).filter((p) => !isFollowUp(p) || p.role === 'qa').map((p) => p.key);
      if (t.dependsOn.length === 0) t.dependsOn = [tasks[i - 1].key];
    } else if (ordered) {
      t.dependsOn = [tasks[i - 1].key];
    }
  });
  const implementation = tasks.filter((t) => !isFollowUp(t));
  if (implementation.length >= 1 && !tasks.some((t) => t.role === 'reviewer')) {
    tasks.push({
      key: `t${tasks.length + 1}`,
      title: 'Review and integrate the results',
      description: `Check that the work satisfies the goal:\n${text}\nReport needs_review if anything is missing.`,
      role: 'reviewer',
      complexity: 2,
      priority: 1,
      agent: '',
      dependsOn: tasks.filter((t) => !tasks.some((o) => o.dependsOn.includes(t.key))).map((t) => t.key),
    });
  }
  return { summary: `Built-in plan: ${tasks.length} tasks`, tasks, warnings: [] };
}
