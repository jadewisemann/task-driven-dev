import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../core/api.ts';
import { affects } from '../core/events.ts';
import type { ServerEvent } from '../core/types.ts';
import { useSession } from './connection.tsx';

interface LiveOptions {
  /** Which events trigger a (debounced) reload. */
  match?: (e: ServerEvent) => boolean;
  debounceMs?: number;
  /** Also reload periodically (for data whose events this feed cannot see, e.g. peer status). */
  intervalMs?: number;
}

/**
 * Loads data and keeps it fresh: reloads on feed resets (reconnect, server
 * restart, app resume), on matching events (debounced) and optionally on an interval.
 *
 *   const { data, error, refreshing, refresh } = useLive((api) => api.tasks.list(pid), [pid]);
 */
export function useLive<T>(load: (api: Api) => Promise<T>, deps: unknown[], { match = (e: ServerEvent) => affects(e), debounceMs = 250, intervalMs }: LiveOptions = {}) {
  const { api, feed } = useSession();
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);
  const lastLoad = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const matchRef = useRef(match);
  matchRef.current = match;

  const refresh = useCallback(async () => {
    const mine = ++seq.current; // only the newest request may update state
    lastLoad.current = Date.now();
    try {
      const value = await loadRef.current(api);
      if (mine === seq.current) {
        setData(value);
        setError(null);
      }
    } catch (err) {
      if (mine === seq.current) setError(err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, ...deps]);

  const pull = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    void refresh();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const offEvents = feed.subscribe((e) => {
      if (!matchRef.current(e)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), debounceMs);
    });
    // The feed's first reset usually arrives right after mount: skip it if we just loaded.
    const offReset = feed.onReset(() => {
      if (Date.now() - lastLoad.current > 1000) void refresh();
    });
    const interval = intervalMs ? setInterval(() => alive && void refresh(), intervalMs) : null;
    return () => {
      alive = false;
      seq.current++; // drop responses that arrive after unmount / deps change
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      offEvents();
      offReset();
    };
  }, [feed, refresh, debounceMs, intervalMs]);

  return { data, error, refreshing, refresh: pull, reload: refresh };
}
