import { h } from '../dom.js';

const NODE_WIDTH = 210;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Output ports of a node: routers derive them from their rules. */
export function outputPorts(node, typeInfo) {
  if (node.type === 'router') {
    const config = { ...(typeInfo?.defaults || {}), ...(node.config || {}) };
    return [...new Set([...(config.rules || []).map((r) => r.port).filter(Boolean), 'else', ...(config.mode === 'agent' ? ['error'] : [])])];
  }
  return typeInfo?.staticOutputs || [];
}

const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const curve = (a, b) => {
  if (b.x < a.x + 20) {
    // Back edge (loop): swing below both nodes instead of cutting through them.
    const drop = Math.max(a.y, b.y) + 90;
    return `M ${a.x} ${a.y} C ${a.x + 90} ${a.y}, ${a.x + 90} ${drop}, ${(a.x + b.x) / 2} ${drop} S ${b.x - 90} ${b.y}, ${b.x} ${b.y}`;
  }
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
};

/**
 * n8n-style node canvas: pan (drag background), zoom (wheel), drag nodes,
 * connect output → input ports by dragging, select nodes/edges, Delete removes.
 *
 * @param {{types: object[], onChange: (graph) => void, onSelect: (sel: {node?: object, edge?: object}|null) => void}} opts
 */
