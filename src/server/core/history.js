/**
 * Recent-event ring buffer backing the long-poll endpoint used by the mobile
 * app (React Native has no EventSource, and polling survives app suspension).
 *
 * Every event (local and relayed from peers) gets a local, strictly increasing
 * `cursor`. Cursors are seeded from the boot time, so they keep increasing
 * across restarts, and each response carries the process `epoch`. Clients poll
 * with `after=<cursor>` and receive what they missed; if they fell behind the
 * buffer or hold a cursor from another process (`after` ahead of the server),
 * the response says `reset: true` and the client reloads its state.
 *
 * Protocol for clients: take the cursor from `after=0` FIRST, then load state
 * over RPC, then poll from that cursor — nothing between the two is lost.
 */
export class EventHistory {
  constructor(bus, { capacity = 5000, maxBytes = 8 * 1024 * 1024, maxResponseBytes = 1024 * 1024 } = {}) {
    this.capacity = capacity;
    this.maxBytes = maxBytes;
    this.maxResponseBytes = maxResponseBytes;
    this.entries = []; // {cursor, event, size}; cursors are contiguous
    this.bytes = 0;
    this.epoch = Date.now();
    this.cursor = this.epoch * 1000;
    this.waiters = new Set(); // {filter, done}
    this.unsubscribe = bus.subscribeAll((event) => this.push(event));
  }

  push(event) {
    const size = JSON.stringify(event).length;
    const entry = { cursor: ++this.cursor, event, size };
    this.entries.push(entry);
    this.bytes += size;
    while (this.entries.length > this.capacity || (this.bytes > this.maxBytes && this.entries.length > 1)) {
      this.bytes -= this.entries.shift().size;
    }
    // Only the new entry can wake a waiter; no rescans.
    for (const waiter of [...this.waiters]) if (waiter.filter(event)) waiter.done();
  }

  /** @param {number} after @param {(event) => boolean} filter */
  since(after, filter, limit = 500) {
    const oldest = this.entries[0]?.cursor ?? this.cursor + 1;
    // Reset when the cursor is from another process (before this boot, or ahead of us) or older than the buffer.
    const reset = after < this.epoch * 1000 || after > this.cursor || (after < oldest - 1 && this.entries.length > 0);
    const base = { epoch: this.epoch, reset };
    if (reset) return { ...base, events: [], cursor: this.cursor };
    const events = [];
    let bytes = 0;
    let last = after;
    for (let i = Math.max(0, after - oldest + 1); i < this.entries.length; i++) {
      const { cursor, event, size } = this.entries[i];
      if (events.length >= limit || (events.length > 0 && bytes + size > this.maxResponseBytes)) break;
      last = cursor; // advance past non-matching entries too
      if (!filter(event)) continue;
      events.push({ ...event, cursor });
      bytes += size;
    }
    return { ...base, events, cursor: Math.max(after, last) };
  }

  /**
   * Resolves with new matching events, or after `timeoutMs` with none.
   * `after = 0` means "start now": returns the current cursor immediately.
   */
  wait(after, filter, { timeoutMs = 25_000, signal } = {}) {
    if (after <= 0) return Promise.resolve({ epoch: this.epoch, events: [], cursor: this.cursor, reset: false });
    const first = this.since(after, filter);
    if (first.events.length || first.reset) return Promise.resolve(first);
    return new Promise((resolve) => {
      const waiter = {
        filter,
        done: () => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          signal?.removeEventListener('abort', waiter.done);
          resolve(this.since(after, filter));
        },
      };
      const timer = setTimeout(waiter.done, timeoutMs);
      this.waiters.add(waiter);
      signal?.addEventListener('abort', waiter.done, { once: true });
    });
  }

  close() {
    this.unsubscribe();
    for (const waiter of [...this.waiters]) waiter.done();
  }
}
