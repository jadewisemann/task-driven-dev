import { h, mountInto, toast } from '../dom.js';

const ICON = { ok: '✓', warn: '!', fail: '✗' };

/** Settings: version, health checks, how to run as a service, backups, and alpha feedback. */
export const settingsView = {
  id: 'settings',
  title: 'Settings',
  icon: '⚙',
  mount(root, ctx) {
    async function load() {
      const [info, doctor] = await Promise.all([ctx.rpc('system.info'), ctx.rpc('system.doctor')]);
      const copy = (text) => () => navigator.clipboard?.writeText(text).then(() => toast('Copied', 'success'), () => toast(text));
      const cmd = (text) => h('div', { class: 'pair-row' }, h('code', {}, text), h('button', { class: 'btn small ghost', onClick: copy(text) }, 'Copy'));
      mountInto(
        root,
        h('div', { class: 'toolbar' }, h('div', { class: 'toolbar-title' }, h('h2', {}, 'Settings'), h('span', { class: 'badge alpha-badge' }, `alpha · v${info.version}`))),
        h(
          'div',
          { class: 'grid-cards' },
          h(
            'div',
            { class: 'panel' },
            h('h4', {}, 'This instance'),
            h('p', { class: 'small' }, `${info.host} · ${info.platform} · Node ${info.node}`),
            h('p', { class: 'small muted' }, `Data: ${info.home}`),
            ctx.peer && h('p', { class: 'small warn-text' }, 'You are looking at a remote session.'),
          ),
          h(
            'div',
            { class: 'panel' },
            h('h4', {}, 'Alpha feedback'),
            h('p', { class: 'small' }, 'This is an alpha build: expect rough edges. Please report bugs and ideas — include the output of `todo-devs doctor`.'),
            info.feedbackUrl ? h('a', { class: 'btn primary small', href: info.feedbackUrl, target: '_blank', rel: 'noopener' }, 'Report an issue') : null,
          ),
        ),
        h(
          'div',
          { class: 'panel help-panel' },
          h('h4', {}, `Health check — ${doctor.summary}`),
          h(
            'table',
            { class: 'doctor-table' },
            h(
              'tbody',
              {},
              doctor.checks.map((c) =>
                h('tr', { class: `doctor-${c.status}` }, h('td', { class: 'doctor-icon' }, ICON[c.status]), h('td', {}, h('strong', {}, c.label)), h('td', { class: 'small' }, c.detail, c.fix ? h('div', { class: 'muted' }, `→ ${c.fix}`) : null)),
              ),
            ),
          ),
          h('button', { class: 'btn small', onClick: () => load().catch(ctx.showError) }, 'Run again'),
        ),
        h(
          'div',
          { class: 'panel help-panel' },
          h('h4', {}, 'Run in the background'),
          h('p', { class: 'small muted' }, 'Start todo.devs automatically when you log in (launchd on macOS, systemd on Linux):'),
          cmd('todo-devs service install'),
          cmd('todo-devs service install --host 0.0.0.0   # also reachable from your phone'),
          h('h4', {}, 'Backups'),
          cmd('todo-devs backup'),
          cmd('todo-devs restore <file>   # with the server stopped'),
        ),
      );
    }
    load().catch(ctx.showError);
  },
};
