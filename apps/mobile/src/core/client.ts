import type { PollResponse } from './types.ts';

type FetchFn = typeof fetch;

export class ApiError extends Error {
  code: number;
  data?: unknown;
  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.data = data;
  }
}

/** Codes the app treats specially. */
export const UNAUTHORIZED = 401;
export const NETWORK = -1;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Normalises what a user typed ("192.168.0.5", "box.ts.net:7420", "http://host:7420/path")
 * into "http://host:port". Implemented without URL setters (Hermes' URL support varies).
 */
export function normalizeBaseUrl(input: string): string {
  const m = input.trim().match(/^(?:(https?):\/\/)?(\[[0-9a-f:.]+\]|[^/:?#\s]+)(?::(\d{1,5}))?(?:[/?#].*)?$/i);
  if (!m) throw new Error(`Not a server address: ${input}`);
  const scheme = (m[1] || 'http').toLowerCase();
  const port = m[3] ? `:${m[3]}` : scheme === 'http' ? ':7420' : '';
  return `${scheme}://${m[2]!.toLowerCase()}${port}`;
}

async function withTimeout<T>(ms: number, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (controller.signal.aborted && !signal?.aborted) throw new ApiError('Request timed out', NETWORK);
    if (err instanceof ApiError) throw err;
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError(`Cannot reach the server (${(err as Error)?.message || err})`, NETWORK);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Minimal client for one todo.devs server in network mode.
 * - RPC:   POST /api/rpc {method, params, peer?} with the x-todo-devs-token header
 * - Events: GET /api/events/poll (long-poll)
 * - Pairing: POST /api/pair {code} -> {token}
 */
export class TodoDevsClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchFn;

  constructor({ baseUrl, token, fetchFn }: { baseUrl: string; token: string; fetchFn?: FetchFn }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
    this.fetchFn = fetchFn || fetch;
  }

  /** Exchanges a one-time pairing code (from `todo-devs pair`) for the server's access token. */
  static async pair(baseUrl: string, code: string, fetchFn: FetchFn = fetch): Promise<string> {
    const url = `${normalizeBaseUrl(baseUrl)}/api/pair`;
    return withTimeout(DEFAULT_TIMEOUT_MS, undefined, async (signal) => {
      const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }), signal });
      const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !body.token) throw new ApiError(body.error || `Pairing failed (HTTP ${res.status})`, res.status);
      return body.token;
    });
  }

  async rpc<T>(method: string, params: Record<string, unknown> = {}, { peer, signal, timeoutMs = DEFAULT_TIMEOUT_MS }: { peer?: string | null; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    return withTimeout(timeoutMs, signal, async (s) => {
      const res = await this.fetchFn(`${this.baseUrl}/api/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-todo-devs-token': this.token },
        body: JSON.stringify({ method, params, ...(peer ? { peer } : {}) }),
        signal: s,
      });
      const body = (await res.json().catch(() => null)) as { result?: T; error?: string | { code: number; message: string; data?: unknown } } | null;
      if (!body) throw new ApiError(`Unexpected response (HTTP ${res.status})`, res.status);
      if (body.error !== undefined) {
        if (typeof body.error === 'string') throw new ApiError(body.error, res.status);
        throw new ApiError(body.error.message, body.error.code, body.error.data);
      }
      return body.result as T;
    });
  }

  /** Long-poll. `after = 0` returns the current cursor immediately. */
  async poll(after: number, { timeoutSec = 25, peer, signal }: { timeoutSec?: number; peer?: string | null; signal?: AbortSignal } = {}): Promise<PollResponse> {
    const qs = new URLSearchParams({ after: String(after), timeout: String(timeoutSec) });
    if (peer) qs.set('peer', peer);
    return withTimeout((timeoutSec + 15) * 1000, signal, async (s) => {
      const res = await this.fetchFn(`${this.baseUrl}/api/events/poll?${qs}`, { headers: { 'x-todo-devs-token': this.token }, signal: s });
      const body = (await res.json().catch(() => null)) as (PollResponse & { error?: string }) | null;
      if (!res.ok || !body || body.error) throw new ApiError(body?.error || `Poll failed (HTTP ${res.status})`, res.status);
      return body;
    });
  }
}
