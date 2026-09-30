/**
 * Browser client for the single JSON-RPC surface. When a remote session
 * (peer) is selected every call and event subscription is scoped to it.
 */
const PEER_KEY = 'todo-devs.peer';
const TOKEN_KEY = 'todo-devs.token';
let currentPeer = localStorage.getItem(PEER_KEY) || null;
const listeners = new Set();
const localListeners = new Set();
const peerListeners = new Set();
let source = null;

// Access token (only needed when the server listens on the network). Obtained by
// redeeming a one-time pairing link (#pair=CODE); legacy ?token= / #token= links still work.
// It is kept for the tab only and removed from the address bar immediately.
const params = new URLSearchParams(location.search);
const hash = new URLSearchParams(location.hash.slice(1).includes('=') ? location.hash.slice(1) : '');
const linkToken = params.get('token') || hash.get('token');
if (linkToken) sessionStorage.setItem(TOKEN_KEY, linkToken);
const pairCode = hash.get('pair');
if (linkToken || pairCode) history.replaceState(null, '', location.pathname);
let token = sessionStorage.getItem(TOKEN_KEY);

/** Exchanges a pairing code for the token before anything else talks to the API. */
export const ready = (async () => {
  if (!pairCode) return;
  const res = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairCode }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(body.error || 'Pairing failed');
  token = body.token;
  sessionStorage.setItem(TOKEN_KEY, token);
})();

export class ApiError extends Error {
  constructor(error) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}

async function send(method, params, peer) {
  await ready.catch(() => {});
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-todo-devs-token': token } : {}) },
    body: JSON.stringify({ method, params, ...(peer ? { peer } : {}) }),
  });
  const body = await res.json().catch(() => ({ error: { code: res.status, message: res.statusText } }));
  if (body.error) throw new ApiError(typeof body.error === 'string' ? { code: res.status, message: body.error } : body.error);
  return body.result;
}

/** Calls the currently selected session (local or remote peer). */
export const rpc = (method, params = {}) => send(method, params, currentPeer);

/** Calls the local instance regardless of the selected peer. */
export const rpcLocal = (method, params = {}) => send(method, params, null);

function emit(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.error(err);
    }
  }
}

async function connect() {
  if (source) return;
  source = true; // reserve while pairing completes
  await ready.catch(() => {});
  source = new EventSource(`/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  let opened = false;
  source.onopen = () => {
    // After a reconnect we may have missed events: tell views to reload.
    if (opened) emit({ type: 'sync.reconnected', payload: {} });
    opened = true;
  };
  source.onmessage = (msg) => {
    let event;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (!event.peer) {
      for (const fn of localListeners) {
        try {
          fn(event);
        } catch (err) {
          console.error(err);
        }
      }
      // The active remote session (re)connected: events may have been missed, reload views.
      if (currentPeer && event.type === 'peer.status' && event.payload?.peerId === currentPeer && event.payload.state === 'connected') {
        emit({ type: 'sync.reconnected', payload: {} });
      }
    }
    // Events relayed from a remote session carry `peer`; show only the active session's events.
    if ((event.peer || null) !== currentPeer) return;
    emit(event);
  };
}

/** @param {(event: {type: string, payload: object}) => void} fn @returns unsubscribe */
export function onEvent(fn) {
  connect();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Events of the local instance only (e.g. peer connection status), whatever session is selected. */
export function onLocalEvent(fn) {
  connect();
  localListeners.add(fn);
  return () => localListeners.delete(fn);
}

export const getPeer = () => currentPeer;

export function setPeer(peerId) {
  currentPeer = peerId || null;
  if (currentPeer) localStorage.setItem(PEER_KEY, currentPeer);
  else localStorage.removeItem(PEER_KEY);
  for (const fn of peerListeners) fn(currentPeer);
}

export function onPeerChange(fn) {
  peerListeners.add(fn);
  return () => peerListeners.delete(fn);
}
