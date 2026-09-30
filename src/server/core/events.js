/**
 * Process-wide event bus. Every domain change is published here and fanned out
 * to SSE clients, remote bridges and in-process listeners (scheduler, etc).
 *
 * Event shape: { seq, type, ts, payload }
 * `seq` starts from the boot timestamp so it keeps increasing across restarts.
 * Listeners are isolated: one throwing listener never fails the publisher
 * (the change it reports has already been committed).
 *
 * Two audiences:
 *   subscribe()     — local events only. Domain logic (runner, scheduler,
 *                     orchestrator) listens here, so events relayed from remote
 *                     peers can never act on local state.
 *   subscribeAll()  — local events + relayed peer events (tagged `peer`); used by
 *                     the SSE stream that feeds the UI.
 */
export class EventBus {
  constructor({ onListenerError = (err) => console.error('[todo-devs] event listener failed:', err) } = {}) {
    this.listeners = new Set();
    this.allListeners = new Set();
    this.seq = Date.now() * 1000;
    this.onListenerError = onListenerError;
  }

  /** @param {string} type e.g. "task.updated" @param {object} payload */
  publish(type, payload = {}) {
    const event = { seq: ++this.seq, type, ts: new Date().toISOString(), payload };
    this.deliver(this.listeners, event);
    this.deliver(this.allListeners, event);
    return event;
  }

  /** Relays an event from a remote peer to UI-facing subscribers only. */
  relay(event) {
    this.deliver(this.allListeners, event);
  }

  deliver(set, event) {
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }

  /** Local events. @param {(event: object) => void} listener @returns {() => void} unsubscribe */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Local + relayed peer events. */
  subscribeAll(listener) {
    this.allListeners.add(listener);
    return () => this.allListeners.delete(listener);
  }
}
