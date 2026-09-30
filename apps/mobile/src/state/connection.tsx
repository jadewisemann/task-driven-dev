import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { createApi, type Api } from '../core/api.ts';
import { TodoDevsClient } from '../core/client.ts';
import { EventFeed, type FeedStatus } from '../core/events.ts';
import { serverLabel, type PairingRequest } from '../core/links.ts';
import type { Project } from '../core/types.ts';
import { loadServers, saveServers, type SavedServer } from './storage.ts';

interface ConnectionValue {
  ready: boolean;
  servers: SavedServer[];
  active: SavedServer | null;
  /** API bound to the active server and the selected session (peer). */
  api: Api | null;
  feed: EventFeed | null;
  feedStatus: FeedStatus;
  feedError?: string;
  projects: Project[];
  project: Project | null;
  selectProject: (id: string) => void;
  peer: string | null;
  selectPeer: (peerId: string | null) => Promise<void>;
  pair: (request: PairingRequest) => Promise<SavedServer>;
  switchServer: (id: string) => void;
  removeServer: (id: string) => Promise<void>;
  reloadProjects: () => Promise<void>;
}

const ConnectionContext = createContext<ConnectionValue | null>(null);

const newId = () => `srv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Holds the paired servers, the active connection (client + live event feed)
 * and the per-server selection of project and remote session.
 */
export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('stopped');
  const [feedError, setFeedError] = useState<string | undefined>();
  const serversRef = useRef(servers);
  serversRef.current = servers;

  useEffect(() => {
    loadServers()
      .then(({ servers: s, activeId: a }) => {
        setServers(s);
        setActiveId(a);
      })
      .finally(() => setReady(true));
  }, []);

  const persist = useCallback(async (next: SavedServer[], nextActive: string | null) => {
    setServers(next);
    setActiveId(nextActive);
    await saveServers(next, nextActive);
  }, []);

  const updateActive = useCallback(
    (patch: Partial<SavedServer>) => {
      const next = serversRef.current.map((s) => (s.id === activeId ? { ...s, ...patch } : s));
      void persist(next, activeId);
    },
    [activeId, persist],
  );

  const active = servers.find((s) => s.id === activeId) ?? null;
  const peer = active?.peer ?? null;

  const client = useMemo(() => (active ? new TodoDevsClient({ baseUrl: active.url, token: active.token }) : null), [active?.url, active?.token]);
  const api = useMemo(() => (client ? createApi(client, peer) : null), [client, peer]);
  const feed = useMemo(() => (client ? new EventFeed(client, { peer }) : null), [client, peer]);

  // Run the feed only while the app is in the foreground; resuming triggers a reset (reload).
  useEffect(() => {
    if (!feed) return;
    const offStatus = feed.onStatus((status, error) => {
      setFeedStatus(status);
      setFeedError(error);
    });
    feed.start();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') feed.start();
      else if (state === 'background') feed.stop();
    });
    return () => {
      sub.remove();
      offStatus();
      feed.stop();
    };
  }, [feed]);

  const reloadProjects = useCallback(async () => {
    if (!api) return setProjects([]);
    try {
      setProjects(await api.projects.list());
    } catch {
      setProjects([]);
    }
  }, [api]);

  useEffect(() => {
    void reloadProjects();
    if (!feed) return;
    return feed.onReset(() => void reloadProjects());
  }, [feed, reloadProjects]);

  const project = projects.find((p) => p.id === active?.projectId) ?? projects[0] ?? null;

  const value: ConnectionValue = {
    ready,
    servers,
    active,
    api,
    feed,
    feedStatus,
    feedError,
    projects,
    project,
    peer,
    selectProject: (id) => updateActive({ projectId: id }),
    async selectPeer(peerId) {
      if (peerId && api) await api.peers.connect(peerId); // opens the SSH session first; throws if unreachable
      updateActive({ peer: peerId, projectId: null });
    },
    async pair(request) {
      const token = await TodoDevsClient.pair(request.url, request.code);
      const existing = serversRef.current.find((s) => s.url === request.url);
      const server: SavedServer = existing ? { ...existing, token } : { id: newId(), name: serverLabel(request.url, request.name), url: request.url, token, projectId: null, peer: null };
      const next = existing ? serversRef.current.map((s) => (s.id === existing.id ? server : s)) : [...serversRef.current, server];
      await persist(next, server.id);
      return server;
    },
    switchServer: (id) => void persist(serversRef.current, id),
    async removeServer(id) {
      const next = serversRef.current.filter((s) => s.id !== id);
      await persist(next, activeId === id ? next[0]?.id ?? null : activeId);
    },
    reloadProjects,
  };

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection must be used inside <ConnectionProvider>');
  return ctx;
}

/** For screens that only render when connected (the tab layout guarantees it). */
export function useSession() {
  const ctx = useConnection();
  if (!ctx.api || !ctx.feed || !ctx.active) throw new Error('No active server');
  return { ...ctx, api: ctx.api, feed: ctx.feed, active: ctx.active };
}
