import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = (home) => join(home, 'auth.json');
const generate = () => randomBytes(24).toString('base64url');

/**
 * Access token for non-loopback access (mobile app, LAN / Tailscale browsers).
 * Persisted in <home>/auth.json (mode 0600) so paired devices survive restarts.
 * Only a missing file creates a new token; a corrupt/unreadable file is an error
 * (silently rotating would unpair every device).
 */
export function loadOrCreateToken(home) {
  let raw;
  try {
    raw = readFileSync(file(home), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return rotateToken(home);
    throw new Error(`cannot read ${file(home)}: ${err.message}`);
  }
  let token;
  try {
    ({ token } = JSON.parse(raw));
  } catch {
    throw new Error(`${file(home)} is corrupt — fix it or run \`todo-devs token rotate\``);
  }
  if (typeof token !== 'string' || token.length < 20) throw new Error(`${file(home)} has no valid token — run \`todo-devs token rotate\``);
  chmodSync(file(home), 0o600); // tighten permissions of files created by hand
  return token;
}

/** Replaces the token atomically; paired devices must pair again (takes effect on the next server start). */
export function rotateToken(home) {
  const token = generate();
  const tmp = `${file(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file(home));
  return token;
}

/** Constant-time comparison so the token can't be guessed byte by byte from response timing. */
export function tokenMatches(expected, given) {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * One-time pairing codes. Pairing links carry a short-lived code instead of
 * the long-lived token, so a link that leaks (chat history, another app
 * claiming the URL scheme, shoulder surfing) is useless after 10 minutes or
 * after the phone redeemed it. Redemption is rate limited.
 */
export class PairingCodes {
  constructor(token) {
    this.token = token;
    this.codes = new Map(); // code -> expiresAt
    this.attempts = [];
  }

  create() {
    this.prune();
    let code = '';
    for (let i = 0; i < 10; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    this.codes.set(code, Date.now() + CODE_TTL_MS);
    return { code, expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString() };
  }

  /** @returns {string|null} the access token, once, for a valid code */
  redeem(code) {
    const now = Date.now();
    this.attempts = this.attempts.filter((t) => now - t < 60_000);
    if (this.attempts.length >= 10) throw Object.assign(new Error('Too many pairing attempts, wait a minute'), { status: 429 });
    this.attempts.push(now);
    this.prune();
    const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!this.codes.has(normalized)) return null;
    this.codes.delete(normalized);
    return this.token;
  }

  prune() {
    const now = Date.now();
    for (const [c, exp] of this.codes) if (exp < now) this.codes.delete(c);
  }
}
