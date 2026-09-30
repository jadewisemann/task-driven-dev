import { NODE_TYPES, portsOf } from './nodes.js';

export const SKIP = Symbol('skip');
const RESERVED_PORTS = new Set(['__result', 'in']);

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
    if (n.type === 'router') {
      for (const r of n.config?.rules || []) {
        if (!r.port || RESERVED_PORTS.has(r.port) || r.port === 'else' || r.port === 'error') problems.push(`router "${n.name || n.id}": route name "${r.port || ''}" is empty or reserved`);
      }
    }
  }
  const triggers = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) problems.push(`a workflow needs exactly one Start node (found ${triggers.length})`);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgeIds = new Set();
  const wires = new Set();
  for (const e of graph.edges) {
    if (!e.id || typeof e.id !== 'string') problems.push('every edge needs a string id');
    else if (edgeIds.has(e.id)) problems.push(`duplicate edge id ${e.id}`);
    edgeIds.add(e.id);
    const wire = `${e.from}.${e.fromPort}->${e.to}`;
    if (wires.has(wire)) problems.push(`duplicate connection ${wire}`);
    wires.add(wire);
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) {
      problems.push(`edge ${e.id || '?'} references a missing node`);
      continue;
    }
    if (!NODE_TYPES[from.type] || !NODE_TYPES[to.type]) continue;
    if (!portsOf(from).includes(e.fromPort)) problems.push(`edge from "${from.name || from.id}" uses unknown port "${e.fromPort}"`);
    if (!NODE_TYPES[to.type].input) problems.push(`"${to.name || to.id}" has no input`);
  }
  return problems;
}

class NodeError extends Error {
  constructor(message, nodeId) {
    super(message);
    this.nodeId = nodeId;
  }
}

/**
 * Event-driven workflow executor (n8n-style).
 *
 * Tokens flow along edges. A node runs each time data reaches it; ports a node
 * does not emit on send a SKIP token so downstream Merge nodes know that branch
 * is dead. Merge keeps a FIFO per incoming edge and fires once every edge has a
 * token (data or SKIP); when the run goes quiet, merges still waiting fire with
 * whatever arrived. Cycles are allowed (review → fix loops) and bounded by
 * `maxVisits` per node and `maxSteps` per run.
 *
 * Errors: a node that emits on its "error" port only counts as handled when an
 * edge is attached to that port — otherwise the run fails at that node.
 *
 * @returns {Promise<{status: 'succeeded'|'failed'|'cancelled', result: {text?: unknown, json?: unknown}|null,
 *          nodes: object, visits: object, error?: string, failedNode?: string, lastOutput: unknown}>}
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
  const mergeQueues = new Map(); // nodeId -> Map(edgeId -> payload[])
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

  /** Takes one token from every inbound edge of a merge and fires it. */
  async function fireMerge(node, partial = false) {
    const queues = mergeQueues.get(node.id);
    const inbound = incoming.get(node.id) || [];
    const taken = [];
    for (const e of inbound) {
      const q = queues.get(e.id);
      if (q?.length) taken.push([e, q.shift()]);
      else if (!partial) return;
    }
    if (inbound.every((e) => !queues.get(e.id)?.length)) mergeQueues.delete(node.id);
    const data = taken.filter(([, v]) => v !== SKIP);
    if (data.length === 0) {
      onNode({ nodeId: node.id, status: 'skipped' });
      return emit(node, {}); // every branch was dead
    }
    await execute(node, { items: data.map(([, v]) => v), byNode: Object.fromEntries(data.map(([e, v]) => [e.from, v])) });
  }

  async function execute(node, payload) {
    const type = NODE_TYPES[node.type];
    const visit = (visits[node.id] || 0) + 1;
    const maxVisits = node.config?.maxVisits || 20;
    if (visit > maxVisits) {
      onNode({ nodeId: node.id, status: 'error', error: 'loop limit', visit: visit - 1 });
      throw new NodeError(`"${node.name || node.id}" ran more than ${maxVisits} times (loop limit)`, node.id);
    }
    visits[node.id] = visit;
    onNode({ nodeId: node.id, status: 'running', visit });
    const scope = { input: payload, vars, nodes, visits };
    const config = { ...type.defaults, ...(node.config || {}) };
    const nodeLog = (text, stream = 'system') => log(stream === 'system' ? `[${node.name || node.id}] ${text}${text.endsWith('\n') ? '' : '\n'}` : text, stream);
    const errorWired = (outgoing.get(node.id) || []).some((e) => e.fromPort === 'error');
    let ports;
    try {
      ports = await type.execute({ node, config, input: payload, scope, env, signal, log: nodeLog });
    } catch (err) {
      if (err.cancelled) throw err;
      ports = { error: { error: err.message, input: payload } };
    }
    if (ports.__result) {
      result = ports.__result;
      nodes[node.id] = result;
      onNode({ nodeId: node.id, status: 'done', output: result, visit });
      return;
    }
    if (Object.hasOwn(ports, 'error') && !errorWired) {
      // Unhandled failure: nothing is connected to "error", so the run fails here.
      nodes[node.id] = ports.error;
      const message = ports.error?.error || (ports.error?.code !== undefined ? `exited with code ${ports.error.code}` : 'node failed');
      onNode({ nodeId: node.id, status: 'error', error: message, output: ports.error, visit });
      throw new NodeError(`"${node.name || node.id}" failed: ${String(message).split('\n')[0]}`, node.id);
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
          if (!mergeQueues.has(nodeId)) mergeQueues.set(nodeId, new Map());
          const queues = mergeQueues.get(nodeId);
          if (!queues.has(edge.id)) queues.set(edge.id, []);
          queues.get(edge.id).push(payload);
          if (inbound.every((e) => queues.get(e.id)?.length)) await fireMerge(node);
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
      // Quiescent: release merges still waiting on branches that never delivered.
      const pending = [...mergeQueues.keys()][0];
      if (!pending) break;
      await fireMerge(byId.get(pending), true);
    }
  } catch (err) {
    if (err.cancelled) return { status: 'cancelled', result, nodes, visits, lastOutput, error: 'cancelled' };
    return { status: 'failed', result, nodes, visits, lastOutput, error: err.message, failedNode: err.nodeId };
  }
  return { status: 'succeeded', result, nodes, visits, lastOutput };
}
