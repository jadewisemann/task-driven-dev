import { copyFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../server/core/db.js';
import { dbPath, readDaemonInfo } from '../server/core/paths.js';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * Consistent snapshot of the database (safe while the server runs: VACUUM INTO
 * reads a single transaction). The access token (auth.json) is not included.
 */
export function backup(home, out) {
  const target = resolve(out || join(home, 'backups', `todo-devs-${stamp()}.db`));
  if (existsSync(target)) throw new Error(`${target} already exists`);
  const db = new Database(dbPath(home));
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return { file: target, bytes: statSync(target).size };
}

/** Replaces the database with a backup. The current one is kept as *.before-restore-<time>. */
export function restore(home, file) {
  if (readDaemonInfo(home)) throw new Error('Stop the server first (todo-devs service uninstall, or Ctrl+C on `todo-devs serve`)');
  const source = resolve(file);
  if (!existsSync(source)) throw new Error(`${source} not found`);
  const check = new Database(source);
  try {
    const res = check.get('PRAGMA integrity_check');
    if (Object.values(res)[0] !== 'ok') throw new Error(`${source} is not a healthy todo.devs database`);
    if (!check.get("SELECT 1 AS ok FROM sqlite_master WHERE name = 'tasks'")) throw new Error(`${source} is not a todo.devs database`);
  } finally {
    check.close();
  }
  const current = dbPath(home);
  const kept = `${current}.before-restore-${stamp()}`;
  // Keep the WAL/SHM files next to the old database so it stays complete.
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${current}${suffix}`)) renameSync(`${current}${suffix}`, `${kept}${suffix}`);
  copyFileSync(source, current);
  return { restored: current, previous: existsSync(kept) ? kept : null };
}
