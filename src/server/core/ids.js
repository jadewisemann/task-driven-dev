import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijkmnopqrstuvwxyz';

/** Short, URL-safe, prefixed identifiers, e.g. `tsk_4f9k2m8q1z`. */
export function newId(prefix) {
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export const now = () => new Date().toISOString();