export function createCanvas({ types, onChange, onSelect }) {
  const typeOf = (t) => types.find((x) => x.type === t);
  const root = h('div', { class: 'wf-canvas', tabindex: '0' });
  const world = h('div', { class: 'wf-world' });
  const edgesSvg = svg('svg', { class: 'wf-edges' });
  const tempPath = svg('path', { class: 'wf-edge temp' });
  edgesSvg.append(tempPath);
  world.append(edgesSvg);
  root.append(world, h('div', { class: 'wf-hint muted small' }, 'Drag background to pan · wheel to zoom · drag from an output ● to an input ● to connect · Del removes selection'));

  let graph = { nodes: [], edges: [] };
  const view = { x: 40, y: 40, k: 1 };
  let selection = null; // {type: 'node'|'edge', id}
  const nodeEls = new Map();
  const status = new Map(); // nodeId -> {status, visit}

  const applyView = () => (world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`);
  const toWorld = (clientX, clientY) => {
    const r = root.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  };
  const changed = () => onChange?.(graph);

  function portPoint(nodeId, port, dir) {
    const el = nodeEls.get(nodeId);
    if (!el) return null;
    const dot = dir === 'in' ? el.querySelector('.port-in') : el.querySelector(`.port-out[data-port="${CSS.escape(port)}"]`);
    if (!dot) return null;
    const r = dot.getBoundingClientRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  function drawEdges() {
    for (const el of [...edgesSvg.querySelectorAll('g.wf-edge-group')]) el.remove();
    for (const e of graph.edges) {
      const a = portPoint(e.from, e.fromPort, 'out');
      const b = portPoint(e.to, e.toPort, 'in');
      if (!a || !b) continue;
      const d = curve(a, b);
      const selected = selection?.type === 'edge' && selection.id === e.id;
      const g = svg('g', { class: 'wf-edge-group' });
      const hit = svg('path', { d, class: 'wf-edge-hit' });
      const flowed = status.get(e.from)?.ports?.includes(e.fromPort);
      const line = svg('path', { d, class: `wf-edge${selected ? ' selected' : ''}${flowed ? ' flowed' : ''}` });
      hit.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        select({ type: 'edge', id: e.id });
      });
      g.append(line, hit);
      edgesSvg.insertBefore(g, tempPath);
    }
  }

  function renderNode(node) {
    const info = typeOf(node.type);
    const st = status.get(node.id);
    const ports = outputPorts(node, info);
    const el = h(
      'div',
      {
        class: ['wf-node', `wf-type-${node.type.replace('.', '-')}`, selection?.type === 'node' && selection.id === node.id && 'selected', st && `st-${st.status}`],
        style: { left: `${node.x}px`, top: `${node.y}px`, width: `${NODE_WIDTH}px` },
        dataset: { id: node.id },
      },
      h(
        'div',
        { class: 'wf-node-head', onMousedown: (ev) => startNodeDrag(ev, node) },
        h('span', { class: 'wf-icon' }, info?.icon || '?'),
        h('span', { class: 'wf-name' }, node.name || info?.label || node.type),
        st?.visit > 1 && h('span', { class: 'wf-visits', title: 'runs in this execution' }, `×${st.visit}`),
      ),
      h(
        'div',
        { class: 'wf-node-body' },
        info?.input ? h('span', { class: 'port port-in', title: 'input' }) : null,
        h('div', { class: 'wf-type muted small' }, info?.label || node.type, nodeSummary(node)),
        h(
          'div',
          { class: 'wf-outs' },
          ports.map((p) =>
            h('div', { class: 'wf-out' }, h('span', { class: 'small' }, p), h('span', { class: ['port', 'port-out', p === 'error' && 'port-error'], dataset: { port: p }, title: `output: ${p}`, onMousedown: (ev) => startConnect(ev, node, p) })),
          ),
        ),
      ),
    );
    el.addEventListener('mousedown', (ev) => {
      if (ev.target.classList.contains('port-out')) return;
      ev.stopPropagation();
      select({ type: 'node', id: node.id });
    });
    return el;
  }

  function nodeSummary(node) {
    const c = node.config || {};
    if (node.type === 'agent') return c.agentId === 'self' ? ' · self' : '';
    if (node.type === 'router') return ` · ${c.mode === 'agent' ? 'agent decides' : `${(c.rules || []).length} rules`}`;
    if (node.type === 'shell') return c.command ? ` · ${String(c.command).slice(0, 24)}` : '';
    return '';
  }

  function render() {
    for (const el of nodeEls.values()) el.remove();
    nodeEls.clear();
    for (const node of graph.nodes) {
      const el = renderNode(node);
      nodeEls.set(node.id, el);
      world.append(el);
    }
    requestAnimationFrame(drawEdges);
  }

  function refreshNode(nodeId) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    const old = nodeEls.get(nodeId);
    if (!node || !old) return render();
    const el = renderNode(node);
    old.replaceWith(el);
    nodeEls.set(nodeId, el);
    // Ports may have changed (router rules): drop edges whose port disappeared.
    const ports = outputPorts(node, typeOf(node.type));
    const before = graph.edges.length;
    graph.edges = graph.edges.filter((e) => e.from !== nodeId || ports.includes(e.fromPort));
    if (graph.edges.length !== before) changed();
    requestAnimationFrame(drawEdges);
  }

  function select(sel) {
    selection = sel;
    for (const [id, el] of nodeEls) el.classList.toggle('selected', sel?.type === 'node' && sel.id === id);
    drawEdges();
    if (!sel) onSelect?.(null);
    else if (sel.type === 'node') onSelect?.({ node: graph.nodes.find((n) => n.id === sel.id) });
    else onSelect?.({ edge: graph.edges.find((e) => e.id === sel.id) });
    root.focus({ preventScroll: true });
  }

  function dragLoop(onMove, onUp) {
    const move = (ev) => onMove(ev);
    const up = (ev) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      onUp?.(ev);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function startNodeDrag(ev, node) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    select({ type: 'node', id: node.id });
    const start = toWorld(ev.clientX, ev.clientY);
    const origin = { x: node.x, y: node.y };
    let moved = false;
    dragLoop(
      (e) => {
        const p = toWorld(e.clientX, e.clientY);
        node.x = Math.round((origin.x + p.x - start.x) / 10) * 10;
        node.y = Math.round((origin.y + p.y - start.y) / 10) * 10;
        const el = nodeEls.get(node.id);
        el.style.left = `${node.x}px`;
        el.style.top = `${node.y}px`;
        moved = true;
        drawEdges();
      },
      () => moved && changed(),
    );
  }

  function startConnect(ev, node, port) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const a = portPoint(node.id, port, 'out');
    dragLoop(
      (e) => tempPath.setAttribute('d', curve(a, toWorld(e.clientX, e.clientY))),
      (e) => {
        tempPath.setAttribute('d', '');
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.wf-node');
        const toId = target?.dataset.id;
        if (!toId || toId === node.id) return;
        const toNode = graph.nodes.find((n) => n.id === toId);
        if (!typeOf(toNode.type)?.input) return;
        if (graph.edges.some((x) => x.from === node.id && x.fromPort === port && x.to === toId)) return;
        graph.edges.push({ id: `e_${Math.random().toString(36).slice(2, 9)}`, from: node.id, fromPort: port, to: toId, toPort: 'in' });
        changed();
        drawEdges();
      },
    );
  }

  root.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('.wf-node')) return;
    select(null);
    const start = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
    root.classList.add('panning');
    dragLoop(
      (e) => {
        view.x = start.vx + e.clientX - start.x;
        view.y = start.vy + e.clientY - start.y;
        applyView();
      },
      () => root.classList.remove('panning'),
    );
  });
  root.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const before = toWorld(ev.clientX, ev.clientY);
      view.k = Math.min(2, Math.max(0.3, view.k * (ev.deltaY < 0 ? 1.1 : 1 / 1.1)));
      const r = root.getBoundingClientRect();
      view.x = ev.clientX - r.left - before.x * view.k;
      view.y = ev.clientY - r.top - before.y * view.k;
      applyView();
    },
    { passive: false },
  );
  root.addEventListener('keydown', (ev) => {
    if (!['Delete', 'Backspace'].includes(ev.key) || !selection || ev.target !== root) return;
    ev.preventDefault();
    api.removeSelection();
  });

  const api = {
    el: root,
    setGraph(next) {
      graph = next;
      selection = null;
      status.clear();
      render();
    },
    getGraph: () => graph,
    refreshNode,
    redraw: render,
    /** Keeps wires attached when a router route is renamed. */
    renamePort(nodeId, from, to) {
      for (const e of graph.edges) if (e.from === nodeId && e.fromPort === from) e.fromPort = to;
    },
    /** Adds a node at the centre of the visible area. */
    addNode(type, config) {
      const info = typeOf(type);
      const r = root.getBoundingClientRect();
      const c = toWorld(r.left + r.width / 2 - NODE_WIDTH / 2, r.top + r.height / 2 - 40);
      const base = type.replace('.', '_');
      let i = 1;
      while (graph.nodes.some((n) => n.id === `${base}${i}`)) i++;
      const node = { id: `${base}${i}`, type, name: `${info.label}${i > 1 ? ` ${i}` : ''}`, x: Math.round(c.x / 10) * 10, y: Math.round(c.y / 10) * 10, config: structuredClone(config ?? info.defaults ?? {}) };
      graph.nodes.push(node);
      changed();
      render();
      select({ type: 'node', id: node.id });
      return node;
    },
    removeSelection() {
      if (!selection) return;
      if (selection.type === 'node') {
        const node = graph.nodes.find((n) => n.id === selection.id);
        if (node?.type === 'trigger') return;
        graph.nodes = graph.nodes.filter((n) => n.id !== selection.id);
        graph.edges = graph.edges.filter((e) => e.from !== selection.id && e.to !== selection.id);
      } else graph.edges = graph.edges.filter((e) => e.id !== selection.id);
      selection = null;
      onSelect?.(null);
      changed();
      render();
    },
    setStatus(nodeId, st) {
      status.set(nodeId, st);
      const el = nodeEls.get(nodeId);
      if (!el) return;
      el.classList.remove('st-running', 'st-done', 'st-error', 'st-skipped');
      el.classList.add(`st-${st.status}`);
      const head = el.querySelector('.wf-node-head');
      head.querySelector('.wf-visits')?.remove();
      if (st.visit > 1) head.append(h('span', { class: 'wf-visits' }, `×${st.visit}`));
      drawEdges();
    },
    clearStatus() {
      status.clear();
      for (const el of nodeEls.values()) el.classList.remove('st-running', 'st-done', 'st-error', 'st-skipped');
      drawEdges();
    },
    fit() {
      if (!graph.nodes.length) return;
      const xs = graph.nodes.map((n) => n.x);
      const ys = graph.nodes.map((n) => n.y);
      const r = root.getBoundingClientRect();
      const w = Math.max(...xs) - Math.min(...xs) + NODE_WIDTH + 80;
      const hgt = Math.max(...ys) - Math.min(...ys) + 200;
      view.k = Math.min(1.2, Math.max(0.3, Math.min(r.width / w, r.height / hgt)));
      view.x = -Math.min(...xs) * view.k + 40;
      view.y = -Math.min(...ys) * view.k + 40;
      applyView();
      requestAnimationFrame(drawEdges);
    },
  };
  applyView();
  return api;
}
