import * as SecureStore from 'expo-secure-store';

/** A paired todo.devs server. The token lives in the device keychain / keystore under its own key. */
export interface SavedServer {
  id: string;
  name: string;
  url: string;
  token: string;
  /** Last selected project and remote session on this server. */
  projectId?: string | null;
  peer?: string | null;
}

type ServerMeta = Omit<SavedServer, 'token'>;

// SecureStore values should stay small (~2 KB on some platforms): metadata in one
// list, each token under its own key.
const LIST_KEY = 'todo-devs.servers.v2';
const ACTIVE_KEY = 'todo-devs.active';
const tokenKey = (id: string) => `todo-devs.token.${id}`;

export async function loadServers(): Promise<{ servers: SavedServer[]; activeId: string | null }> {
  const [raw, activeId] = await Promise.all([SecureStore.getItemAsync(LIST_KEY), SecureStore.getItemAsync(ACTIVE_KEY)]);
  let metas: ServerMeta[] = [];
  try {
    metas = raw ? (JSON.parse(raw) as ServerMeta[]) : [];
  } catch {
    metas = [];
  }
  const servers: SavedServer[] = [];
  for (const meta of metas) {
    const token = await SecureStore.getItemAsync(tokenKey(meta.id));
    if (token) servers.push({ ...meta, token });
  }
  return { servers, activeId: servers.some((s) => s.id === activeId) ? activeId : servers[0]?.id ?? null };
}

/** Writes everything; tokens of removed servers are deleted. Throws if the keychain write fails. */
export async function saveServers(servers: SavedServer[], activeId: string | null, previous: SavedServer[] = []): Promise<void> {
  for (const s of servers) {
    const before = previous.find((p) => p.id === s.id);
    if (!before || before.token !== s.token) await SecureStore.setItemAsync(tokenKey(s.id), s.token);
  }
  for (const p of previous) if (!servers.some((s) => s.id === p.id)) await SecureStore.deleteItemAsync(tokenKey(p.id));
  const metas: ServerMeta[] = servers.map(({ token: _token, ...meta }) => meta);
  await SecureStore.setItemAsync(LIST_KEY, JSON.stringify(metas));
  if (activeId) await SecureStore.setItemAsync(ACTIVE_KEY, activeId);
  else await SecureStore.deleteItemAsync(ACTIVE_KEY);
}
