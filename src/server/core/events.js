import { EventEmitter } from 'node:events';

/**
 * Process-wide event bus. Every domain change is published here and fanned out
 * to SSE clients, remote bridges and in-process listeners (scheduler, etc).
 *
 * Event shape: { seq, type, ts, payload }
 */
export class EventBus {
  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
    this.seq = 0;
  }

  /** @param {string} type e.g. "task.updated" @param {object} payload */
  publish(type, payload = {}) {
    const event = { seq: ++this.seq, type, ts: new Date().toISOString(), payload };
    this.emitter.emit('event', event);
    return event;
  }

  /** Re-emits an event that originated elsewhere (e.g. a remote peer) without touching it. */
  forward(event) {
    this.emitter.emit('event', event);
  }

  /** @param {(event: object) => void} listener @returns {() => void} unsubscribe */
  subscribe(listener) {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
