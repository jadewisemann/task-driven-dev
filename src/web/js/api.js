/**
 * Browser client for the single JSON-RPC surface. When a remote session
 * (peer) is selected every call and event subscription is scoped to it.
 */
const PEER_KEY = 'todo-devs.peer';
let currentPeer = localStorage.getItem(PEER_KEY) || null;
const listeners = new Set();
const peerListeners = new Set();
let source = null;

export class ApiError extends Error {
  constructor(error) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}

export async function rpc(method, params = {}) {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params, ...(currentPeer ? { peer: currentPeer } : {}) }),
  });
  const body = await res.json().catch(() => ({ error: { code: res.status, message: res.statusText } }));
  if (body.error) throw new ApiError(typeof body.error === 'string' ? { code: res.status, message: body.error } : body.error);
  return body.result;
}

/** Call against the local instance regardless of the selected peer. */
export async function rpcLocal(method, params = {}) {
  const saved = currentPeer;
  currentPeer = null;
  try {
    return await rpc(method, params);
  } finally {
    currentPeer = saved;
  }
}

function connect() {
  if (source) return;
  source = new EventSource('/api/events');
  source.onmessage = (msg) => {
    let event;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }
    // Events relayed from a remote session carry `peer`; show only the active session's events.
    if ((event.peer || null) !== currentPeer) return;
    for (const fn of listeners) fn(event);
  };
}

/** @param {(event: {type: string, payload: object}) => void} fn @returns unsubscribe */
export function onEvent(fn) {
  connect();
  listeners.add(fn);
  return () => listeners.delete(fn);
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
