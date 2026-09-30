import { avatar } from '../agents/avatar.js';
import { h } from '../dom.js';
import { registerBoardExtension } from './board-ext.js';

/** Per-drawer assignee selection, read back by drawerPatch when the drawer saves. */
const pendingAssignee = new WeakMap();

/**
 * Board integration for agents: a draggable roster (drop an agent on a card to
 * assign it, like assigning a teammate), assignee avatars on cards and an
 * assignee picker in the task drawer.
 */
registerBoardExtension({
  id: 'agents',
  events: ['agent.'],
  load: (ctx) => ctx.rpc('agents.list'),

  aside(data, ctx) {
    const agents = data.agents || [];
    return h(
      'div',
      { class: 'roster' },
      h('span', { class: 'muted small' }, 'Team — drag onto a card to assign'),
      agents.map((a) =>
        h(
          'span',
          {
            class: 'roster-chip',
            draggable: 'true',
            title: `${a.role} · ${a.harness}/${a.model || 'default'} · effort ${a.effort}`,
            onDragstart: (e) => {
              e.dataTransfer.setData('text/agent-id', a.id);
              e.dataTransfer.effectAllowed = 'link';
            },
          },
          avatar(a, { size: 22 }),
          h('span', {}, a.name),
          h('span', { class: 'muted small' }, a.role),
        ),
      ),
      h('a', { class: 'btn small ghost', href: '#/agents' }, 'Manage agents'),
    );
  },

  async onCardDrop(task, dataTransfer, ctx) {
    const agentId = dataTransfer.getData('text/agent-id');
    if (!agentId) return false;
    await ctx.rpc('tasks.assign', { taskId: task.id, agentId }).catch(ctx.showError);
    return true;
  },

  cardFooter(task, data) {
    const agent = (data.agents || []).find((a) => a.id === task.assigneeId);
    return h('div', { class: 'card-footer' }, avatar(agent, { size: 20 }), h('span', { class: 'muted' }, agent ? `${agent.name} · ${agent.model || agent.harness}` : 'unassigned'));
  },

  drawerSection(task, data) {
    const agents = data.agents || [];
    pendingAssignee.set(task, task.assigneeId);
    const preview = h('div', { class: 'assignee-preview' });
    const renderPreview = (id) => {
      const a = agents.find((x) => x.id === id);
      preview.replaceChildren(avatar(a, { size: 28 }), h('div', {}, h('div', {}, a ? a.name : 'Unassigned'), a && h('div', { class: 'muted small' }, `${a.role} · ${a.harness}/${a.model || 'default'} · effort ${a.effort} · tier ${a.tier}`)));
    };
    renderPreview(task.assigneeId);
    const select = h(
      'select',
      {
        onChange: (e) => {
          const id = e.target.value || null;
          pendingAssignee.set(task, id);
          renderPreview(id);
        },
      },
      h('option', { value: '' }, '— Unassigned —'),
      agents.map((a) => h('option', { value: a.id, selected: a.id === task.assigneeId }, `${a.name} (${a.role}, T${a.tier})`)),
    );
    return h('label', { class: 'field' }, h('span', {}, 'Assignee'), preview, select);
  },

  drawerPatch(task) {
    const next = pendingAssignee.get(task);
    return next !== undefined && next !== task.assigneeId ? { assigneeId: next } : {};
  },
});
