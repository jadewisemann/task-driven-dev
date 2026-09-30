import { avatar } from '../agents/avatar.js';
import { h } from '../dom.js';

const COL_W = 270;
const ROW_H = 104;
const NODE_W = 220;
const NODE_H = 78;
const PAD = 24;

/**
 * Renders the task dependency graph left → right by topological level.
 * @param {{tasks: object[], edges: {from, to}[], levels: object}} graph
 * @param {{agents: object[], selectedId?: string, onSelect: (task) => void}} opts
 */
export function renderDag(graph, { agents, selectedId, onSelect }) {
  const byLevel = new Map();
  for (const t of graph.tasks) {
    const level = graph.levels[t.id] ?? 0;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(t);
  }
  const pos = new Map();
  let maxRows = 0;
  for (const [level, list] of byLevel) {
    list.sort((a, b) => b.priority - a.priority || a.position - b.position);
    list.forEach((t, i) => pos.set(t.id, { x: PAD + level * COL_W, y: PAD + i * ROW_H }));
    maxRows = Math.max(maxRows, list.length);
  }
  const width = PAD * 2 + Math.max(1, byLevel.size) * COL_W;
  const height = PAD * 2 + Math.max(1, maxRows) * ROW_H;
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'dag-edges');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  for (const e of graph.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const dx = Math.max(30, (x2 - x1) / 2);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
    const from = byId.get(e.from);
    path.setAttribute('class', `dag-edge ${from?.status === 'done' ? 'satisfied' : from?.status === 'failed' ? 'broken' : ''}`);
    svg.append(path);
  }

  const nodes = graph.tasks.map((t) => {
    const p = pos.get(t.id);
    const agent = agents.find((a) => a.id === t.assigneeId);
    return h(
      'button',
      {
        class: ['dag-node', `status-${t.status}`, t.id === selectedId && 'selected'],
        style: { left: `${p.x}px`, top: `${p.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` },
        title: t.error || t.result?.summary || t.description || t.title,
        onClick: () => onSelect(t),
      },
      h('div', { class: 'dag-top' }, h('span', { class: `dot status-${t.status}` }), h('span', { class: 'dag-status' }, t.status), t.status === 'running' && h('span', { class: 'spinner' })),
      h('div', { class: 'dag-title' }, t.title),
      h('div', { class: 'dag-agent' }, avatar(agent, { size: 18 }), h('span', { class: 'muted small' }, agent ? `${agent.name} · ${agent.model || agent.harness}` : 'unassigned'), h('span', { class: 'complexity' }, '●'.repeat(t.complexity))),
    );
  });

  return h('div', { class: 'dag', style: { width: `${width}px`, height: `${height}px` } }, svg, nodes);
}
