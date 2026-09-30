import { debounce, h, mountInto, shortId } from '../dom.js';
import { boardExtensions } from './board-ext.js';
import { openTaskDrawer } from './task-drawer.js';

export const COLUMNS = [
  { id: 'backlog', title: 'Backlog', statuses: ['backlog'] },
  { id: 'todo', title: 'To do', statuses: ['todo'] },
  { id: 'running', title: 'Running', statuses: ['running'] },
  { id: 'review', title: 'Review', statuses: ['review'] },
  { id: 'done', title: 'Done', statuses: ['done'] },
  { id: 'failed', title: 'Failed / Blocked', statuses: ['failed', 'blocked'] },
];

const PRIORITY = ['low', 'normal', 'high', 'urgent'];

export const boardView = {
  id: 'board',
  title: 'Board',
  icon: '▦',
  mount(root, ctx) {
    if (!ctx.project) {
      mountInto(root, h('div', { class: 'empty' }, 'No project selected.'));
      return;
    }
    const board = { tasks: [], byId: new Map(), data: {} };

    async function load() {
      const [tasks, ...extData] = await Promise.all([
        ctx.rpc('tasks.list', { projectId: ctx.project.id }),
        ...boardExtensions.map((ext) => (ext.load ? ext.load(ctx).catch((err) => (ctx.showError(err), null)) : null)),
      ]);
      board.tasks = tasks;
      board.byId = new Map(tasks.map((t) => [t.id, t]));
      boardExtensions.forEach((ext, i) => (board.data[ext.id] = extData[i]));
      render();
    }
    const reload = debounce(() => load().catch(ctx.showError), 80);

    function waitingOn(task) {
      return task.dependsOn.filter((id) => board.byId.get(id)?.status !== 'done');
    }

    function card(task) {
      const waiting = waitingOn(task);
      const el = h(
        'article',
        {
          class: ['card', `status-${task.status}`],
          draggable: 'true',
          dataset: { id: task.id },
          onDragstart: (e) => {
            e.dataTransfer.setData('text/task-id', task.id);
            e.dataTransfer.effectAllowed = 'move';
            el.classList.add('dragging');
          },
          onDragend: () => el.classList.remove('dragging'),
          onDragover: (e) => {
            if (!e.dataTransfer.types.includes('text/task-id')) {
              e.preventDefault();
              el.classList.add('drop-target');
            }
          },
          onDragleave: () => el.classList.remove('drop-target'),
          onDrop: async (e) => {
            el.classList.remove('drop-target');
            if (e.dataTransfer.types.includes('text/task-id')) return;
            e.preventDefault();
            e.stopPropagation();
            for (const ext of boardExtensions) {
              if (ext.onCardDrop && (await ext.onCardDrop(task, e.dataTransfer, ctx))) return;
            }
          },
          onClick: () => openTaskDrawer(task, { ctx, board, extensions: boardExtensions, reload: load }),
        },
        h('div', { class: 'card-top' }, h('span', { class: 'card-id' }, `#${shortId(task.id)}`), h('span', { class: `prio prio-${task.priority}`, title: `priority: ${PRIORITY[task.priority]}` }, PRIORITY[task.priority])),
        h('div', { class: 'card-title' }, task.title),
        h(
          'div',
          { class: 'card-meta' },
          h('span', { class: 'complexity', title: `complexity ${task.complexity}/5` }, '●'.repeat(task.complexity) + '○'.repeat(5 - task.complexity)),
          task.dependsOn.length > 0 && h('span', { class: ['deps', waiting.length && 'waiting'], title: waiting.length ? `waiting on ${waiting.length} task(s)` : 'dependencies done' }, waiting.length ? `⏳ ${waiting.length}` : `⛓ ${task.dependsOn.length}`),
          task.labels.map((l) => h('span', { class: 'label' }, l)),
        ),
        boardExtensions.map((ext) => ext.cardFooter?.(task, board.data, ctx)),
      );
      return el;
    }

    function dropPosition(list, y) {
      const cards = [...list.querySelectorAll('.card:not(.dragging)')];
      const after = cards.find((c) => {
        const r = c.getBoundingClientRect();
        return y < r.top + r.height / 2;
      });
      const idx = after ? cards.indexOf(after) : cards.length;
      const pos = (i) => board.byId.get(cards[i]?.dataset.id)?.position;
      const prev = idx > 0 ? pos(idx - 1) : undefined;
      const next = idx < cards.length ? pos(idx) : undefined;
      if (prev === undefined && next === undefined) return 1;
      if (prev === undefined) return next - 1;
      if (next === undefined) return prev + 1;
      return (prev + next) / 2;
    }

    function quickAdd(status) {
      const input = h('input', {
        class: 'quick-add',
        placeholder: '+ Add task, press Enter',
        onKeydown: async (e) => {
          if (e.key !== 'Enter' || !input.value.trim()) return;
          const title = input.value.trim();
          input.value = '';
          await ctx.rpc('tasks.create', { projectId: ctx.project.id, title, status }).catch(ctx.showError);
        },
      });
      return input;
    }

    function column(col) {
      const tasks = board.tasks.filter((t) => col.statuses.includes(t.status)).sort((a, b) => a.position - b.position);
      const list = h('div', { class: 'column-list' }, tasks.map(card));
      return h(
        'section',
        {
          class: ['column', `col-${col.id}`],
          onDragover: (e) => {
            if (!e.dataTransfer.types.includes('text/task-id')) return;
            e.preventDefault();
            e.currentTarget.classList.add('over');
          },
          onDragleave: (e) => e.currentTarget.classList.remove('over'),
          onDrop: async (e) => {
            e.currentTarget.classList.remove('over');
            const id = e.dataTransfer.getData('text/task-id');
            if (!id) return;
            e.preventDefault();
            const task = board.byId.get(id);
            const status = col.statuses.includes(task.status) ? task.status : col.statuses[0];
            await ctx.rpc('tasks.move', { id, status, position: dropPosition(list, e.clientY) }).catch(ctx.showError);
          },
        },
        h('header', { class: 'column-head' }, h('span', {}, col.title), h('span', { class: 'count' }, tasks.length)),
        (col.id === 'backlog' || col.id === 'todo') && quickAdd(col.id),
        list,
      );
    }

    function render() {
      const counts = Object.fromEntries(COLUMNS.map((c) => [c.id, board.tasks.filter((t) => c.statuses.includes(t.status)).length]));
      const done = counts.done;
      const total = board.tasks.length;
      mountInto(
        root,
        h(
          'div',
          { class: 'toolbar' },
          h('div', { class: 'toolbar-title' }, h('h2', {}, ctx.project.name), h('span', { class: 'muted' }, `${done}/${total} done`), h('div', { class: 'progress' }, h('div', { class: 'progress-bar', style: { width: `${total ? (done / total) * 100 : 0}%` } }))),
          h('div', { class: 'toolbar-actions' }, boardExtensions.map((ext) => ext.toolbar?.(board.data, ctx, load))),
        ),
        boardExtensions.map((ext) => ext.aside?.(board.data, ctx, load)),
        h('div', { class: 'board' }, COLUMNS.map(column)),
      );
    }

    const prefixes = ['task.', 'sync.', ...boardExtensions.flatMap((e) => e.events || [])];
    const off = ctx.onEvent((e) => {
      if (e.payload?.projectId && e.payload.projectId !== ctx.project.id) return;
      if (prefixes.some((p) => e.type.startsWith(p))) reload();
    });
    load().catch(ctx.showError);
    return off;
  },
};
