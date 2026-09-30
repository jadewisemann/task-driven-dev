import { normalizeBaseUrl } from './client.ts';

export interface PairingRequest {
  url: string;
  code: string;
  name?: string;
}

const CODE = /^[A-Z2-9]{10}$/;

/** Upper-cases and strips separators users may type ("abcde-fghjk"). */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const isValidCode = (code: string) => CODE.test(normalizeCode(code));

/**
 * Parses what `todo-devs pair` prints, pasted or opened as a deep link:
 *   todo-devs://pair?url=http%3A%2F%2F100.64.0.2%3A7420&code=ABCDEFGHJK&name=box
 *   http://100.64.0.2:7420/#pair=ABCDEFGHJK   (the browser link also works)
 * Returns null when the text is not a pairing link.
 */
export function parsePairingLink(text: string): PairingRequest | null {
  const raw = text.trim();
  try {
    if (raw.startsWith('todo-devs://')) {
      const q = new URL(raw.replace(/^todo-devs:\/\//, 'http://x/')).searchParams;
      const url = q.get('url');
      const code = q.get('code');
      if (!url || !code) return null;
      return { url: normalizeBaseUrl(url), code: normalizeCode(code), name: q.get('name') || undefined };
    }
    if (/^https?:\/\//i.test(raw) && raw.includes('#pair=')) {
      const [base, hash] = raw.split('#');
      const code = new URLSearchParams(hash).get('pair');
      if (!code) return null;
      return { url: normalizeBaseUrl(base), code: normalizeCode(code) };
    }
  } catch {
    return null;
  }
  return null;
}

/** Friendly default name for a server: explicit name, else its host. */
export function serverLabel(url: string, name?: string): string {
  if (name) return name;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
