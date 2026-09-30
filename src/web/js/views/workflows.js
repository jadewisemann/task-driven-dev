import { confirmDialog, h, mountInto, promptForm, toast } from '../dom.js';
import { logViewer } from '../runs/log-viewer.js';
import { createCanvas } from '../workflows/canvas.js';
import { renderInspector } from '../workflows/inspector.js';

const SELECTED_KEY = 'todo-devs.workflow';

/**
 * n8n-style workflow editor: project workflows (run on demand, JSON input,
 * routing, board automation) and agent graphs (an agent's own multi-step
 * process, run whenever that agent executes a task).
 */
export const workflowsView = {
  id: 'workflows',
  title: 'Workflows',
  icon: '⧉',
  mount(root, ctx) {
    const state = { list: [], types: [], agents: [], templates: [], current: null, dirty: false, outputs: {}, runId: null };
    const sidebar = h('div', { class: 'wf-sidebar' });
    const toolbar = h('div', { class: 'wf-toolbar' });
    const palette = h('div', { class: 'wf-palette' });
    const inspector = h('div', { class: 'wf-inspector' }, h('p', { class: 'muted' }, 'Select a node to configure it.'));
    const runPanel = h('div', { class: 'wf-runpanel' });
    let canvas = null;

    const setDirty = (dirty) => {
      state.dirty = dirty;
      toolbar.querySelector('.save-btn')?.classList.toggle('primary', dirty);
      const label = toolbar.querySelector('.dirty');
      if (label) label.textContent = dirty ? '● unsaved' : '';
    };

    async function load() {
      [state.list, state.types, state.agents, state.templates] = await Promise.all([
        ctx.rpc('workflows.list', ctx.project ? { projectId: ctx.project.id } : {}),
        ctx.rpc('workflows.nodeTypes'),
        ctx.rpc('agents.list'),
        ctx.rpc('workflows.templates'),
      ]);
      renderSidebar();
      const want = state.current?.id || localStorage.getItem(SELECTED_KEY);
      const wf = state.list.find((w) => w.id === want) || state.list[0];
      if (wf) open(wf);
      else mountInto(toolbar, h('span', { class: 'muted' }, 'No workflows yet — create one from a template.'));
    }

    function renderSidebar() {
      const group = (scope, title, hint) =>
        h(
          'div',
          { class: 'wf-group' },
          h('h4', { title: hint }, title),
          state.list
            .filter((w) => w.scope === scope)
            .map((w) =>
              h(
                'button',
                { class: ['wf-item', state.current?.id === w.id && 'active'], onClick: () => switchTo(w) },
                h('span', {}, w.name),
                scope === 'agent' && h('span', { class: 'muted small' }, usedBy(w)),
              ),
            ),
        );
      mountInto(
        sidebar,
        h('button', { class: 'btn primary', style: { width: '100%' }, onClick: () => createWorkflow().catch(ctx.showError) }, '+ New workflow'),
        group('project', 'Project workflows', 'Run on demand with JSON input'),
        group('agent', 'Agent graphs', 'Run as an agent’s own process for each task'),
      );
    }

    const usedBy = (wf) => {
      const names = state.agents.filter((a) => a.config.workflowId === wf.id).map((a) => a.name);
      return names.length ? `used by ${names.join(', ')}` : 'unused';
    };

    async function switchTo(wf) {
      if (state.dirty && !(await confirmDialog('Discard unsaved changes?'))) return;
      open(wf);
    }

    function open(wf) {
      state.current = structuredClone(wf);
      state.outputs = {};
      state.runId = null;
      localStorage.setItem(SELECTED_KEY, wf.id);
      setDirty(false);
      renderSidebar();
      renderToolbar();
      renderPalette();
      mountInto(inspector, h('p', { class: 'muted' }, 'Select a node to configure it.'));
      mountInto(runPanel);
      canvas.setGraph(state.current.graph);
      requestAnimationFrame(() => canvas.fit());
    }

    function renderToolbar() {
      const wf = state.current;
      mountInto(
        toolbar,
        h('input', { class: 'wf-title', value: wf.name, onInput: (e) => ((wf.name = e.target.value), setDirty(true)) }),
        h('span', { class: `badge scope-${wf.scope}` }, wf.scope === 'agent' ? 'agent graph' : 'project workflow'),
        h('span', { class: 'dirty warn-text small' }),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', onClick: () => canvas.fit() }, 'Fit'),
        h('button', { class: 'btn', onClick: () => validate().catch(ctx.showError) }, 'Validate'),
        h('button', { class: 'btn save-btn', onClick: () => save().catch(ctx.showError) }, 'Save'),
        wf.scope === 'project'
          ? h('button', { class: 'btn success', onClick: () => run().catch(ctx.showError) }, '▶ Run')
          : h('span', { class: 'muted small', title: 'Set it on an agent (Agents → Node graph)' }, 'runs when its agent executes a task'),
        h('button', { class: 'icon-btn', title: 'Delete workflow', onClick: () => remove().catch(ctx.showError) }, '🗑'),
      );
    }

    function renderPalette() {
      const cats = [...new Set(state.types.map((t) => t.category))];
      mountInto(
        palette,
        cats.map((cat) =>
          h(
            'div',
            { class: 'pal-group' },
            h('span', { class: 'muted small' }, cat),
            state.types
              .filter((t) => t.category === cat && t.type !== 'trigger')
              .map((t) => h('button', { class: 'pal-item', title: t.description, onClick: () => canvas.addNode(t.type) }, h('span', { class: 'wf-icon' }, t.icon), t.label)),
          ),
        ),
      );
    }

    function onSelect(sel) {
      if (!sel?.node) {
        mountInto(inspector, sel?.edge ? h('div', {}, h('p', {}, `Edge ${sel.edge.from}.${sel.edge.fromPort} → ${sel.edge.to}`), h('button', { class: 'btn danger ghost small', onClick: () => canvas.removeSelection() }, 'Delete edge')) : h('p', { class: 'muted' }, 'Select a node to configure it.'));
        return;
      }
      const node = sel.node;
      mountInto(
        inspector,
        renderInspector(node, {
          types: state.types,
          agents: state.agents,
          lastOutput: state.outputs[node.id],
          onChange: (n, key) => {
            setDirty(true);
            // Structural changes re-render the node (ports, name); text edits don't need to.
            if (['name', 'rules', 'mode', 'agentId', 'command'].includes(key)) canvas.refreshNode(n.id);
          },
          onRemove: () => canvas.removeSelection(),
        }),
      );
    }

    async function save() {
      const wf = state.current;
      const saved = await ctx.rpc('workflows.update', { id: wf.id, name: wf.name, graph: canvas.getGraph() });
      state.current = { ...saved, graph: canvas.getGraph() };
      setDirty(false);
      const { problems } = await ctx.rpc('workflows.validate', { id: wf.id });
      toast(problems.length ? `Saved with ${problems.length} problem(s): ${problems[0]}` : 'Workflow saved', problems.length ? 'error' : 'success');
    }

    async function validate() {
      const { problems } = await ctx.rpc('workflows.validate', { graph: canvas.getGraph() });
      toast(problems.length ? problems.join(' · ') : 'Graph is valid', problems.length ? 'error' : 'success');
    }

    async function run() {
      if (state.dirty) await save();
      const trigger = canvas.getGraph().nodes.find((n) => n.type === 'trigger');
      const values = await promptForm('Run workflow', [{ name: 'input', label: 'Input JSON (available as vars / Start output)', type: 'textarea', rows: 8, value: JSON.stringify(trigger?.config?.sample ?? {}, null, 2) }], { submitLabel: 'Run' });
      if (!values) return;
      let input;
      try {
        input = JSON.parse(values.input || '{}');
      } catch {
        return toast('Input must be valid JSON', 'error');
      }
      canvas.clearStatus();
      state.outputs = {};
      const { runId } = await ctx.rpc('workflows.run', { id: state.current.id, input, projectId: ctx.project?.id });
      state.runId = runId;
      mountInto(runPanel, h('div', { class: 'wf-run-head' }, h('strong', {}, 'Run log'), h('span', { class: 'muted small run-status' }, 'running…')), logViewer(ctx, runId, { height: 180 }));
    }

    async function createWorkflow() {
      const values = await promptForm('New workflow', [
        { name: 'name', label: 'Name', placeholder: 'e.g. Bug triage' },
        {
          name: 'scope',
          label: 'Kind',
          type: 'select',
          value: 'project',
          options: [
            { value: 'project', label: 'Project workflow — run with JSON input, automate the board' },
            { value: 'agent', label: 'Agent graph — an agent’s own multi-step process per task' },
          ],
        },
        { name: 'template', label: 'Start from', type: 'select', value: '', options: [{ value: '', label: 'Blank' }, ...state.templates.map((t) => ({ value: t.key, label: `${t.name} (${t.scope})` }))] },
      ]);
      if (!values?.name) return;
      const tpl = state.templates.find((t) => t.key === values.template);
      const wf = await ctx.rpc('workflows.create', { name: values.name, scope: tpl ? tpl.scope : values.scope, projectId: ctx.project?.id, template: values.template || undefined, description: tpl?.description });
      state.list.push(wf);
      open(wf);
    }

    async function remove() {
      if (!(await confirmDialog(`Delete workflow "${state.current.name}"?`))) return;
      await ctx.rpc('workflows.delete', { id: state.current.id });
      state.current = null;
      setDirty(false);
      localStorage.removeItem(SELECTED_KEY);
      await load();
    }

    const stage = h('div', { class: 'wf-stage' }, h('div', { class: 'wf-canvas muted' }, 'Loading…'), inspector);
    mountInto(root, h('div', { class: 'wf-layout' }, sidebar, h('div', { class: 'wf-main' }, toolbar, palette, stage, runPanel)));

    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && state.current) {
        e.preventDefault();
        save().catch(ctx.showError);
      }
    };
    window.addEventListener('keydown', onKey);
    const off = ctx.onEvent((e) => {
      const p = e.payload || {};
      if (e.type === 'workflow.node' && canvas && state.current && p.workflowId === state.current.id) {
        canvas.setStatus(p.nodeId, { status: p.status, visit: p.visit });
        if (p.output !== undefined) state.outputs[p.nodeId] = p.output;
      } else if (e.type === 'workflow.run.finished' && p.runId === state.runId) {
        const el = runPanel.querySelector('.run-status');
        if (el) el.textContent = p.status === 'succeeded' ? `✓ succeeded${p.result ? ` — ${JSON.stringify(p.result).slice(0, 160)}` : ''}` : `✗ ${p.status}: ${p.error || ''}`;
      }
    });

    // The canvas needs the node type catalogue before it can render anything.
    ctx
      .rpc('workflows.nodeTypes')
      .then((types) => {
        canvas = createCanvas({ types, onChange: () => setDirty(true), onSelect });
        stage.firstChild.replaceWith(canvas.el);
        return load();
      })
      .catch(ctx.showError);

    return () => {
      off();
      window.removeEventListener('keydown', onKey);
    };
  },
};
