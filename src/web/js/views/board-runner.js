import { h, promptForm, timeAgo, toast } from '../dom.js';
import { logViewer } from '../runs/log-viewer.js';
import { registerBoardExtension } from './board-ext.js';

const STATE_LABEL = { idle: 'idle', running: 'running', waiting: 'waiting', finished: 'finished', stopped: 'stopped' };

export async function startScheduler(ctx) {
  const values = await promptForm(
    'Run project autonomously',
    [
      { name: 'concurrency', label: 'Parallel agents', type: 'number', value: 2 },
      { name: 'includeBacklog', label: 'Also queue Backlog cards', type: 'checkbox', value: false },
      {
        name: 'reviewPolicy',
        label: 'When an agent asks for review',
        type: 'select',
        value: 'wait',
        options: [
          { value: 'wait', label: 'Wait for me (move card to Done to approve)' },
          { value: 'auto-approve', label: 'Auto-approve and keep going' },
        ],
      },
    ],
    { submitLabel: 'Start' },
  );
  if (!values) return;
  await ctx.rpc('scheduler.start', {
    projectId: ctx.project.id,
    concurrency: Math.max(1, Number(values.concurrency) || 1),
    includeBacklog: values.includeBacklog,
    reviewPolicy: values.reviewPolicy,
  });
  toast('Scheduler started — tasks run in dependency order until everything is done', 'success');
}

/** Board integration for execution: run controls, live card state, output + logs in the drawer. */
registerBoardExtension({
  id: 'runner',
  events: ['scheduler.', 'run.started', 'run.finished'],
  load: (ctx) => ctx.rpc('scheduler.status', { projectId: ctx.project.id }),

  toolbar(data, ctx) {
    const s = data.runner || { state: 'idle' };
    const live = s.state === 'running' || s.state === 'waiting';
    return h(
      'div',
      { class: 'run-controls' },
      h(
        'span',
        { class: `sched-pill sched-${s.state}`, title: s.reason || '' },
        h('span', { class: 'dot' }),
        `scheduler ${STATE_LABEL[s.state] || s.state}`,
        s.active?.length ? ` · ${s.active.length} active` : '',
        s.stats ? ` · ✓${s.stats.succeeded} ✗${s.stats.failed}` : '',
      ),
      s.reason && live && h('span', { class: 'muted small' }, s.reason),
      live
        ? h('button', { class: 'btn danger', onClick: () => ctx.rpc('scheduler.stop', { projectId: ctx.project.id }).catch(ctx.showError) }, '■ Stop')
        : h('button', { class: 'btn success', onClick: () => startScheduler(ctx).catch(ctx.showError) }, '▶ Run all'),
    );
  },

  cardFooter(task, data, ctx) {
    if (task.status === 'running') return h('div', { class: 'card-run running' }, h('span', { class: 'spinner' }), `running · attempt ${task.attempts}`);
    if (task.status === 'failed' || task.status === 'blocked') {
      return h(
        'div',
        { class: 'card-run failed' },
        h('span', { class: 'card-error', title: task.error || '' }, (task.error || task.status).split('\n')[0]),
        task.status === 'failed' &&
          h(
            'button',
            {
              class: 'btn small',
              onClick: (e) => {
                e.stopPropagation();
                ctx.rpc('tasks.retry', { taskId: task.id }).catch(ctx.showError);
              },
            },
            'Retry',
          ),
      );
    }
    if (task.status === 'review') {
      return h(
        'div',
        { class: 'card-run review' },
        h('span', {}, task.result?.summary ? task.result.summary.slice(0, 80) : 'awaiting review'),
        h(
          'button',
          {
            class: 'btn small success',
            onClick: (e) => {
              e.stopPropagation();
              ctx.rpc('tasks.move', { id: task.id, status: 'done' }).catch(ctx.showError);
            },
          },
          'Approve',
        ),
      );
    }
    if (task.status === 'done' && task.result) {
      return h('div', { class: 'card-run done muted', title: task.result.summary || '' }, task.result.commit ? `⎇ ${task.result.commit.slice(0, 7)} · ` : '', (task.result.summary || 'done').slice(0, 70));
    }
    return null;
  },

  /** Self-refreshing Execution section: follows the task's status and switches the log to each new run. */
  drawerSection(initialTask, data, ctx) {
    const section = h('div', { class: 'section' });
    const runsBox = h('div', { class: 'runs-list' });
    const logsBox = h('div');
    let viewing = null;
    let attached = false;
    setTimeout(() => (attached = true), 0);

    const act = (method, params, message) => () =>
      ctx
        .rpc(method, params)
        .then(() => message && toast(message, 'success'))
        .catch(ctx.showError);

    const view = (runId) => {
      if (viewing === runId) return;
      viewing = runId;
      logsBox.replaceChildren(logViewer(ctx, runId));
    };

    function render(task, runs) {
      runsBox.replaceChildren(
        ...(runs.length
          ? runs.map((r) =>
              h(
                'button',
                { class: ['run-row', r.id === viewing && 'active'], onClick: () => view(r.id) },
                h('span', { class: `dot run-${r.status}` }),
                `#${r.attempt} ${r.meta.agentName || ''}`,
                h('span', { class: 'muted' }, ` ${r.status} · ${timeAgo(r.startedAt)}`),
              ),
            )
          : [h('p', { class: 'muted small' }, 'Not run yet.')]),
      );
      section.replaceChildren(
        h('h4', {}, 'Execution'),
        h(
          'div',
          { class: 'run-actions' },
          task.status === 'running'
            ? h('button', { class: 'btn danger', onClick: act('tasks.cancel', { taskId: task.id }, 'Cancelling…') }, '■ Cancel')
            : h('button', { class: 'btn success', onClick: act('tasks.run', { taskId: task.id }, 'Started') }, '▶ Run now'),
          ['failed', 'blocked', 'done', 'review'].includes(task.status) && h('button', { class: 'btn', onClick: act('tasks.retry', { taskId: task.id }, 'Queued in To do') }, '↻ Re-queue'),
          task.branch && h('span', { class: 'muted small', title: task.worktreePath || '' }, `⎇ ${task.branch}`),
        ),
        task.error && h('pre', { class: 'preview-block error-block' }, task.error),
        task.result && h('details', { open: true }, h('summary', {}, 'Result'), h('pre', { class: 'preview-block' }, JSON.stringify(task.result, null, 2))),
        task.output && h('details', {}, h('summary', {}, `Output (${task.output.length} chars)`), h('pre', { class: 'preview-block' }, task.output)),
        h('details', { open: true }, h('summary', {}, 'Runs & live log'), runsBox, logsBox),
      );
    }

    async function refresh() {
      const [task, runs] = await Promise.all([ctx.rpc('tasks.get', { id: initialTask.id }), ctx.rpc('runs.list', { taskId: initialTask.id, limit: 10 })]);
      if (runs[0] && (viewing === null || runs[0].status === 'running')) view(runs[0].id);
      render(task, runs);
    }

    render(initialTask, []);
    refresh().catch(ctx.showError);
    const off = ctx.onEvent((e) => {
      if (attached && !section.isConnected) return off();
      const p = e.payload || {};
      const mine = p.task?.id === initialTask.id || p.run?.taskId === initialTask.id;
      if (mine && (e.type === 'task.updated' || e.type === 'run.started' || e.type === 'run.finished')) refresh().catch(ctx.showError);
    });
    return section;
  },
});
