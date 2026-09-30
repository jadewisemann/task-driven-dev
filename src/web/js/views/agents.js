import { avatar, tierBadge } from '../agents/avatar.js';
import { confirmDialog, debounce, h, mountInto, openDrawer, toast } from '../dom.js';

const ROLES = ['orchestrator', 'engineer', 'frontend', 'backend', 'reviewer', 'qa', 'designer', 'writer', 'devops', 'researcher', 'generalist'];
const EFFORT_HINT = { low: 'fast & cheap', medium: 'balanced', high: 'thorough', max: 'exhaustive' };
const COLORS = ['#7c5cff', '#4da3ff', '#4dd4ac', '#ffb547', '#ff5c7a', '#b77cff', '#ff8a4d', '#8bd450'];

/**
 * Extra editor sections contributed by other features (e.g. the agent's node
 * graph from the workflow feature): fn(agent, form, ctx) -> Node, where form.config
 * is the mutable config patch that will be saved.
 */
export const agentEditorSections = [];

export const agentsView = {
  id: 'agents',
  title: 'Agents',
  icon: '◉',
  mount(root, ctx) {
    const state = { agents: [], harnesses: [], options: null };

    async function load() {
      [state.agents, state.harnesses, state.options] = await Promise.all([ctx.rpc('agents.list'), ctx.rpc('harnesses.list'), ctx.rpc('harnesses.options')]);
      render();
    }
    const reload = debounce(() => load().catch(ctx.showError));

    function agentCard(a) {
      const harness = state.harnesses.find((x) => x.id === a.harness);
      const g = a.config.contextGraph;
      return h(
        'article',
        { class: 'agent-card', style: { borderTopColor: a.color }, onClick: () => openEditor(a) },
        h('div', { class: 'agent-head' }, avatar(a, { size: 40 }), h('div', { class: 'agent-title' }, h('h3', {}, a.name), h('span', { class: 'muted' }, a.role)), tierBadge(a.tier)),
        h('p', { class: 'agent-persona' }, a.persona || h('span', { class: 'muted' }, 'No persona yet.')),
        h(
          'div',
          { class: 'agent-specs' },
          spec('Harness', harness ? harness.name : a.harness, harness && !harness.installed ? 'not installed' : null),
          spec('Model', a.model || 'default'),
          spec('Effort', `${a.effort} · ${EFFORT_HINT[a.effort]}`),
          spec('Context', `${g.upstreamDepth} hop${g.upstreamDepth === 1 ? '' : 's'} upstream${g.includeSiblings ? ' + siblings' : ''}`),
          spec('Graph', a.config.workflowId ? 'custom node graph' : 'single step'),
        ),
      );
    }

    const spec = (label, value, warn) => h('div', { class: 'spec' }, h('span', { class: 'muted' }, label), h('span', {}, value, warn && h('span', { class: 'warn-text' }, ` (${warn})`)));

    function render() {
      mountInto(
        root,
        h(
          'div',
          { class: 'toolbar' },
          h('div', { class: 'toolbar-title' }, h('h2', {}, 'Agents'), h('span', { class: 'muted' }, 'Define teammates once, then assign them to tasks like people in a PM tool.')),
          h('div', { class: 'toolbar-actions' }, h('button', { class: 'btn primary', onClick: () => openEditor(null) }, '+ New agent')),
        ),
        h('div', { class: 'grid-cards' }, state.agents.map(agentCard)),
      );
    }

    function openEditor(agent) {
      if (!state.options) return toast('Still loading…');
      const isNew = !agent;
      const a = agent || {
        name: '',
        role: 'engineer',
        persona: '',
        harness: 'claude-code',
        model: 'sonnet',
        effort: 'medium',
        tier: 2,
        color: COLORS[state.agents.length % COLORS.length],
        config: structuredClone(state.options.defaults),
      };
      const form = { config: {} };
      const setConfig = (key, value) => (form.config[key] = value);
      const setGraph = (key, value) => (form.config.contextGraph = { ...(form.config.contextGraph || {}), [key]: value });

      const f = {
        name: h('input', { value: a.name, placeholder: 'e.g. Forge' }),
        role: h('select', {}, [...new Set([...ROLES, a.role])].map((r) => h('option', { value: r, selected: r === a.role }, r))),
        persona: h('textarea', { rows: 5, placeholder: 'Personality, expertise, rules of engagement. Becomes the system prompt.' }, a.persona),
        harness: h('select', {}, state.harnesses.map((x) => h('option', { value: x.id, selected: x.id === a.harness }, `${x.name}${x.installed ? '' : ' — not installed'}`))),
        model: h('input', { value: a.model, list: 'model-suggestions', placeholder: 'model id' }),
        tier: h('select', {}, state.options.tiers.map((t) => h('option', { value: t, selected: t === a.tier }, `T${t} — ${['', 'small / fast', 'standard', 'frontier'][t]}`))),
        command: h('input', { class: 'code', value: a.config.command || '', placeholder: 'mycli --model {model} {prompt}' }),
      };
      const modelList = h('datalist', { id: 'model-suggestions' });
      const harnessInfo = h('p', { class: 'muted small' });
      const allowTaskCommand = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: a.config.allowTaskCommand, onChange: (e) => setConfig('allowTaskCommand', e.target.checked) }), 'Allow task input {"command"} to override (runs on this host)');
      const commandField = h('div', {}, h('label', { class: 'field' }, h('span', {}, 'Command template'), f.command), allowTaskCommand);
      const syncHarness = (changed) => {
        const def = state.harnesses.find((x) => x.id === f.harness.value);
        modelList.replaceChildren(...(def?.models || []).map((m) => h('option', { value: m })));
        harnessInfo.textContent = `${def?.description || ''}${def?.nativeEffort ? ' Effort maps to a native reasoning setting.' : ' Effort is conveyed through the prompt.'}`;
        commandField.style.display = ['custom', 'shell'].includes(f.harness.value) ? '' : 'none';
        allowTaskCommand.style.display = f.harness.value === 'shell' ? '' : 'none';
        // A model id from another harness (e.g. "sonnet" on codex) would be passed through verbatim.
        if (changed && def && !def.models.includes(f.model.value)) {
          f.model.value = def.models[0] || '';
          syncTier();
        }
      };
      let tierTouched = !isNew;
      f.tier.addEventListener('change', () => (tierTouched = true));
      const syncTier = debounce(async () => {
        if (tierTouched) return;
        f.tier.value = String(await ctx.rpc('harnesses.inferTier', { model: f.model.value }));
      }, 250);
      f.model.addEventListener('input', syncTier);
      f.harness.addEventListener('change', () => syncHarness(true));
      f.command.addEventListener('input', () => setConfig('command', f.command.value));
      syncHarness(false);

      const autonomy = h(
        'select',
        { onChange: (e) => setConfig('autonomy', e.target.value) },
        state.options.autonomy.map((x) => h('option', { value: x, selected: x === a.config.autonomy }, { safe: 'safe — edit files only', auto: 'auto — edit files + run commands', full: 'full — no guard rails' }[x])),
      );
      const envInput = h(
        'textarea',
        {
          rows: 2,
          class: 'code',
          placeholder: 'KEY=value (one per line). Values are write-only.',
          onInput: (e) => {
            const env = {};
            for (const line of e.target.value.split('\n')) {
              const i = line.indexOf('=');
              if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1);
            }
            setConfig('env', env);
          },
        },
        Object.entries(a.config.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
      );

      let effort = a.effort;
      const effortButtons = state.options.efforts.map((e) =>
        h(
          'button',
          {
            type: 'button',
            class: ['seg', e === effort && 'active'],
            title: EFFORT_HINT[e],
            onClick: (ev) => {
              effort = e;
              for (const b of ev.target.parentElement.children) b.classList.toggle('active', b === ev.target);
            },
          },
          e,
        ),
      );
      let color = a.color;
      const swatches = COLORS.map((c) =>
        h('button', {
          type: 'button',
          class: ['swatch', c === color && 'active'],
          style: { background: c },
          onClick: (ev) => {
            color = c;
            for (const b of ev.target.parentElement.children) b.classList.toggle('active', b === ev.target);
          },
        }),
      );

      const g = a.config.contextGraph;
      const depthLabel = h('span', { class: 'muted' }, String(g.upstreamDepth));
      const depth = h('input', { type: 'range', min: 0, max: 20, value: g.upstreamDepth });
      depth.addEventListener('input', () => {
        depthLabel.textContent = depth.value;
        setGraph('upstreamDepth', Number(depth.value));
      });
      const toggle = (key, label) =>
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: g[key], onChange: (e) => setGraph(key, e.target.checked) }), label);
      const numberInput = (value, onValue, attrs = {}) => h('input', { type: 'number', value, ...attrs, onInput: (e) => e.target.value !== '' && onValue(Number(e.target.value)) });

      const previewBox = h('div', { class: 'prompt-preview' });
      async function showPreview() {
        const tasks = ctx.project ? await ctx.rpc('tasks.list', { projectId: ctx.project.id }) : [];
        if (!tasks.length) return previewBox.replaceChildren(h('p', { class: 'muted' }, 'Create a task on the board first.'));
        const pick = h('select', {}, tasks.map((t) => h('option', { value: t.id }, t.title)));
        const out = h('div');
        const run = async () => {
          const p = await ctx.rpc('agents.preview', { agentId: agent.id, taskId: pick.value });
          out.replaceChildren(
            h('h4', {}, 'System prompt'),
            h('pre', { class: 'preview-block' }, p.system),
            h('h4', {}, 'Task prompt'),
            h('pre', { class: 'preview-block' }, p.prompt),
            h('h4', {}, 'Invocation'),
            h('pre', { class: 'preview-block' }, p.invocation.kind === 'process' ? `${p.invocation.display}\nenv: ${JSON.stringify(p.invocation.env)}` : p.invocation.kind === 'builtin' ? 'built-in simulated harness' : `error: ${p.invocation.error}`),
          );
        };
        pick.addEventListener('change', () => run().catch(ctx.showError));
        previewBox.replaceChildren(h('label', { class: 'field' }, h('span', {}, 'Preview against task (saved settings)'), pick), out);
        await run();
      }

      /** New agents send everything; existing ones send only changed fields (no clobbering concurrent edits). */
      async function save() {
        const next = {
          name: f.name.value.trim(),
          role: f.role.value,
          persona: f.persona.value,
          harness: f.harness.value,
          model: f.model.value.trim(),
          effort,
          tier: Number(f.tier.value),
          color,
        };
        if (!next.name) return toast('Name is required', 'error');
        const body = isNew ? next : Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== a[k]));
        if (Object.keys(form.config).length) body.config = form.config;
        if (isNew) await ctx.rpc('agents.create', body);
        else if (Object.keys(body).length) await ctx.rpc('agents.update', { id: agent.id, ...body });
        toast(`Agent ${body.name} saved`, 'success');
        drawer.close();
      }

      async function remove() {
        if (!(await confirmDialog(`Delete agent "${agent.name}"? Its tasks become unassigned.`))) return;
        await ctx.rpc('agents.delete', { id: agent.id });
        drawer.close();
      }

      const content = h(
        'div',
        { class: 'agent-editor' },
        modelList,
        h('div', { class: 'section-title' }, 'Identity'),
        h('div', { class: 'field-row' }, h('label', { class: 'field' }, h('span', {}, 'Name'), f.name), h('label', { class: 'field' }, h('span', {}, 'Role'), f.role)),
        h('div', { class: 'field' }, h('span', {}, 'Colour'), h('div', { class: 'swatches' }, swatches)),
        h('label', { class: 'field' }, h('span', {}, 'Persona (system prompt)'), f.persona),

        h('div', { class: 'section-title' }, 'Harness & model'),
        h('label', { class: 'field' }, h('span', {}, 'Harness'), f.harness, harnessInfo),
        commandField,
        h('div', { class: 'field-row' }, h('label', { class: 'field' }, h('span', {}, 'Model'), f.model), h('label', { class: 'field' }, h('span', {}, 'Tier (used by the orchestrator)'), f.tier)),
        h('div', { class: 'field' }, h('span', {}, 'Effort'), h('div', { class: 'segmented' }, effortButtons)),

        h('div', { class: 'section-title' }, 'Context graph'),
        h('p', { class: 'muted small' }, 'How much of the dependency graph the agent sees for each task.'),
        h('label', { class: 'field' }, h('span', {}, 'Upstream depth (predecessor hops) '), depthLabel, depth),
        toggle('includeUpstreamOutputs', 'Include predecessor outputs'),
        toggle('includeDownstream', 'Tell the agent which tasks consume its result'),
        toggle('includeSiblings', 'Include parallel sibling tasks'),
        toggle('includeProjectBrief', 'Include project brief'),
        h('label', { class: 'field' }, h('span', {}, 'Max chars per predecessor output'), numberInput(g.maxUpstreamChars, (v) => setGraph('maxUpstreamChars', v), { min: 100, step: 500 })),

        h('div', { class: 'section-title' }, 'Execution'),
        h(
          'div',
          { class: 'field-row' },
          h('label', { class: 'field' }, h('span', {}, 'Retries'), numberInput(a.config.retries, (v) => setConfig('retries', v), { min: 0, max: 10 })),
          h('label', { class: 'field' }, h('span', {}, 'Timeout (sec)'), numberInput(a.config.timeoutSec, (v) => setConfig('timeoutSec', v), { min: 5 })),
        ),
        h('label', { class: 'field' }, h('span', {}, 'Autonomy (mapped onto each harness’s permission flags)'), autonomy),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: a.config.useWorktree, onChange: (e) => setConfig('useWorktree', e.target.checked) }), 'Work in an isolated git worktree per task'),
        h('label', { class: 'field' }, h('span', {}, 'Environment variables'), envInput),
        h(
          'label',
          { class: 'field' },
          h('span', {}, 'Extra CLI args (one per line)'),
          h('textarea', { rows: 2, class: 'code', onInput: (e) => setConfig('extraArgs', e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)) }, (a.config.extraArgs || []).join('\n')),
        ),
        agentEditorSections.map((section) => section(a, form, ctx)),

        !isNew && h('div', { class: 'section-title' }, 'Prompt preview'),
        !isNew && h('div', {}, h('button', { type: 'button', class: 'btn small', onClick: () => showPreview().catch(ctx.showError) }, 'Show what this agent sees'), previewBox),

        h('div', { class: 'drawer-actions' }, isNew ? h('span') : h('button', { class: 'btn danger ghost', onClick: () => remove().catch(ctx.showError) }, 'Delete'), h('button', { class: 'btn primary', onClick: () => save().catch(ctx.showError) }, isNew ? 'Create agent' : 'Save')),
      );
      const drawer = openDrawer(isNew ? 'New agent' : `Agent · ${a.name}`, content, { width: 560 });
    }

    const off = ctx.onEvent((e) => (e.type.startsWith('agent.') || e.type === 'sync.reconnected') && reload());
    load().catch(ctx.showError);
    return off;
  },
};
