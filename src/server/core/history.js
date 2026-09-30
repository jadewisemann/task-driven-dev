/**
 * Recent-event ring buffer backing the long-poll endpoint used by the mobile
 * app (React Native has no EventSource, and polling survives app suspension).
 *
 * Every event (local and relayed from peers) gets a local, strictly increasing
 * `cursor`; clients poll with `after=<cursor>` and receive what they missed.
 * If they fell behind the buffer, the response says `reset: true` and the
 * client reloads its state.
 */
export class EventHistory {
  constructor(bus, { capacity = 5000 } = {}) {
    this.capacity = capacity;
    this.entries = []; // {cursor, event}
    this.cursor = 0;
    this.waiters = new Set();
    this.unsubscribe = bus.subscribeAll((event) => this.push(event));
  }

  push(event) {
    const entry = { cursor: ++this.cursor, event };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    for (const waiter of [...this.waiters]) waiter();
  }

  /** @param {number} after @param {(event) => boolean} filter */
  since(after, filter, limit = 500) {
    const oldest = this.entries[0]?.cursor ?? this.cursor + 1;
    const reset = after > 0 && after < oldest - 1;
    const events = [];
    if (!reset) {
      for (const { cursor, event } of this.entries) {
        if (cursor <= after || !filter(event)) continue;
        events.push({ ...event, cursor });
        if (events.length >= limit) break;
      }
    }
    const next = events.length ? events[events.length - 1].cursor : this.cursor;
    return { events, cursor: reset ? this.cursor : Math.max(after, next), reset };
  }

  /**
   * Resolves with new matching events, or after `timeoutMs` with none.
   * `after = 0` means "start now": returns the current cursor immediately.
   */
  wait(after, filter, { timeoutMs = 25_000, signal } = {}) {
    if (after <= 0) return Promise.resolve({ events: [], cursor: this.cursor, reset: false });
    const first = this.since(after, filter);
    if (first.events.length || first.reset) return Promise.resolve(first);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener('abort', done);
        resolve(this.since(after, filter));
      };
      const check = () => {
        if (this.since(after, filter).events.length) done();
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(check);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  close() {
    this.unsubscribe();
    for (const waiter of [...this.waiters]) waiter();
  }
}
