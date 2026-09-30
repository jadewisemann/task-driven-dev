import { h } from '../dom.js';

const PAGE = 2000;
const MAX_NODES = 5000;

/**
 * Live log console for a run. History is paged in first; live `run.log` lines
 * that arrive meanwhile are buffered and merged by id, so nothing is dropped.
 * Unsubscribes itself once the element has been removed from the DOM.
 */
export function logViewer(ctx, runId, { height = 320 } = {}) {
  const pre = h('pre', { class: 'log-console', style: { maxHeight: `${height}px` } });
  let lastId = 0;
  let follow = true;
  let attached = false;
  let loading = true;
  let pendingLive = [];
  setTimeout(() => (attached = true), 0); // the caller inserts the element synchronously
  pre.addEventListener('scroll', () => {
    follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  });

  const append = (line) => {
    if (line.id <= lastId) return;
    lastId = line.id;
    pre.append(h('span', { class: `log-${line.stream}` }, line.text));
    while (pre.childNodes.length > MAX_NODES) pre.firstChild.remove();
    if (follow) pre.scrollTop = pre.scrollHeight;
  };

  async function loadMissing() {
    loading = true;
    try {
      for (;;) {
        const lines = await ctx.rpc('runs.logs', { runId, afterId: lastId });
        lines.forEach(append);
        if (lines.length < PAGE) break;
      }
    } catch (err) {
      ctx.showError(err);
    } finally {
      loading = false;
      const live = pendingLive.sort((a, b) => a.id - b.id);
      pendingLive = [];
      live.forEach(append);
    }
  }

  const off = ctx.onEvent((e) => {
    if (attached && !pre.isConnected) return off();
    if (e.type === 'run.log' && e.payload.runId === runId) {
      if (loading) pendingLive.push(e.payload);
      else append(e.payload);
    } else if (e.type === 'sync.reconnected') loadMissing();
  });
  loadMissing();
  return pre;
}
