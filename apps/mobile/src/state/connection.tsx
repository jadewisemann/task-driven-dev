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
  /** False until the active session's project list has loaded (after a switch too). */
  projectsReady: boolean;
  project: Project | null;
  selectProject: (id: string) => Promise<void>;
  peer: string | null;
  selectPeer: (peerId: string | null) => Promise<void>;
  pair: (request: PairingRequest) => Promise<SavedServer>;
  switchServer: (id: string) => Promise<void>;
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
  const [projectsReady, setProjectsReady] = useState(false);
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('stopped');
  const [feedError, setFeedError] = useState<string | undefined>();
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  useEffect(() => {
    loadServers()
      .then(({ servers: s, activeId: a }) => {
        setServers(s);
        setActiveId(a);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  /** Writes to the keychain first; memory only changes once the write succeeded. */
  const persist = useCallback(async (next: SavedServer[], nextActive: string | null) => {
    await saveServers(next, nextActive, serversRef.current);
    serversRef.current = next;
    activeRef.current = nextActive;
    setServers(next);
    setActiveId(nextActive);
  }, []);

  const updateActive = useCallback(
    (patch: Partial<SavedServer>) => persist(serversRef.current.map((s) => (s.id === activeRef.current ? { ...s, ...patch } : s)), activeRef.current),
    [persist],
  );

  const active = servers.find((s) => s.id === activeId) ?? null;
  const peer = active?.peer ?? null;

  const client = useMemo(() => (active ? new TodoDevsClient({ baseUrl: active.url, token: active.token }) : null), [active?.url, active?.token]);
  const api = useMemo(() => (client ? createApi(client, peer) : null), [client, peer]);
  const feed = useMemo(() => (client ? new EventFeed(client, { peer }) : null), [client, peer]);

  // Run the feed only in the foreground. Only a real return from the background restarts it
  // (iOS also reports inactive -> active for Control Center, Face ID, app switcher peeks).
  useEffect(() => {
    if (!feed) return;
    const offStatus = feed.onStatus((status, error) => {
      setFeedStatus(status);
      setFeedError(error);
    });
    feed.start();
    let previous = AppState.currentState;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && previous === 'background') feed.start();
      else if (state === 'background') feed.stop();
      previous = state;
    });
    return () => {
      sub.remove();
      offStatus();
      feed.stop();
    };
  }, [feed]);

  // The remote session disappeared on the server: fall back to the server's own session.
  useEffect(() => {
    if (feedStatus === 'gone' && peer) void updateActive({ peer: null, projectId: null });
  }, [feedStatus, peer, updateActive]);

  const projectSeq = useRef(0);
  const reloadProjects = useCallback(async () => {
    const mine = ++projectSeq.current;
    if (!api) {
      setProjects([]);
      setProjectsReady(false);
      return;
    }
    try {
      const list = await api.projects.list();
      if (mine === projectSeq.current) {
        setProjects(list);
        setProjectsReady(true);
      }
    } catch {
      if (mine === projectSeq.current) setProjectsReady(true); // screens show the feed banner / errors
    }
  }, [api]);

  useEffect(() => {
    // New session: never let screens query it with the previous session's project.
    setProjects([]);
    setProjectsReady(false);
    void reloadProjects();
    if (!feed) return;
    return feed.onReset(() => void reloadProjects());
  }, [feed, reloadProjects]);

  const project = projects.find((p) => p.id === active?.projectId) ?? projects[0] ?? null;

  const selectProject = useCallback((id: string) => updateActive({ projectId: id }), [updateActive]);
  const selectPeer = useCallback(
    async (peerId: string | null) => {
      if (peerId && api) await api.peers.connect(peerId); // opens the SSH session first; throws if unreachable
      await updateActive({ peer: peerId, projectId: null });
    },
    [api, updateActive],
  );
  const pair = useCallback(
    async (request: PairingRequest) => {
      const token = await TodoDevsClient.pair(request.url, request.code);
      const existing = serversRef.current.find((s) => s.url === request.url);
      const server: SavedServer = existing ? { ...existing, token } : { id: newId(), name: serverLabel(request.url, request.name), url: request.url, token, projectId: null, peer: null };
      const next = existing ? serversRef.current.map((s) => (s.id === existing.id ? server : s)) : [...serversRef.current, server];
      await persist(next, server.id);
      return server;
    },
    [persist],
  );
  const switchServer = useCallback((id: string) => persist(serversRef.current, id), [persist]);
  const removeServer = useCallback(
    async (id: string) => {
      const next = serversRef.current.filter((s) => s.id !== id);
      await persist(next, activeRef.current === id ? next[0]?.id ?? null : activeRef.current);
    },
    [persist],
  );

  const value = useMemo<ConnectionValue>(
    () => ({ ready, servers, active, api, feed, feedStatus, feedError, projects, projectsReady, project, selectProject, peer, selectPeer, pair, switchServer, removeServer, reloadProjects }),
    [ready, servers, active, api, feed, feedStatus, feedError, projects, projectsReady, project, selectProject, peer, selectPeer, pair, switchServer, removeServer, reloadProjects],
  );
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection must be used inside <ConnectionProvider>');
  return ctx;
}

/** For screens rendered inside <RequireSession> (tabs and detail routes). */
export function useSession() {
  const ctx = useConnection();
  if (!ctx.api || !ctx.feed || !ctx.active) throw new Error('No active server');
  return { ...ctx, api: ctx.api, feed: ctx.feed, active: ctx.active };
}
