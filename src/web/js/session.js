import { rpcLocal } from './api.js';
import { h, mountInto } from './dom.js';

/**
 * Top-bar session indicator. Shows the local host; the remote feature extends
 * this into a switcher across SSH peers.
 */
export async function sessionSlot(el, { showError }) {
  try {
    const info = await rpcLocal('system.info');
    mountInto(el, h('span', { class: 'session-pill local', title: info.home || '' }, h('span', { class: 'dot' }), `local · ${info.host}`));
  } catch (err) {
    showError(err);
  }
}
