import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { listHarnesses } from '../harness/registry.js';
import { openReadOnly } from './db.js';
import { dbPath } from './paths.js';

const MIN_NODE = [22, 13];

/** Tool probes are cached for a minute: Settings may call doctor often, and they block briefly. */
const probeCache = new Map();
function which(cmd, args = ['--version']) {
  const key = `${cmd} ${args.join(' ')}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = probe(cmd, args);
  probeCache.set(key, { at: Date.now(), value });
  return value;
}

function probe(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
    if (r.error) return null;
    return (r.stdout || r.stderr || '').trim().split('\n')[0] || 'installed';
  } catch {
    return null;
  }
}

const check = (id, label, status, detail, fix) => ({ id, label, status, detail, ...(fix ? { fix } : {}) });

/**
 * Environment and data health checks, shared by `todo-devs doctor` and the
 * Settings screen. status: ok | warn | fail. `fail` means something is broken;
 * `warn` means a feature will not work until fixed.
 *
 * @param {{app?: object, home: string, daemon?: object|null}} ctx
 */
export function runDoctor({ app, home, daemon, servicePaths = null }) {
  const checks = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  checks.push(check('node', 'Node.js', nodeOk ? 'ok' : 'fail', `v${process.versions.node}`, nodeOk ? null : `Install Node ${MIN_NODE.join('.')} or newer`));

  const git = which('git');
  checks.push(check('git', 'git', git ? 'ok' : 'warn', git || 'not found', git ? null : 'Install git to run tasks in worktrees'));
  const sh = which('sh', ['-c', 'command -v sh']);
  checks.push(check('sh', 'POSIX shell', sh ? 'ok' : 'warn', sh || 'not found', sh ? null : 'Shell harness and Shell nodes need sh'));
  const ssh = which('ssh', ['-V']);
  checks.push(check('ssh', 'ssh (remote sessions)', ssh ? 'ok' : 'warn', ssh || 'not found', ssh ? null : 'Install OpenSSH to use remote sessions'));

  let writable = true;
  try {
    accessSync(home, constants.W_OK);
  } catch {
    writable = false;
  }
  checks.push(check('home', 'Data directory', writable ? 'ok' : 'fail', home, writable ? null : `Make ${home} writable or use --home`));

  // quick_check: catches corruption without the full index scan of integrity_check.
  const quickCheck = (db) => Object.values(db.prepare ? db.prepare('PRAGMA quick_check').get() : db.get('PRAGMA quick_check'))[0];
  try {
    let result = null;
    if (app) result = quickCheck(app.db);
    else if (existsSync(dbPath(home))) {
      const ro = openReadOnly(dbPath(home));
      try {
        result = quickCheck(ro);
      } finally {
        ro.close();
      }
    }
    if (result !== null) checks.push(check('db', 'Database', result === 'ok' ? 'ok' : 'fail', result === 'ok' ? 'healthy' : String(result), result === 'ok' ? null : 'Restore a backup: todo-devs restore <file>'));
  } catch (err) {
    checks.push(check('db', 'Database', 'fail', err.message, 'Restore a backup: todo-devs restore <file>'));
  }

  if (servicePaths) {
    checks.push(
      servicePaths.ok
        ? check('service', 'Login service', 'ok', servicePaths.file)
        : check('service', 'Login service', 'fail', `points at a missing ${!existsSync(servicePaths.node || '') ? `node (${servicePaths.node})` : `script (${servicePaths.bin})`}`, 'Re-run `todo-devs service install` (e.g. after a Node upgrade)'),
    );
  }

  const harnesses = listHarnesses().filter((h) => h.binary && !['sh'].includes(h.binary));
  const installed = harnesses.filter((h) => h.installed);
  checks.push(
    check(
      'harnesses',
      'Agent CLIs',
      installed.length ? 'ok' : 'warn',
      harnesses.map((h) => `${h.name}: ${h.installed ? 'installed' : 'missing'}`).join(', '),
      installed.length ? null : 'Install at least one agent CLI (claude, codex, kiro-cli, gemini, aider) — the Mock agent works without one',
    ),
  );
  if (app) {
    const missing = app.services.agents.list().filter((a) => harnesses.some((h) => h.id === a.harness && !h.installed));
    if (missing.length) {
      checks.push(check('agents', 'Agents with a missing CLI', 'warn', missing.map((a) => `${a.name} (${a.harness})`).join(', '), 'Install the CLI or switch these agents to another harness'));
    }
  }

  checks.push(
    daemon
      ? check('server', 'Server', 'ok', `running on port ${daemon.port}${daemon.token ? ' (network mode)' : ' (this computer only)'}`, null)
      : check('server', 'Server', 'warn', 'not running', 'Start it: todo-devs serve (or todo-devs service install)'),
  );
  const summary = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  return { summary, checks };
}
