import { h } from '../dom.js';

const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains', 'in', 'exists', 'notExists', 'truthy', 'falsy', 'regex'];
const UNARY = new Set(['exists', 'notExists', 'truthy', 'falsy']);

/** Parses a value typed in a condition box: numbers/booleans/JSON stay typed, the rest is text. */
function parseLoose(text) {
  const t = text.trim();
  if (t === '') return '';
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

function jsonField(value, onValue, rows = 5) {
  const ta = h('textarea', { class: 'code', rows }, JSON.stringify(value ?? null, null, 2));
  ta.addEventListener('input', () => {
    try {
      onValue(JSON.parse(ta.value));
      ta.classList.remove('invalid');
    } catch {
      ta.classList.add('invalid');
    }
  });
  return ta;
}

function agentSelect(value, agents, { allowSelf, allowNone }, onValue) {
  return h(
    'select',
    { onChange: (e) => onValue(e.target.value) },
    allowNone && h('option', { value: '', selected: !value }, '— none —'),
    allowSelf && h('option', { value: 'self', selected: value === 'self' }, 'self (agent that owns this graph)'),
    agents.map((a) => h('option', { value: a.id, selected: a.id === value }, `${a.name} · ${a.role} · T${a.tier}`)),
  );
}

/** Editor for router rules: [{port, match, conditions: [{path, op, value}]}]. */
function rulesEditor(rules, onValue) {
  const box = h('div', { class: 'rules' });
  const commit = () => onValue(structuredClone(rules));
  function render() {
    box.replaceChildren(
      ...rules.map((rule, ri) =>
        h(
          'div',
          { class: 'rule' },
          h(
            'div',
            { class: 'rule-head' },
            h('span', { class: 'muted small' }, 'route'),
            h('input', { class: 'rule-port', value: rule.port || '', placeholder: 'port name', onChange: (e) => ((rule.port = e.target.value.trim().replace(/\s+/g, '_')), commit(), render()) }),
            h('select', { onChange: (e) => ((rule.match = e.target.value), commit()) }, h('option', { value: 'all', selected: rule.match !== 'any' }, 'all of'), h('option', { value: 'any', selected: rule.match === 'any' }, 'any of')),
            h('button', { class: 'icon-btn', title: 'Remove route', onClick: () => (rules.splice(ri, 1), commit(), render()) }, '✕'),
          ),
          (rule.conditions ||= []).map((c, ci) =>
            h(
              'div',
              { class: 'cond' },
              h('input', { class: 'code', value: c.path || '', placeholder: 'input.json.status', onChange: (e) => ((c.path = e.target.value.trim()), commit()) }),
              h('select', { onChange: (e) => ((c.op = e.target.value), commit(), render()) }, OPS.map((op) => h('option', { value: op, selected: (c.op || 'eq') === op }, op))),
              UNARY.has(c.op) ? h('span') : h('input', { class: 'code', value: c.value === undefined ? '' : typeof c.value === 'string' ? c.value : JSON.stringify(c.value), placeholder: 'value', onChange: (e) => ((c.value = parseLoose(e.target.value)), commit()) }),
              h('button', { class: 'icon-btn', title: 'Remove condition', onClick: () => (rule.conditions.splice(ci, 1), commit(), render()) }, '−'),
            ),
          ),
          h('button', { class: 'btn small ghost', onClick: () => (rule.conditions.push({ path: 'input.json.status', op: 'eq', value: '' }), commit(), render()) }, '+ condition'),
          rule.conditions.length === 0 && h('span', { class: 'muted small' }, ' (no conditions = always matches)'),
        ),
      ),
      h('button', { class: 'btn small', onClick: () => (rules.push({ port: `route${rules.length + 1}`, match: 'all', conditions: [] }), commit(), render()) }, '+ route'),
      h('p', { class: 'muted small' }, 'Paths see: input (incoming JSON), vars (run input), nodes.<id> (earlier outputs), visits.<id>. Unmatched input goes to "else".'),
    );
  }
  render();
  return box;
}

/**
 * Right-hand panel for the selected node: name, config fields from the node
 * type's schema, loop limit and the node's last output.
 */
export function renderInspector(node, { types, agents, lastOutput, onChange, onRemove }) {
  const info = types.find((t) => t.type === node.type);
  node.config ||= {};
  const set = (key, value) => {
    node.config[key] = value;
    onChange(node, key);
  };
  const fields = (info?.fields || []).map((f) => {
    const value = node.config[f.key] ?? info.defaults?.[f.key];
    let input;
    switch (f.type) {
      case 'textarea':
        input = h('textarea', { rows: f.rows || 3, onInput: (e) => set(f.key, e.target.value) }, value ?? '');
        break;
      case 'number':
        input = h('input', { type: 'number', value: value ?? '', onInput: (e) => e.target.value !== '' && set(f.key, Number(e.target.value)) });
        break;
      case 'checkbox':
        return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(value), onChange: (e) => set(f.key, e.target.checked) }), f.label);
      case 'select':
        input = h('select', { onChange: (e) => set(f.key, e.target.value) }, f.options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
        break;
      case 'json':
        input = jsonField(value, (v) => set(f.key, v), f.rows || 5);
        break;
      case 'agent':
        input = agentSelect(value, agents, { allowSelf: f.allowSelf, allowNone: !f.allowSelf }, (v) => set(f.key, v));
        break;
      case 'rules':
        node.config.rules = structuredClone(value || []);
        input = rulesEditor(node.config.rules, (v) => set('rules', v));
        break;
      default:
        input = h('input', { class: f.key === 'command' ? 'code' : '', value: value ?? '', onInput: (e) => set(f.key, e.target.value) });
    }
    return h('label', { class: 'field' }, h('span', {}, f.label), input);
  });

  return h(
    'div',
    { class: 'wf-inspector-body' },
    h('div', { class: 'insp-head' }, h('span', { class: 'wf-icon big' }, info?.icon || '?'), h('div', {}, h('strong', {}, info?.label || node.type), h('div', { class: 'muted small' }, `id: ${node.id}`))),
    h('p', { class: 'muted small' }, info?.description || ''),
    h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { value: node.name || '', onInput: (e) => ((node.name = e.target.value), onChange(node, 'name')) })),
    fields,
    node.type !== 'trigger' &&
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Max runs per execution (loop guard)'),
        h('input', { type: 'number', min: 1, value: node.config.maxVisits ?? 20, onInput: (e) => e.target.value && set('maxVisits', Number(e.target.value)) }),
      ),
    lastOutput !== undefined && h('details', { open: true }, h('summary', {}, 'Last run output'), h('pre', { class: 'preview-block' }, typeof lastOutput === 'string' ? lastOutput : JSON.stringify(lastOutput, null, 2))),
    node.type !== 'trigger' && h('button', { class: 'btn danger ghost small', onClick: onRemove }, 'Delete node'),
  );
}
