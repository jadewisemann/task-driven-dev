import { getPeer, onLocalEvent, onPeerChange, rpcLocal, setPeer } from './api.js';
import { h, mountInto, toast } from './dom.js';

/**
 * Top-bar session switcher: the local instance plus every configured SSH peer.
 * Picking a peer opens its session; from then on the whole UI (board, agents,
 * workflows, orchestrator, runs) operates on that remote machine.
 */
export async function sessionSlot(el, { showError }) {
  let localInfo = null;
  let peers = [];
  let open = false;

  async function refresh() {
    [localInfo, peers] = await Promise.all([localInfo ? localInfo : rpcLocal('system.info'), rpcLocal('peers.list')]);
    // The active peer was removed (another tab, the CLI): fall back to the local session.
    if (getPeer() && !peers.some((p) => p.id === getPeer())) {
      toast('The remote session was removed — back to local', 'error');
      setPeer(null);
    }
    render();
  }

  async function choose(peerId) {
    open = false;
    if (!peerId) {
      setPeer(null);
      return render();
    }
    const peer = peers.find((p) => p.id === peerId);
    render({ connecting: peerId });
    try {
      await rpcLocal('peers.connect', { id: peerId });
      setPeer(peerId);
      toast(`Connected to ${peer?.name}`, 'success');
    } catch (err) {
      showError(err);
    }
    await refresh();
  }

  const stateClass = (p) => `state-${p.status?.state || 'disconnected'}`;

  function render({ connecting } = {}) {
    const current = peers.find((p) => p.id === getPeer());
    document.body.classList.toggle('remote-active', Boolean(current));
    const label = current ? `${current.name} · ${current.status?.info?.host || current.target}` : `local · ${localInfo?.host || ''}`;
    const menu =
      open &&
      h(
        'div',
        { class: 'session-menu' },
        h('button', { class: ['session-opt', !current && 'active'], onClick: () => choose(null) }, h('span', { class: 'dot' }), 'Local', h('span', { class: 'muted small' }, localInfo?.host || '')),
        peers.map((p) =>
          h(
            'button',
            { class: ['session-opt', current?.id === p.id && 'active'], onClick: () => choose(p.id) },
            h('span', { class: ['dot', stateClass(p)] }),
            p.name,
            h('span', { class: 'muted small' }, connecting === p.id ? 'connecting…' : `${p.transport} ${p.target}`),
          ),
        ),
        h('a', { class: 'session-opt manage', href: '#/remote', onClick: () => ((open = false), render()) }, '＋ Manage remote sessions'),
      );
    mountInto(
      el,
      h(
        'div',
        { class: 'session-switcher' },
        h('button', { class: ['session-pill', current ? 'remote' : 'local'], title: current ? current.command : localInfo?.home || '', onClick: () => ((open = !open), render()) }, h('span', { class: ['dot', current && stateClass(current)] }), label, ' ▾'),
        menu,
      ),
    );
  }

  document.addEventListener('click', (e) => {
    // The clicked node may have been re-rendered away already; only real outside clicks close the menu.
    if (open && e.target.isConnected && !el.contains(e.target)) {
      open = false;
      render();
    }
  });
  onLocalEvent((e) => e.type.startsWith('peer.') && refresh().catch(() => {}));
  onPeerChange(() => render());
  try {
    await refresh();
    // A remembered remote session: reopen it (or fall back to local if it is gone).
    const remembered = getPeer();
    if (remembered) {
      if (!peers.some((p) => p.id === remembered)) setPeer(null);
      else await rpcLocal('peers.connect', { id: remembered }).catch((err) => (showError(err), setPeer(null)));
      await refresh();
    }
  } catch (err) {
    showError(err);
  }
}
