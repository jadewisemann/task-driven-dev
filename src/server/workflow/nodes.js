import { runProcess } from '../runtime/process.js';
import { evaluateRule, getPath, renderDeep, renderTemplate } from './expr.js';

/** Output ports of a node, using the type defaults for anything not configured. */
export function portsOf(node) {
  const type = NODE_TYPES[node.type];
  return type ? type.outputs({ ...type.defaults, ...(node.config || {}) }) : [];
}

/**
 * Turns a shell template into a safe invocation: every {{path}} (optionally
 * wrapped in quotes) becomes a quoted positional parameter "$N" whose value is
 * passed as a separate argv entry, so data can never be parsed as shell code.
 */
export function shellInvocation(template, scope) {
  const values = [];
  const script = String(template).replace(/(["']?)\{\{\s*([^}]+?)\s*\}\}\1/g, (_, _q, path) => {
    const v = getPath(scope, path);
    values.push(v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    return `"\${${values.length}}"`;
  });
  return { args: ['-c', script, 'todo-devs-shell', ...values], script };
}

export const MAX_TASK_DEPTH = 3;
export const MAX_TASKS_PER_RUN = 25;

/**
 * Node type registry. Each type declares:
 *   label, icon, category, description
 *   input: whether it has an input port ("in")
 *   outputs(config) -> port names
 *   fields: config form schema for the editor
 *   defaults: initial config
 *   execute(ctx) -> { [port]: payload }   (ports not returned are "skipped")
 *
 * ctx = { node, config, input, scope, env, log, signal }
 *   scope = { input, vars, nodes, visits } is what {{templates}} and router paths see:
 *     input  — payload that arrived at this node
 *     vars   — the workflow's run input (for agent graphs: {task, prompt, system, cwd, attempt})
 *     nodes  — last output of every executed node, by node id
 *     visits — how many times each node has run (useful to cap loops)
 *   env = { runAgent(agentRef, {prompt, system}), createTask(spec), cwd, projectId }
 */

const AGENT_OUTPUT_HELP = 'Output: { text, json, status, code } — json is the agent’s trailing ```json result.';

export const NODE_TYPES = {
  trigger: {
    label: 'Start',
    icon: '▶',
    category: 'Flow',
    description: 'Entry point. Emits the run input (JSON). In agent graphs the input is {task, prompt, system, cwd, attempt}.',
    input: false,
    outputs: () => ['out'],
    fields: [{ key: 'sample', label: 'Sample input for manual runs (JSON)', type: 'json' }],
    defaults: { sample: {} },
    execute: ({ scope }) => ({ out: scope.vars }),
  },

  json: {
    label: 'JSON data',
    icon: '{}',
    category: 'Data',
    description: 'Emits a JSON value. Strings may contain {{templates}}; with "merge" the incoming object is merged in.',
    input: true,
    outputs: () => ['out'],
    fields: [
      { key: 'data', label: 'JSON', type: 'json' },
      { key: 'merge', label: 'Merge into incoming object', type: 'checkbox' },
    ],
    defaults: { data: { key: 'value' }, merge: false },
    execute: ({ config, input, scope }) => {
      const data = renderDeep(config.data, scope);
      const merged = config.merge && input && typeof input === 'object' && data && typeof data === 'object' ? { ...input, ...data } : data;
      return { out: merged };
    },
  },

  transform: {
    label: 'Transform',
    icon: 'ƒ',
    category: 'Data',
    description: 'Builds a new JSON object from a template, e.g. {"title": "{{input.json.summary}}", "count": "{{visits.review}}"}.',
    input: true,
    outputs: () => ['out'],
    fields: [{ key: 'template', label: 'Output template (JSON with {{paths}})', type: 'json' }],
    defaults: { template: { value: '{{input}}' } },
    execute: ({ config, scope }) => ({ out: renderDeep(config.template, scope) }),
  },

  agent: {
    label: 'Agent',
    icon: '◉',
    category: 'AI',
    description: `Runs an agent with a prompt template. Agent "self" = the agent that owns this graph. ${AGENT_OUTPUT_HELP} Failures go to the "error" port.`,
    input: true,
    outputs: () => ['out', 'error'],
    fields: [
      { key: 'agentId', label: 'Agent', type: 'agent', allowSelf: true },
      { key: 'prompt', label: 'Prompt template', type: 'textarea', rows: 6 },
      { key: 'system', label: 'System prompt override (optional)', type: 'textarea', rows: 2 },
    ],
    defaults: { agentId: 'self', prompt: '{{vars.prompt}}', system: '' },
    async execute({ config, scope, env }) {
      const prompt = String(renderTemplate(config.prompt || '{{input}}', scope) ?? '');
      const system = config.system ? String(renderTemplate(config.system, scope) ?? '') : undefined;
      const res = await env.runAgent(config.agentId || 'self', { prompt, system });
      if (res.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
      const out = { text: res.output, json: res.result, status: res.result?.status || (res.code === 0 ? 'done' : 'failed'), code: res.code, truncated: res.truncated, timedOut: res.timedOut };
      if (res.code === 0 && res.result?.status !== 'failed') return { out };
      const error = res.timedOut ? 'agent timed out' : (res.stderr || '').slice(-2000) || res.result?.summary || `agent exited with code ${res.code}`;
      return { error: { ...out, error } };
    },
  },

  router: {
    label: 'Router',
    icon: '⑂',
    category: 'Flow',
    description:
      'Routes the incoming JSON. Rules mode: first matching rule wins (or all matches with "fan out"); each rule is a list of {path, op, value} conditions on e.g. input.json.status. Agent mode: an agent reads the input and picks a route.',
    input: true,
    outputs: (config) => [...new Set([...(config.rules || []).map((r) => r.port).filter(Boolean), 'else', ...(config.mode === 'agent' ? ['error'] : [])])],
    fields: [
      {
        key: 'mode',
        label: 'Decision',
        type: 'select',
        options: [
          { value: 'rules', label: 'JSON rules' },
          { value: 'agent', label: 'Agent decides' },
        ],
      },
      { key: 'rules', label: 'Routes', type: 'rules' },
      { key: 'fanOut', label: 'Fan out to every matching route', type: 'checkbox' },
      { key: 'agentId', label: 'Deciding agent (agent mode)', type: 'agent', allowSelf: true },
      { key: 'question', label: 'Question for the agent (agent mode)', type: 'textarea', rows: 3 },
    ],
    defaults: {
      mode: 'rules',
      rules: [{ port: 'approved', match: 'all', conditions: [{ path: 'input.json.status', op: 'eq', value: 'approved' }] }],
      fanOut: false,
      agentId: 'self',
      question: 'Which route fits this input best?',
    },
    async execute({ config, input, scope, env, log }) {
      const ports = NODE_TYPES.router.outputs(config).filter((p) => p !== 'else' && p !== 'error');
      if (config.mode === 'agent') {
        const prompt = `${renderTemplate(config.question || 'Pick a route.', scope)}\n\nInput:\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n\nRoutes: ${[...ports, 'else'].join(', ')}\nAnswer with a fenced \`\`\`json block: {"route": "<one of the routes>", "reason": "..."}`;
        const res = await env.runAgent(config.agentId || 'self', { prompt });
        if (res.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
        // A crashed or evasive decider must not silently fall through to "else".
        if (res.code !== 0) throw new Error(`deciding agent failed (code ${res.code})`);
        const route = res.result?.route;
        if (typeof route !== 'string') throw new Error('deciding agent did not return {"route": ...}');
        log(`agent chose route: ${route ?? '(none)'}${res.result?.reason ? ` — ${res.result.reason}` : ''}`);
        return { [ports.includes(route) ? route : 'else']: input };
      }
      const matched = (config.rules || []).filter((r) => r.port && evaluateRule(r, scope)).map((r) => r.port);
      if (matched.length === 0) return { else: input };
      return Object.fromEntries((config.fanOut ? [...new Set(matched)] : [matched[0]]).map((p) => [p, input]));
    },
  },

  merge: {
    label: 'Merge',
    icon: '⊕',
    category: 'Flow',
    description: 'Waits for every incoming branch that is still active, then emits { items: [...], byNode: {id: payload} }.',
    input: true,
    outputs: () => ['out'],
    fields: [],
    defaults: {},
    execute: ({ input }) => ({ out: input }),
  },

  shell: {
    label: 'Shell',
    icon: '$',
    category: 'Tools',
    description: 'Runs a command with sh -c in the workspace. {{paths}} are passed as quoted arguments (never parsed as shell code). Output { stdout, stderr, code }; non-zero exit goes to "error".',
    input: true,
    outputs: () => ['out', 'error'],
    fields: [
      { key: 'command', label: 'Command', type: 'text' },
      { key: 'timeoutSec', label: 'Timeout (sec)', type: 'number' },
    ],
    defaults: { command: 'printf "%s\\n" {{input.text}}', timeoutSec: 120 },
    async execute({ config, scope, env, signal, log }) {
      if (!String(config.command || '').trim()) throw new Error('shell node needs a command');
      const { args, script } = shellInvocation(config.command, scope);
      log(`$ ${script}`);
      const res = await runProcess({ command: 'sh', args, cwd: env.cwd, timeoutMs: (config.timeoutSec || 120) * 1000, signal, onData: (stream, t) => log(t, stream) });
      const out = { stdout: res.stdout, stderr: res.stderr, code: res.code };
      return res.code === 0 ? { out } : { error: out };
    },
  },

  'task.create': {
    label: 'Create task',
    icon: '＋',
    category: 'Board',
    description: 'Creates a card on the project board (e.g. from a triage router). Output: the created task.',
    input: true,
    outputs: () => ['out'],
    fields: [
      { key: 'title', label: 'Title template', type: 'text' },
      { key: 'description', label: 'Description template', type: 'textarea', rows: 3 },
      { key: 'assigneeId', label: 'Assignee', type: 'agent' },
      {
        key: 'status',
        label: 'Column',
        type: 'select',
        options: ['backlog', 'todo'].map((s) => ({ value: s, label: s })),
      },
      { key: 'priority', label: 'Priority (0-3)', type: 'number' },
    ],
    defaults: { title: '{{input.title}}', description: '{{input.description}}', assigneeId: '', status: 'todo', priority: 1 },
    async execute({ config, scope, env }) {
      const title = String(renderTemplate(config.title, scope) ?? '').trim() || 'Untitled task';
      const status = config.status || 'todo';
      if (!['backlog', 'todo'].includes(status)) throw new Error(`Create task: column must be backlog or todo, got "${status}"`);
      const task = await env.createTask({
        title,
        description: String(renderTemplate(config.description || '', scope) ?? ''),
        assigneeId: config.assigneeId || null,
        status,
        priority: Math.min(3, Math.max(0, Number(config.priority ?? 1) | 0)),
      });
      return { out: { id: task.id, title: task.title, status: task.status } };
    },
  },

  output: {
    label: 'Output',
    icon: '■',
    category: 'Flow',
    description: 'Sets the workflow result. For agent graphs, "text" becomes the task output and "json" its result (status: done | needs_review | failed).',
    input: true,
    outputs: () => [],
    fields: [
      { key: 'text', label: 'Text template', type: 'textarea', rows: 3 },
      { key: 'json', label: 'JSON result template', type: 'json' },
    ],
    defaults: { text: '{{input.text}}', json: '{{input.json}}' },
    execute: ({ config, scope }) => ({ __result: { text: renderTemplate(config.text ?? '', scope), json: renderDeep(config.json, scope) } }),
  },
};

export function nodeTypeList() {
  return Object.entries(NODE_TYPES).map(([type, t]) => ({
    type,
    label: t.label,
    icon: t.icon,
    category: t.category,
    description: t.description,
    input: t.input,
    fields: t.fields,
    defaults: t.defaults,
    staticOutputs: type === 'router' ? null : t.outputs(t.defaults),
  }));
}
