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

// Access token (only needed when the server binds outside loopback): ?token=... once, then kept for the tab.
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  sessionStorage.setItem(TOKEN_KEY, urlToken);
  history.replaceState(null, '', location.pathname + location.hash);
}
const token = sessionStorage.getItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(error) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}

async function send(method, params, peer) {
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

function connect() {
  if (source) return;
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
    if (!event.peer) for (const fn of localListeners) fn(event);
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
