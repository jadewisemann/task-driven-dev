import { confirmDialog, h, openDrawer, shortId, timeAgo, toast } from '../dom.js';

const STATUSES = ['backlog', 'todo', 'running', 'review', 'done', 'failed', 'blocked'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

/** Task editor side panel: fields, dependencies (predecessors), extension sections. */
export function openTaskDrawer(task, { ctx, board, extensions, reload }) {
  const f = {
    title: h('input', { value: task.title }),
    description: h('textarea', { rows: 6, placeholder: 'What needs to be done? Acceptance criteria…' }, task.description),
    status: h('select', {}, STATUSES.map((s) => h('option', { value: s, selected: s === task.status }, s))),
    priority: h('select', {}, PRIORITIES.map((p, i) => h('option', { value: i, selected: i === task.priority }, p))),
    complexity: h('input', { type: 'range', min: 1, max: 5, value: task.complexity }),
    labels: h('input', { value: task.labels.join(', '), placeholder: 'comma, separated' }),
  };
  const complexityLabel = h('span', { class: 'muted' }, `${task.complexity}/5`);
  f.complexity.addEventListener('input', () => (complexityLabel.textContent = `${f.complexity.value}/5`));

  const selected = new Set(task.dependsOn);
  const others = board.tasks.filter((t) => t.id !== task.id);
  const filter = h('input', { placeholder: 'Filter tasks…', class: 'dep-filter' });
  const depList = h(
    'div',
    { class: 'dep-list' },
    others.map((t) =>
      h(
        'label',
        { class: 'dep-item', dataset: { title: t.title.toLowerCase() } },
        h('input', { type: 'checkbox', checked: selected.has(t.id), onChange: (e) => (e.target.checked ? selected.add(t.id) : selected.delete(t.id)) }),
        h('span', { class: `dot status-${t.status}` }),
        h('span', { class: 'dep-title' }, t.title),
        h('span', { class: 'card-id' }, `#${shortId(t.id)}`),
      ),
    ),
  );
  filter.addEventListener('input', () => {
    const q = filter.value.toLowerCase();
    for (const item of depList.children) item.style.display = item.dataset.title.includes(q) ? '' : 'none';
  });
  const dependents = board.tasks.filter((t) => t.dependsOn.includes(task.id));

  /** Sends only the fields the user changed so concurrent runner updates (status, output) survive. */
  async function save() {
    const next = {
      title: f.title.value,
      description: f.description.value,
      status: f.status.value,
      priority: Number(f.priority.value),
      complexity: Number(f.complexity.value),
      labels: f.labels.value.split(',').map((s) => s.trim()).filter(Boolean),
      dependsOn: [...selected],
    };
    const patch = {};
    for (const [key, value] of Object.entries(next)) {
      if (JSON.stringify(value) !== JSON.stringify(task[key])) patch[key] = value;
    }
    for (const ext of extensions) Object.assign(patch, ext.drawerPatch?.(task) || {});
    if (Object.keys(patch).length) {
      await ctx.rpc('tasks.update', { id: task.id, ...patch });
      toast('Task saved', 'success');
    }
    drawer.close();
  }

  async function remove() {
    if (!(await confirmDialog(`Delete "${task.title}"?`))) return;
    await ctx.rpc('tasks.delete', { id: task.id });
    drawer.close();
  }

  const content = h(
    'div',
    { class: 'task-editor' },
    h('label', { class: 'field' }, h('span', {}, 'Title'), f.title),
    h('label', { class: 'field' }, h('span', {}, 'Description'), f.description),
    h('div', { class: 'field-row' }, h('label', { class: 'field' }, h('span', {}, 'Status'), f.status), h('label', { class: 'field' }, h('span', {}, 'Priority'), f.priority)),
    h('label', { class: 'field' }, h('span', {}, 'Complexity '), complexityLabel, f.complexity),
    h('label', { class: 'field' }, h('span', {}, 'Labels'), f.labels),
    extensions.map((ext) => ext.drawerSection?.(task, board.data, ctx, reload)),
    h('div', { class: 'section' }, h('h4', {}, 'Runs after (predecessors)'), others.length ? [filter, depList] : h('p', { class: 'muted' }, 'No other tasks yet.')),
    dependents.length > 0 && h('div', { class: 'section' }, h('h4', {}, 'Unblocks (successors)'), h('ul', { class: 'plain' }, dependents.map((t) => h('li', {}, h('span', { class: `dot status-${t.status}` }), ' ', t.title)))),
    h('p', { class: 'muted small' }, `#${task.id} · created ${timeAgo(task.createdAt)} · updated ${timeAgo(task.updatedAt)}`),
    h('div', { class: 'drawer-actions' }, h('button', { class: 'btn danger ghost', onClick: () => remove().catch(ctx.showError) }, 'Delete'), h('button', { class: 'btn primary', onClick: () => save().catch(ctx.showError) }, 'Save')),
  );
  const drawer = openDrawer(task.title, content, { width: 520 });
  return drawer;
}
