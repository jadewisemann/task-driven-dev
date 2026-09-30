import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, fsyncSync, closeSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Database, openReadOnly } from '../server/core/db.js';
import { migrations } from '../server/core/migrations.js';
import { dbPath, openHolders, readDaemonInfo } from '../server/core/paths.js';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * Consistent snapshot of the database (safe while the server runs: VACUUM INTO
 * reads a single transaction). Written 0600 — it holds prompts and run output.
 * The access token (auth.json) is not included.
 */
export function backup(home, out) {
  const current = dbPath(home);
  if (!existsSync(current)) throw new Error(`No database at ${current} yet — nothing to back up`);
  const target = resolve(out || join(home, 'backups', `todo-devs-${stamp()}.db`));
  if (existsSync(target)) throw new Error(`${target} already exists`);
  mkdirSync(dirname(target), { recursive: true });
  const db = new Database(current);
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  chmodSync(target, 0o600);
  return { file: target, bytes: statSync(target).size };
}

/** Checks a backup without modifying it (read-only open). Returns its migration ids. */
function inspect(source) {
  let db;
  try {
    db = openReadOnly(source);
  } catch (err) {
    throw new Error(`${source} is not a SQLite database (${err.message})`);
  }
  try {
    let ok;
    try {
      ok = Object.values(db.prepare('PRAGMA integrity_check').get())[0] === 'ok';
    } catch (err) {
      throw new Error(`${source} is not a SQLite database (${err.message})`);
    }
    if (!ok) throw new Error(`${source} is damaged (integrity check failed)`);
    if (!db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'tasks'").get()) throw new Error(`${source} is not a todo.devs database`);
    const hasMigrations = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'schema_migrations'").get();
    return hasMigrations ? db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id) : [];
  } finally {
    db.close();
  }
}

/**
 * Replaces the database with a backup, atomically: the backup is copied next
 * to the database first, and only then swapped in. The current database (with
 * its -wal/-shm) is kept as *.before-restore-<time>.
 */
export function restore(home, file, { force = false } = {}) {
  if (readDaemonInfo(home)) throw new Error('Stop the server first (todo-devs service uninstall, or Ctrl+C on `todo-devs serve`)');
  const holders = openHolders(home);
  if (holders.length) throw new Error(`The database is in use by process ${holders.join(', ')} (a CLI command or remote session). Wait for it to finish.`);
  const source = resolve(file);
  const current = dbPath(home);
  if (!existsSync(source)) throw new Error(`${source} not found`);
  if (source === resolve(current)) throw new Error('That is the live database itself');
  const known = new Set(migrations.map((m) => m.id));
  const unknown = inspect(source).filter((id) => !known.has(id));
  if (unknown.length && !force) throw new Error(`${source} comes from a newer todo.devs (schema ${unknown.join(', ')}). Upgrade first, or pass --force.`);

  const staged = `${current}.restore-tmp`;
  copyFileSync(source, staged);
  const fd = openSync(staged, 'r');
  fsyncSync(fd);
  closeSync(fd);
  const kept = `${current}.before-restore-${stamp()}`;
  // Keep the WAL/SHM files next to the old database so it stays complete.
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${current}${suffix}`)) renameSync(`${current}${suffix}`, `${kept}${suffix}`);
  renameSync(staged, current);
  chmodSync(current, 0o600);
  return { restored: current, previous: existsSync(kept) ? kept : null };
}
