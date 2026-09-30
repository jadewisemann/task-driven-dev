import { NODE_TYPES } from './nodes.js';

export const SKIP = Symbol('skip');

/** Validates graph structure. Returns a list of human-readable problems (empty = ok). */
export function validateGraph(graph) {
  const problems = [];
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return ['graph must be {nodes: [], edges: []}'];
  const ids = new Set();
  for (const n of graph.nodes) {
    if (!n.id || typeof n.id !== 'string') problems.push('every node needs a string id');
    else if (ids.has(n.id)) problems.push(`duplicate node id ${n.id}`);
    ids.add(n.id);
    if (!NODE_TYPES[n.type]) problems.push(`node ${n.id}: unknown type "${n.type}"`);
  }
  const triggers = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) problems.push(`a workflow needs exactly one Start node (found ${triggers.length})`);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const e of graph.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) {
      problems.push(`edge ${e.id || '?'} references a missing node`);
      continue;
    }
    const ports = NODE_TYPES[from.type]?.outputs(from.config || {}) || [];
    if (!ports.includes(e.fromPort)) problems.push(`edge from "${from.name || from.id}" uses unknown port "${e.fromPort}"`);
    if (!NODE_TYPES[to.type]?.input) problems.push(`"${to.name || to.id}" has no input`);
  }
  return problems;
}

/**
 * Event-driven workflow executor (n8n-style).
 *
 * Tokens flow along edges. A node runs each time data reaches it; ports a node
 * does not emit on send a SKIP token so downstream Merge nodes know that branch
 * is dead. Merge waits until every incoming edge delivered data or SKIP (and,
 * once the run goes quiet, fires with whatever arrived). Cycles are allowed
 * (e.g. review → fix loops) and bounded by `maxVisits` per node and `maxSteps`.
 *
 * @param {{graph: object, vars: object, env: object, signal?: AbortSignal,
 *          onNode?: (evt: {nodeId: string, status: string, output?: unknown, error?: string, visit?: number}) => void,
 *          log?: (text: string, stream?: string) => void, maxSteps?: number}} opts
 * @returns {Promise<{status: 'succeeded'|'failed'|'cancelled', result: {text?: unknown, json?: unknown}|null, nodes: object, visits: object, error?: string, lastOutput: unknown}>}
 */
export async function runGraph({ graph, vars = {}, env, signal, onNode = () => {}, log = () => {}, maxSteps = 500 }) {
  const problems = validateGraph(graph);
  if (problems.length) return { status: 'failed', result: null, nodes: {}, visits: {}, error: problems.join('; '), lastOutput: null };

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const outgoing = new Map();
  const incoming = new Map();
  for (const e of graph.edges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from).push(e);
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to).push(e);
  }
  const nodes = {}; // last output per node id
  const visits = {};
  const mergeBuffers = new Map(); // nodeId -> Map(edgeId -> payload|SKIP)
  const queue = [];
  let result = null;
  let lastOutput = null;
  let steps = 0;

  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  queue.push({ nodeId: trigger.id, payload: vars, edge: null });

  const emit = (node, ports) => {
    for (const e of outgoing.get(node.id) || []) {
      const payload = Object.hasOwn(ports, e.fromPort) ? ports[e.fromPort] : SKIP;
      queue.push({ nodeId: e.to, payload, edge: e });
    }
  };

  const fireMerge = (node, buffer) => {
    const entries = [...buffer.entries()].filter(([, v]) => v !== SKIP);
    mergeBuffers.delete(node.id);
    if (entries.length === 0) return emit(node, {}); // every branch skipped
    const edgeById = new Map((incoming.get(node.id) || []).map((e) => [e.id, e]));
    const payload = { items: entries.map(([, v]) => v), byNode: Object.fromEntries(entries.map(([edgeId, v]) => [edgeById.get(edgeId)?.from, v])) };
    return execute(node, payload);
  };

  async function execute(node, payload) {
    const type = NODE_TYPES[node.type];
    const visit = (visits[node.id] || 0) + 1;
    const maxVisits = node.config?.maxVisits || 20;
    if (visit > maxVisits) throw new Error(`"${node.name || node.id}" ran more than ${maxVisits} times (loop limit)`);
    visits[node.id] = visit;
    onNode({ nodeId: node.id, status: 'running', visit });
    const scope = { input: payload, vars, nodes, visits };
    let ports;
    try {
      ports = await type.execute({ node, config: { ...type.defaults, ...(node.config || {}) }, input: payload, scope, env, signal, log: (text, stream = 'system') => log(`[${node.name || node.id}] ${text}${text.endsWith('\n') ? '' : '\n'}`, stream) });
    } catch (err) {
      if (err.cancelled) throw err;
      // Nodes with an "error" port route failures instead of failing the run.
      if (type.outputs(node.config || {}).includes('error')) ports = { error: { error: err.message, input: payload } };
      else {
        onNode({ nodeId: node.id, status: 'error', error: err.message, visit });
        throw Object.assign(err, { nodeId: node.id });
      }
    }
    if (ports.__result) {
      result = ports.__result;
      nodes[node.id] = result;
      onNode({ nodeId: node.id, status: 'done', output: result, visit });
      return;
    }
    const emitted = Object.keys(ports);
    const output = emitted.length === 1 ? ports[emitted[0]] : ports;
    nodes[node.id] = output;
    lastOutput = output;
    onNode({ nodeId: node.id, status: emitted.includes('error') ? 'error' : 'done', output, ports: emitted, visit });
    emit(node, ports);
  }

  try {
    for (;;) {
      while (queue.length) {
        if (signal?.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
        if (++steps > maxSteps) throw new Error(`workflow exceeded ${maxSteps} steps`);
        const { nodeId, payload, edge } = queue.shift();
        const node = byId.get(nodeId);
        const inbound = incoming.get(nodeId) || [];
        if (node.type === 'merge') {
          const buffer = mergeBuffers.get(nodeId) || new Map();
          buffer.set(edge?.id, payload);
          mergeBuffers.set(nodeId, buffer);
          if (inbound.every((e) => buffer.has(e.id))) await fireMerge(node, buffer);
          continue;
        }
        if (payload === SKIP) {
          // A node fed by a single edge is dead when that edge is; nodes with several inputs just ignore the skip.
          if (inbound.length <= 1) {
            onNode({ nodeId, status: 'skipped' });
            emit(node, {});
          }
          continue;
        }
        await execute(node, payload);
      }
      // Quiescent: release merges still waiting on branches that never delivered anything.
      const pending = [...mergeBuffers.entries()].find(([, buf]) => [...buf.values()].some((v) => v !== SKIP));
      if (!pending) break;
      await fireMerge(byId.get(pending[0]), pending[1]);
    }
  } catch (err) {
    if (err.cancelled) return { status: 'cancelled', result, nodes, visits, lastOutput, error: 'cancelled' };
    return { status: 'failed', result, nodes, visits, lastOutput, error: err.message, failedNode: err.nodeId };
  }
  return { status: 'succeeded', result, nodes, visits, lastOutput };
}
