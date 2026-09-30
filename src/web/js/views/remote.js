import { setPeer } from '../api.js';
import { confirmDialog, debounce, h, mountInto, promptForm, toast } from '../dom.js';

/**
 * Remote sessions: other machines running todo.devs, reached over SSH.
 * Always managed on the local instance, whatever session is selected.
 */
export const remoteView = {
  id: 'remote',
  title: 'Remote',
  icon: '⇄',
  mount(root, ctx) {
    const call = ctx.rpcLocal;

    async function addPeer() {
      const v = await promptForm('Add remote session', [
        { name: 'name', label: 'Name', placeholder: 'build-box' },
        {
          name: 'transport',
          label: 'Transport',
          type: 'select',
          value: 'ssh',
          options: [
            { value: 'ssh', label: 'SSH — ssh <target> todo-devs rpc' },
            { value: 'exec', label: 'Command — any local command that runs `todo-devs rpc` (docker exec -i …)' },
          ],
        },
        { name: 'target', label: 'SSH target (user@host) or command', placeholder: 'me@build-box.local' },
        { name: 'port', label: 'SSH port (optional)', type: 'number', placeholder: '22' },
        { name: 'identityFile', label: 'Identity file (optional)', placeholder: '~/.ssh/id_ed25519' },
        { name: 'remoteCommand', label: 'todo-devs command on the remote', value: 'todo-devs' },
        { name: 'remoteHome', label: 'Remote data dir (optional)', placeholder: '~/.todo-devs' },
      ]);
      if (!v?.name) return;
      const options = {};
      if (v.port) options.port = Number(v.port);
      if (v.identityFile) options.identityFile = v.identityFile;
      if (v.remoteHome) options.remoteHome = v.remoteHome;
      await call('peers.add', { name: v.name, transport: v.transport, target: v.target, remoteCommand: v.remoteCommand || 'todo-devs', options });
      toast(`Added ${v.name}`, 'success');
    }

    const act = (fn) => async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await fn();
      } catch (err) {
        ctx.showError(err);
      } finally {
        btn.disabled = false;
      }
    };

    function peerCard(p) {
      const s = p.status || { state: 'disconnected' };
      return h(
        'article',
        { class: 'panel peer-card' },
        h('div', { class: 'peer-head' }, h('span', { class: ['dot', `state-${s.state}`] }), h('h3', {}, p.name), h('span', { class: 'badge' }, s.state), ctx.peer === p.id && h('span', { class: 'badge scope-agent' }, 'active session')),
        h('pre', { class: 'preview-block' }, p.command),
        s.info && h('p', { class: 'small' }, `${s.info.host} · todo.devs ${s.info.version} · ${s.info.mode === 'daemon' ? 'attached to the running server' : 'embedded (no server running there)'} · data ${s.info.home}`),
        s.error && h('pre', { class: 'preview-block error-block' }, s.error),
        h(
          'div',
          { class: 'run-actions' },
          h(
            'button',
            {
              class: 'btn primary small',
              onClick: act(async () => {
                await call('peers.connect', { id: p.id });
                setPeer(p.id);
              }),
            },
            'Use this session',
          ),
          s.state === 'connected'
            ? h('button', { class: 'btn small', onClick: act(() => call('peers.disconnect', { id: p.id })) }, 'Disconnect')
            : h('button', { class: 'btn small', onClick: act(() => call('peers.connect', { id: p.id })) }, 'Connect'),
          h(
            'button',
            {
              class: 'btn small',
              onClick: act(async () => {
                const r = await call('peers.ping', { id: p.id });
                toast(`${p.name}: ${r.latencyMs} ms`, 'success');
              }),
            },
            'Ping',
          ),
          h(
            'button',
            {
              class: 'btn small danger ghost',
              onClick: act(async () => {
                if (!(await confirmDialog(`Remove ${p.name}?`))) return;
                if (ctx.peer === p.id) setPeer(null);
                await call('peers.remove', { id: p.id });
              }),
            },
            'Remove',
          ),
        ),
      );
    }

    async function load() {
      const peers = await call('peers.list');
      mountInto(
        root,
        h('div', { class: 'toolbar' }, h('div', { class: 'toolbar-title' }, h('h2', {}, 'Remote sessions'), h('span', { class: 'muted' }, 'Control todo.devs on other machines over SSH — same board, agents and flows.')), h('button', { class: 'btn primary', onClick: act(addPeer) }, '+ Add remote')),
        peers.length ? h('div', { class: 'grid-cards' }, peers.map(peerCard)) : h('div', { class: 'empty' }, 'No remote sessions yet.'),
        h(
          'div',
          { class: 'panel help-panel' },
          h('h4', {}, 'How it works'),
          h(
            'ol',
            {},
            h('li', {}, 'Install todo.devs on the remote machine (Node ≥ 22.13) so `todo-devs` is on its PATH — or set the full command, e.g. ', h('code', {}, 'node ~/todo-devs/bin/todo-devs.js'), '.'),
            h('li', {}, 'Make sure ', h('code', {}, 'ssh user@host'), ' works without a password prompt (keys / agent). Sessions use BatchMode.'),
            h('li', {}, 'Each session runs ', h('code', {}, 'todo-devs rpc'), ' on the remote. If a server is running there, calls go to it (its scheduler keeps working after you disconnect); otherwise an embedded instance lives for the session.'),
            h('li', {}, 'Prefer the remote’s own UI? Tunnel it: ', h('code', {}, 'ssh -L 7421:127.0.0.1:7420 user@host'), ' then open ', h('code', {}, 'http://localhost:7421'), '.'),
          ),
          h('p', { class: 'muted small' }, 'CLI: todo-devs peer add box me@box · todo-devs status --peer box · todo-devs plan "…" --run --peer box'),
        ),
      );
    }
    const reload = debounce(() => load().catch(ctx.showError), 100);
    const off = ctx.onLocalEvent((e) => e.type.startsWith('peer.') && reload());
    load().catch(ctx.showError);
    return off;
  },
};
