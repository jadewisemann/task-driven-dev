import * as SecureStore from 'expo-secure-store';

/** A paired todo.devs server. The token lives in the device keychain / keystore. */
export interface SavedServer {
  id: string;
  name: string;
  url: string;
  token: string;
  /** Last selected project and remote session on this server. */
  projectId?: string | null;
  peer?: string | null;
}

const SERVERS_KEY = 'todo-devs.servers';
const ACTIVE_KEY = 'todo-devs.active';

export async function loadServers(): Promise<{ servers: SavedServer[]; activeId: string | null }> {
  const [raw, activeId] = await Promise.all([SecureStore.getItemAsync(SERVERS_KEY), SecureStore.getItemAsync(ACTIVE_KEY)]);
  let servers: SavedServer[] = [];
  try {
    servers = raw ? (JSON.parse(raw) as SavedServer[]) : [];
  } catch {
    servers = [];
  }
  return { servers, activeId: servers.some((s) => s.id === activeId) ? activeId : servers[0]?.id ?? null };
}

export async function saveServers(servers: SavedServer[], activeId: string | null): Promise<void> {
  await SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(servers));
  if (activeId) await SecureStore.setItemAsync(ACTIVE_KEY, activeId);
  else await SecureStore.deleteItemAsync(ACTIVE_KEY);
}
