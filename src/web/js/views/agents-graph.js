import { h } from '../dom.js';
import { agentEditorSections } from './agents.js';

/** Agent editor section: pick the agent's node graph (its own multi-step process). */
agentEditorSections.push((agent, form, ctx) => {
  const select = h('select', { onChange: (e) => (form.config.workflowId = e.target.value || null) }, h('option', { value: '' }, 'Single step — one harness call per task'));
  ctx
    .rpc('workflows.list', { scope: 'agent' })
    .then((list) => {
      for (const wf of list) select.append(h('option', { value: wf.id, selected: wf.id === agent.config.workflowId }, wf.name));
    })
    .catch(ctx.showError);
  return h(
    'div',
    {},
    h('div', { class: 'section-title' }, 'Node graph'),
    h('p', { class: 'muted small' }, 'Run each task through a graph instead of a single call — e.g. implement → review → loop until approved. Build graphs under Workflows → Agent graphs.'),
    h('label', { class: 'field' }, h('span', {}, 'Graph'), select),
    h('a', { class: 'btn small ghost', href: '#/workflows' }, 'Open workflow editor'),
  );
});
