import { h } from '../dom.js';

/**
 * Live log console for a run: loads history then appends `run.log` events.
 * Unsubscribes itself once the element has been removed from the DOM.
 */
export function logViewer(ctx, runId, { height = 320 } = {}) {
  const pre = h('pre', { class: 'log-console', style: { maxHeight: `${height}px` } });
  let lastId = 0;
  let follow = true;
  let attached = false;
  setTimeout(() => (attached = true), 0); // the caller inserts the element synchronously
  pre.addEventListener('scroll', () => {
    follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  });
  const append = (line) => {
    if (line.id && line.id <= lastId) return;
    lastId = Math.max(lastId, line.id || 0);
    pre.append(h('span', { class: `log-${line.stream}` }, line.text));
    if (follow) pre.scrollTop = pre.scrollHeight;
  };
  const loadMissing = () =>
    ctx
      .rpc('runs.logs', { runId, afterId: lastId })
      .then((lines) => lines.forEach(append))
      .catch(ctx.showError);
  const off = ctx.onEvent((e) => {
    if (attached && !pre.isConnected) return off();
    if (e.type === 'run.log' && e.payload.runId === runId) append(e.payload);
    else if (e.type === 'sync.reconnected') loadMissing();
  });
  loadMissing();
  return pre;
}
