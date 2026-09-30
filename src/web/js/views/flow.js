import { avatar, tierBadge } from '../agents/avatar.js';
import { debounce, h, mountInto, timeAgo, toast } from '../dom.js';
import { renderDag } from '../flow/dag.js';
import { logViewer } from '../runs/log-viewer.js';
import { startScheduler } from './board-runner.js';

const PLAN_STATUS = { planning: 'planning…', draft: 'draft — review & run', failed: 'failed', applied: 'on the board', running: 'running', finished: 'finished', discarded: 'discarded' };

/**
 * Orchestrator mode: describe a goal in natural language, let a high-tier agent
 * plan it into tasks assigned to cheaper agents, then watch the whole
 * dependency flow execute live.
 */
export const flowView = {
  id: 'flow',
  title: 'Orchestrator',
  icon: '✦',
  mount(root, ctx) {
    if (!ctx.project) return mountInto(root, h('div', { class: 'empty' }, 'No project selected.'));
    const state = { agents: [], plans: [], graph: null, scheduler: { state: 'idle' }, selected: null, filterPlan: null, draftEdits: null };

    const composer = h('div', { class: 'composer panel' });
    const planBox = h('div', { class: 'plan-box' });
    const toolbar = h('div', { class: 'flow-toolbar' });
    const canvas = h('div', { class: 'flow-canvas panel' });
    const side = h('div', { class: 'flow-side panel' }, h('p', { class: 'muted' }, 'Click a task in the flow to see its details and live log.'));
    const history = h('div', { class: 'plan-history' });

    // ---------- composer ----------
    const goal = h('textarea', { rows: 3, placeholder: 'Describe what you want built, e.g. "로그인 API를 만들고 그 다음 로그인 화면, 그리고 테스트 작성" or "Add Stripe checkout: backend endpoint, checkout page, webhooks, tests"' });
    const lead = h('select', { title: 'Orchestrator (plans and assigns)' });
    const concurrency = h('input', { type: 'number', min: 1, max: 16, value: 2, title: 'Parallel agents', style: { width: '64px' } });
    const review = h('select', {}, h('option', { value: 'auto-approve' }, 'auto-approve reviews'), h('option', { value: 'wait' }, 'wait for my review'));

    async function submit(autoRun) {
      if (!goal.value.trim()) return toast('Describe the goal first', 'error');
      await ctx.rpc('orchestrator.plan', { projectId: ctx.project.id, goal: goal.value, orchestratorId: lead.value || undefined, autoRun, concurrency: Number(concurrency.value) || 2, reviewPolicy: review.value });
      toast(autoRun ? 'Planning — tasks will start automatically' : 'Planning…', 'success');
      goal.value = '';
    }
    goal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(true).catch(ctx.showError);
    });

    function renderComposer() {
      const leads = [...state.agents].sort((a, b) => (b.role === 'orchestrator') - (a.role === 'orchestrator') || b.tier - a.tier);
      lead.replaceChildren(...leads.map((a) => h('option', { value: a.id }, `${a.name} · ${a.role} · T${a.tier} · ${a.harness}/${a.model || 'default'}`)));
      mountInto(
        composer,
        h('div', { class: 'composer-head' }, h('h3', {}, 'What should the team build?'), h('span', { class: 'muted small' }, 'The orchestrator splits the goal into tasks, wires dependencies and hands each task to the cheapest capable agent.')),
        goal,
        h(
          'div',
          { class: 'composer-actions' },
          h('label', { class: 'inline' }, h('span', { class: 'muted small' }, 'Orchestrator'), lead),
          h('label', { class: 'inline' }, h('span', { class: 'muted small' }, 'Parallel'), concurrency),
          review,
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn', onClick: () => submit(false).catch(ctx.showError) }, 'Plan only'),
          h('button', { class: 'btn primary', onClick: () => submit(true).catch(ctx.showError), title: 'Ctrl/⌘ + Enter' }, '✦ Plan & run'),
        ),
      );
    }

    // ---------- plan review ----------
    const activePlan = () => state.plans.find((p) => p.status === 'planning' || p.status === 'draft' || p.status === 'failed');

    function renderPlan() {
      const plan = activePlan();
      if (!plan) return mountInto(planBox);
      if (plan.status === 'planning') {
        return mountInto(planBox, h('div', { class: 'panel plan-card' }, h('div', { class: 'plan-head' }, h('span', { class: 'spinner' }), h('strong', {}, 'Planning: '), h('span', {}, plan.goal))));
      }
      if (plan.status === 'failed') {
        return mountInto(planBox, h('div', { class: 'panel plan-card' }, h('div', { class: 'plan-head' }, h('strong', { class: 'warn-text' }, 'Planning failed: '), h('span', {}, plan.summary || '')), h('button', { class: 'btn small', onClick: () => ctx.rpc('orchestrator.discard', { planId: plan.id }).catch(ctx.showError) }, 'Dismiss')));
      }
      if (!state.draftEdits || state.draftEdits.planId !== plan.id) state.draftEdits = { planId: plan.id, tasks: structuredClone(plan.plan.tasks) };
      const tasks = state.draftEdits.tasks;
      const keys = tasks.map((t) => t.key);
      const row = (t, i) =>
        h(
          'tr',
          {},
          h('td', { class: 'muted small' }, t.key),
          h('td', {}, h('input', { value: t.title, onInput: (e) => (t.title = e.target.value) })),
          h('td', {}, h('span', { class: 'tag' }, t.role)),
          h('td', {}, h('select', { onChange: (e) => (t.complexity = Number(e.target.value)) }, [1, 2, 3, 4, 5].map((c) => h('option', { value: c, selected: c === t.complexity }, `c${c}`)))),
          h(
            'td',
            {},
            h(
              'select',
              { onChange: (e) => (t.agentId = e.target.value || null) },
              state.agents.map((a) => h('option', { value: a.id, selected: a.id === t.agentId }, `${a.name} (T${a.tier})`)),
            ),
            h('div', { class: 'muted small' }, t.assignReason || ''),
          ),
          h('td', { class: 'small' }, h('input', { class: 'code', value: t.dependsOn.join(', '), title: `keys: ${keys.join(', ')}`, onChange: (e) => (t.dependsOn = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)) })),
          h('td', {}, h('button', { class: 'icon-btn', title: 'Remove', onClick: () => (tasks.splice(i, 1), tasks.forEach((o) => (o.dependsOn = o.dependsOn.filter((d) => d !== t.key))), renderPlan()) }, '✕')),
        );
      mountInto(
        planBox,
        h(
          'div',
          { class: 'panel plan-card' },
          h('div', { class: 'plan-head' }, h('strong', {}, 'Proposed plan'), h('span', { class: 'muted' }, ` — ${plan.goal}`), h('span', { class: 'badge' }, plan.source === 'agent' ? 'planned by orchestrator model' : 'built-in planner')),
          plan.plan.warnings?.length > 0 && h('ul', { class: 'warnings' }, plan.plan.warnings.map((w) => h('li', { class: 'warn-text small' }, w))),
          h('table', { class: 'plan-table' }, h('thead', {}, h('tr', {}, ['key', 'task', 'role', 'complexity', 'agent', 'after (keys)', ''].map((c) => h('th', {}, c)))), h('tbody', {}, tasks.map(row))),
          h(
            'div',
            { class: 'composer-actions' },
            h('button', { class: 'btn ghost', onClick: () => ctx.rpc('orchestrator.discard', { planId: plan.id }).catch(ctx.showError) }, 'Discard'),
            h('div', { class: 'spacer' }),
            h('button', { class: 'btn', onClick: () => ctx.rpc('orchestrator.apply', { planId: plan.id, tasks }).catch(ctx.showError) }, 'Add to board'),
            h('button', { class: 'btn primary', onClick: () => ctx.rpc('orchestrator.run', { planId: plan.id, tasks, concurrency: Number(concurrency.value) || 2, reviewPolicy: review.value }).catch(ctx.showError) }, '▶ Run plan'),
          ),
        ),
      );
    }

    // ---------- flow ----------
    function visibleGraph() {
      const g = state.graph;
      if (!g) return null;
      const plan = state.plans.find((p) => p.id === state.filterPlan);
      if (!plan) return g;
      const ids = new Set(plan.taskIds);
      return { ...g, tasks: g.tasks.filter((t) => ids.has(t.id)), edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
    }

    function renderToolbar() {
      const g = visibleGraph();
      const total = g?.tasks.length || 0;
      const count = (s) => g?.tasks.filter((t) => t.status === s).length || 0;
      const s = state.scheduler;
      const live = s.state === 'running' || s.state === 'waiting';
      mountInto(
        toolbar,
        h('h3', {}, 'Flow'),
        h('div', { class: 'progress wide' }, h('div', { class: 'progress-bar', style: { width: `${total ? (count('done') / total) * 100 : 0}%` } })),
        h('span', { class: 'muted small' }, `${count('done')}/${total} done · ${count('running')} running · ${count('failed') + count('blocked')} failed/blocked · ${count('review')} review`),
        h('div', { class: 'spacer' }),
        h(
          'select',
          { onChange: (e) => ((state.filterPlan = e.target.value || null), renderFlow()) },
          h('option', { value: '' }, 'All tasks'),
          state.plans.filter((p) => p.taskIds.length).map((p) => h('option', { value: p.id, selected: p.id === state.filterPlan }, `Plan: ${p.goal.slice(0, 40)}`)),
        ),
        h('span', { class: `sched-pill sched-${s.state}`, title: s.reason || '' }, h('span', { class: 'dot' }), `scheduler ${s.state}`),
        live
          ? h('button', { class: 'btn danger', onClick: () => ctx.rpc('scheduler.stop', { projectId: ctx.project.id }).catch(ctx.showError) }, '■ Stop')
          : h('button', { class: 'btn success', onClick: () => startScheduler(ctx).catch(ctx.showError) }, '▶ Run all'),
      );
    }

    function renderFlow() {
      renderToolbar();
      const g = visibleGraph();
      if (!g || g.tasks.length === 0) return mountInto(canvas, h('div', { class: 'empty' }, 'No tasks yet. Describe a goal above and the orchestrator will build the flow.'));
      mountInto(canvas, renderDag(g, { agents: state.agents, selectedId: state.selected, onSelect: (t) => selectTask(t.id) }));
    }

    async function selectTask(taskId) {
      state.selected = taskId;
      renderFlow();
      const [task, runs] = await Promise.all([ctx.rpc('tasks.get', { id: taskId }), ctx.rpc('runs.list', { taskId, limit: 5 })]);
      const agent = state.agents.find((a) => a.id === task.assigneeId);
      const act = (method, params) => () => ctx.rpc(method, params).catch(ctx.showError);
      mountInto(
        side,
        h('div', { class: 'side-head' }, h('span', { class: `dot status-${task.status}` }), h('h3', {}, task.title)),
        h('div', { class: 'assignee-preview' }, avatar(agent, { size: 28 }), h('div', {}, h('div', {}, agent ? agent.name : 'Unassigned', ' ', agent && tierBadge(agent.tier)), agent && h('div', { class: 'muted small' }, `${agent.role} · ${agent.harness}/${agent.model || 'default'} · effort ${agent.effort}`))),
        h('p', { class: 'muted small' }, `${task.status} · complexity ${task.complexity} · ${task.dependsOn.length} predecessor(s) · updated ${timeAgo(task.updatedAt)}`),
        task.description && h('pre', { class: 'preview-block' }, task.description),
        h(
          'div',
          { class: 'run-actions' },
          task.status === 'running' ? h('button', { class: 'btn danger small', onClick: act('tasks.cancel', { taskId }) }, '■ Cancel') : h('button', { class: 'btn success small', onClick: act('tasks.run', { taskId }) }, '▶ Run now'),
          ['failed', 'blocked', 'review', 'done'].includes(task.status) && h('button', { class: 'btn small', onClick: act('tasks.retry', { taskId }) }, '↻ Re-queue'),
          task.status === 'review' && h('button', { class: 'btn small success', onClick: act('tasks.move', { id: taskId, status: 'done' }) }, 'Approve'),
        ),
        task.error && h('pre', { class: 'preview-block error-block' }, task.error),
        task.result && h('pre', { class: 'preview-block' }, JSON.stringify(task.result, null, 2)),
        runs[0] ? [h('h4', {}, `Live log · attempt ${runs[0].attempt}`), logViewer(ctx, runs[0].id, { height: 300 })] : h('p', { class: 'muted small' }, 'Not run yet.'),
      );
    }

    function renderHistory() {
      const done = state.plans.filter((p) => !['planning', 'draft'].includes(p.status));
      mountInto(
        history,
        done.length > 0 && h('h4', {}, 'Plans'),
        done.map((p) =>
          h(
            'details',
            { class: 'plan-item' },
            h('summary', {}, h('span', { class: `badge plan-${p.status}` }, PLAN_STATUS[p.status] || p.status), ' ', p.goal.slice(0, 80), h('span', { class: 'muted small' }, ` · ${p.taskIds.length} tasks · ${timeAgo(p.createdAt)}`)),
            p.summary && h('pre', { class: 'preview-block' }, p.summary),
          ),
        ),
      );
    }

    async function load() {
      const [agents, plans, graph, scheduler] = await Promise.all([
        ctx.rpc('agents.list'),
        ctx.rpc('orchestrator.list', { projectId: ctx.project.id }),
        ctx.rpc('tasks.graph', { projectId: ctx.project.id }),
        ctx.rpc('scheduler.status', { projectId: ctx.project.id }),
      ]);
      const agentsChanged = JSON.stringify(agents) !== JSON.stringify(state.agents);
      Object.assign(state, { agents, plans, graph, scheduler });
      if (agentsChanged) renderComposer();
      renderPlan();
      renderFlow();
      renderHistory();
    }
    const reload = debounce(() => load().catch(ctx.showError), 120);

    mountInto(root, composer, planBox, h('div', { class: 'flow-layout' }, h('div', { class: 'flow-main' }, toolbar, canvas, history), side));
    renderComposer();
    const off = ctx.onEvent((e) => {
      if (e.payload?.projectId && e.payload.projectId !== ctx.project.id) return;
      if (/^(task\.|plan\.|scheduler\.|agent\.|sync\.)/.test(e.type)) reload();
      if (state.selected && e.type === 'task.updated' && e.payload.task?.id === state.selected) selectTask(state.selected).catch(ctx.showError);
      if (state.selected && e.type === 'run.started' && e.payload.run?.taskId === state.selected) selectTask(state.selected).catch(ctx.showError);
    });
    load().catch(ctx.showError);
    return off;
  },
};
