import { debounce, h, mountInto, shortId, timeAgo } from '../dom.js';
import { logViewer } from '../runs/log-viewer.js';

/** Activity view: every run in the project with a live log console. */
export const runsView = {
  id: 'runs',
  title: 'Runs',
  icon: '≡',
  mount(root, ctx) {
    if (!ctx.project) return mountInto(root, h('div', { class: 'empty' }, 'No project selected.'));
    let selected = null;
    const list = h('div', { class: 'runs-sidebar' });
    const detail = h('div', { class: 'runs-detail' }, h('div', { class: 'empty' }, 'Select a run'));

    const header = h('div', { class: 'run-head' });
    function renderHeader(run) {
      mountInto(
        header,
        h('h3', {}, run.kind === 'task' ? run.meta.taskTitle || `Task #${shortId(run.taskId)}` : `${run.kind} run`),
        h('div', { class: 'muted small' }, `${run.meta.agentName || ''} · ${run.status} · attempt ${run.attempt} · started ${timeAgo(run.startedAt)}`),
        run.command && h('pre', { class: 'preview-block' }, run.command),
      );
    }
    function select(run) {
      selected = run.id;
      for (const el of list.children) el.classList.toggle('active', el.dataset.id === run.id);
      renderHeader(run);
      mountInto(detail, header, logViewer(ctx, run.id, { height: 600 }));
    }

    async function load() {
      const [runs, tasks] = await Promise.all([ctx.rpc('runs.list', { projectId: ctx.project.id, limit: 100 }), ctx.rpc('tasks.list', { projectId: ctx.project.id })]);
      const titles = new Map(tasks.map((t) => [t.id, t.title]));
      mountInto(
        list,
        runs.length === 0 && h('p', { class: 'muted', style: { padding: '12px' } }, 'No runs yet. Use ▶ Run all on the board.'),
        runs.map((r) => {
          r.meta.taskTitle = titles.get(r.taskId) || r.meta.taskTitle;
          return h(
            'button',
            { class: ['run-item', r.id === selected && 'active'], dataset: { id: r.id }, onClick: () => select(r) },
            h('span', { class: `dot run-${r.status}` }),
            h('span', { class: 'run-item-title' }, r.meta.taskTitle || r.kind),
            h('span', { class: 'muted small' }, `${r.meta.agentName || ''} · ${timeAgo(r.startedAt)}`),
          );
        }),
      );
      const current = runs.find((r) => r.id === selected);
      if (current) renderHeader(current); // keep the log console, refresh status
      else if (runs[0]) select(runs[0]);
    }
    const reload = debounce(() => load().catch(ctx.showError), 150);
    mountInto(root, h('div', { class: 'toolbar' }, h('div', { class: 'toolbar-title' }, h('h2', {}, 'Runs'), h('span', { class: 'muted' }, 'Every agent execution with its live log'))), h('div', { class: 'runs-layout' }, list, detail));
    const off = ctx.onEvent((e) => (e.type === 'run.started' || e.type === 'run.finished' || e.type === 'sync.reconnected') && reload());
    load().catch(ctx.showError);
    return off;
  },
};
