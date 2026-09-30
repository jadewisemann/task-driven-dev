/**
 * Process-wide event bus. Every domain change is published here and fanned out
 * to SSE clients, remote bridges and in-process listeners (scheduler, etc).
 *
 * Event shape: { seq, type, ts, payload }
 * `seq` starts from the boot timestamp so it keeps increasing across restarts.
 * Listeners are isolated: one throwing listener never fails the publisher
 * (the change it reports has already been committed).
 */
export class EventBus {
  constructor({ onListenerError = (err) => console.error('[todo-devs] event listener failed:', err) } = {}) {
    this.listeners = new Set();
    this.seq = Date.now() * 1000;
    this.onListenerError = onListenerError;
  }

  /** @param {string} type e.g. "task.updated" @param {object} payload */
  publish(type, payload = {}) {
    const event = { seq: ++this.seq, type, ts: new Date().toISOString(), payload };
    this.forward(event);
    return event;
  }

  /** Re-emits an event that originated elsewhere (e.g. a remote peer) without touching it. */
  forward(event) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }

  /** @param {(event: object) => void} listener @returns {() => void} unsubscribe */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
