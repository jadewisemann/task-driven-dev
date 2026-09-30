import { useCallback, useEffect, useRef, useState } from 'react';
import { affects } from '../core/events.ts';
import type { ServerEvent } from '../core/types.ts';
import { useSession } from './connection.tsx';

/**
 * Loads data and keeps it fresh: reloads on feed resets (reconnect, server
 * restart, app resume) and — debounced — on events that `match`.
 *
 *   const { data, error, refreshing, refresh } = useLive((api) => api.tasks.list(pid), [pid]);
 */
export function useLive<T>(load: (api: ReturnType<typeof useSession>['api']) => Promise<T>, deps: unknown[], { match = (e: ServerEvent) => affects(e), debounceMs = 250 }: { match?: (e: ServerEvent) => boolean; debounceMs?: number } = {}) {
  const { api, feed } = useSession();
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const matchRef = useRef(match);
  matchRef.current = match;

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
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
    void refresh();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const offEvents = feed.subscribe((e) => {
      if (!matchRef.current(e)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), debounceMs);
    });
    const offReset = feed.onReset(() => void refresh());
    return () => {
      if (timer) clearTimeout(timer);
      offEvents();
      offReset();
    };
  }, [feed, refresh, debounceMs]);

  return { data, error, refreshing, refresh: pull, reload: refresh };
}
