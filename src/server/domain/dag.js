/**
 * Pure dependency-graph helpers. An edge { from, to } means `from` must finish
 * before `to` can start (from = prerequisite, to = dependent).
 */

/** Builds adjacency (prerequisite -> dependents) from edges. */
function adjacency(edges) {
  const out = new Map();
  for (const { from, to } of edges) {
    if (!out.has(from)) out.set(from, []);
    out.get(from).push(to);
  }
  return out;
}

/** True if adding from -> to would close a cycle (i.e. `to` already reaches `from`). */
export function wouldCreateCycle(edges, from, to) {
  if (from === to) return true;
  const adj = adjacency(edges);
  const stack = [to];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (node === from) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adj.get(node) || []) stack.push(next);
  }
  return false;
}

/**
 * Kahn topological sort. Returns { order, levels, cycle } where levels[id] is
 * the longest distance from a root (used for left-to-right flow layouts) and
 * cycle lists nodes that could not be ordered.
 */
export function topoSort(nodeIds, edges) {
  const ids = new Set(nodeIds);
  const indegree = new Map([...ids].map((id) => [id, 0]));
  const valid = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  for (const { to } of valid) indegree.set(to, indegree.get(to) + 1);
  const adj = adjacency(valid);
  const levels = {};
  const queue = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) {
      queue.push(id);
      levels[id] = 0;
    }
  }
  const order = [];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    order.push(id);
    for (const next of adj.get(id) || []) {
      levels[next] = Math.max(levels[next] ?? 0, levels[id] + 1);
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  const ordered = new Set(order);
  const cycle = [...ids].filter((id) => !ordered.has(id));
  return { order, levels, cycle };
}

/** All transitive dependents of a node. */
export function descendants(edges, id) {
  const adj = adjacency(edges);
  const out = new Set();
  const stack = [...(adj.get(id) || [])];
  while (stack.length) {
    const node = stack.pop();
    if (out.has(node)) continue;
    out.add(node);
    stack.push(...(adj.get(node) || []));
  }
  return out;
}

/** All transitive prerequisites of a node, nearest first, up to `depth` hops (Infinity = all). */
export function ancestors(edges, id, depth = Infinity) {
  const parents = new Map();
  for (const { from, to } of edges) {
    if (!parents.has(to)) parents.set(to, []);
    parents.get(to).push(from);
  }
  const out = [];
  const seen = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const node of frontier) {
      for (const p of parents.get(node) || []) {
        if (seen.has(p)) continue;
        seen.add(p);
        out.push(p);
        next.push(p);
      }
    }
    frontier = next;
  }
  return out;
}
