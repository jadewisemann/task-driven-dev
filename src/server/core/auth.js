import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = (home) => join(home, 'auth.json');
const generate = () => randomBytes(24).toString('base64url');

/**
 * Access token for non-loopback access (mobile app, LAN / Tailscale browsers).
 * Persisted in <home>/auth.json (mode 0600) so paired devices survive restarts.
 */
export function loadOrCreateToken(home) {
  try {
    const { token } = JSON.parse(readFileSync(file(home), 'utf8'));
    if (typeof token === 'string' && token.length >= 20) return token;
  } catch {
    /* create below */
  }
  return rotateToken(home);
}

/** Replaces the token; every paired device must pair again (takes effect on the next server start). */
export function rotateToken(home) {
  const token = generate();
  writeFileSync(file(home), JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return token;
}

/** Constant-time comparison so the token can't be guessed byte by byte from response timing. */
export function tokenMatches(expected, given) {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
