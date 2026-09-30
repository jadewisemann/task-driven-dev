import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Resolves the data directory: --home flag > TODO_DEVS_HOME > ~/.todo-devs */
export function resolveHome(explicit) {
  const dir = resolve(explicit || process.env.TODO_DEVS_HOME || join(homedir(), '.todo-devs'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const dbPath = (home) => join(home, 'todo-devs.db');
const daemonFile = (home) => join(home, 'daemon.json');

/** Records the running server so CLI / SSH bridges can find it. */
export function writeDaemonInfo(home, info) {
  // May contain the access token: readable by the owner only.
  writeFileSync(daemonFile(home), JSON.stringify({ ...info, pid: process.pid, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

export function readDaemonInfo(home) {
  try {
    const info = JSON.parse(readFileSync(daemonFile(home), 'utf8'));
    process.kill(info.pid, 0); // throws if the process is gone
    return info;
  } catch {
    return null;
  }
}

export function clearDaemonInfo(home) {
  try {
    const info = JSON.parse(readFileSync(daemonFile(home), 'utf8'));
    if (info.pid === process.pid) rmSync(daemonFile(home));
  } catch {
    /* nothing to clear */
  }
}

const openDir = (home) => join(home, 'open');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** Records that this process has the home's database open. */
export function markOpen(home) {
  mkdirSync(openDir(home), { recursive: true });
  const file = join(openDir(home), `${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(file, new Date().toISOString());
  return { release: () => rmSync(file, { force: true }) };
}

/** Other live processes that have the home's database open (stale markers are cleaned up). */
export function openHolders(home) {
  let entries = [];
  try {
    entries = readdirSync(openDir(home));
  } catch {
    return [];
  }
  const pids = [];
  for (const name of entries) {
    const pid = Number(name.split('-')[0]);
    if (!alive(pid)) rmSync(join(openDir(home), name), { force: true });
    else if (pid !== process.pid) pids.push(pid);
  }
  return [...new Set(pids)];
}
