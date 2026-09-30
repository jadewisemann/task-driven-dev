import { ApiError, UNAUTHORIZED, type TodoDevsClient } from './client.ts';
import type { ServerEvent } from './types.ts';

/** `gone`: the remote session (peer) no longer exists on the server — terminal, pick another session. */
export type FeedStatus = 'connecting' | 'live' | 'offline' | 'unauthorized' | 'gone' | 'stopped';

type Listener = (event: ServerEvent) => void;
type ResetListener = () => void;
type StatusListener = (status: FeedStatus, error?: string) => void;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Live event feed over the long-poll endpoint.
 *
 * Contract with consumers:
 *  - `onReset` fires whenever local state may be stale (first connect, server
 *    restart, fell behind the buffer, reconnect after being offline) — reload then.
 *  - `subscribe` receives every event after that point, in order.
 * The cursor is always taken *before* the reset is announced, so nothing that
 * happens while consumers reload is lost.
 */
export class EventFeed {
  private readonly client: TodoDevsClient;
  private readonly peer: string | null;
  private listeners = new Set<Listener>();
  private resetListeners = new Set<ResetListener>();
  private statusListeners = new Set<StatusListener>();
  private controller: AbortController | null = null;
  private cursor = 0;
  private epoch = 0;
  status: FeedStatus = 'stopped';
  pollTimeoutSec: number;

  constructor(client: TodoDevsClient, { peer = null, pollTimeoutSec = 25 }: { peer?: string | null; pollTimeoutSec?: number } = {}) {
    this.client = client;
    this.peer = peer;
    this.pollTimeoutSec = pollTimeoutSec;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  onReset(fn: ResetListener) {
    this.resetListeners.add(fn);
    return () => void this.resetListeners.delete(fn);
  }

  onStatus(fn: StatusListener) {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => void this.statusListeners.delete(fn);
  }

  private setStatus(status: FeedStatus, error?: string) {
    if (status === this.status && !error) return;
    this.status = status;
    for (const fn of this.statusListeners) fn(status, error);
  }

  private emitReset() {
    for (const fn of this.resetListeners) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
  }

  /** Starts (or restarts, e.g. when the app returns to the foreground) the poll loop. */
  start() {
    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    void this.loop(controller.signal);
  }

  stop() {
    this.controller?.abort();
    this.controller = null;
    this.setStatus('stopped');
  }

  private async loop(signal: AbortSignal) {
    let backoff = 1000;
    let needsSync = true;
    this.setStatus('connecting');
    while (!signal.aborted) {
      try {
        if (needsSync) {
          const head = await this.client.poll(0, { peer: this.peer, signal });
          this.cursor = head.cursor;
          this.epoch = head.epoch;
          needsSync = false;
          this.setStatus('live');
          this.emitReset();
        }
        const res = await this.client.poll(this.cursor, { timeoutSec: this.pollTimeoutSec, peer: this.peer, signal });
        if (signal.aborted) return;
        backoff = 1000;
        if (res.reset || res.epoch !== this.epoch) {
          needsSync = true;
          continue;
        }
        this.cursor = res.cursor;
        this.setStatus('live');
        for (const event of res.events) {
          for (const fn of this.listeners) {
            try {
              fn(event);
            } catch (err) {
              console.error(err);
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof ApiError && err.code === UNAUTHORIZED) {
          this.setStatus('unauthorized', err.message);
          return; // the token was rotated: the user has to pair again
        }
        if (err instanceof ApiError && err.code === 404) {
          this.setStatus('gone', err.message);
          return; // e.g. the peer was removed on the server; retrying cannot help
        }
        this.setStatus('offline', (err as Error).message);
        needsSync = true; // we may have missed events
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }
}

/** Event-type prefixes that can change what a screen shows. */
export const REFRESH_PREFIXES = ['task.', 'agent.', 'plan.', 'scheduler.', 'run.started', 'run.finished', 'project.', 'workflow.run.', 'sync.'];

export const affects = (event: ServerEvent, prefixes: string[] = REFRESH_PREFIXES) => prefixes.some((p) => event.type.startsWith(p));
