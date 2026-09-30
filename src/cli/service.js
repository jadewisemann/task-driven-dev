import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDaemonInfo } from '../server/core/paths.js';

const BIN = resolve(fileURLToPath(new URL('../../bin/todo-devs.js', import.meta.url)));
export const LABEL = 'dev.tododevs.server';
/** `serve` exits with this code when its port is taken; the service manager must not retry. */
export const EXIT_PORT_IN_USE = 3;

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** systemd quoting: double quotes; escape \ and "; `%` → `%%` (specifiers), `$` → `$$` (variables). */
const sd = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
/** `append:` paths are unquoted: only specifiers need escaping (spaces are fine up to end of line). */
const sdPath = (s) => String(s).replace(/%/g, '%%');

/**
 * The `node` to put in the service: the one on PATH when it is the same binary
 * we run on (e.g. /opt/homebrew/bin/node, a stable symlink), else process.execPath.
 * Homebrew's resolved Cellar path changes on every `brew upgrade`.
 */
function stableNode(path) {
  for (const dir of path.split(':')) {
    const candidate = join(dir, 'node');
    if (!existsSync(candidate)) continue;
    const r = spawnSync(candidate, ['-p', 'process.execPath'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === process.execPath) return candidate;
    break; // the first `node` on PATH is a different one: don't guess
  }
  return process.execPath;
}

/**
 * The service definition for this platform. The PATH of the installing shell is
 * captured so agent CLIs (claude, codex, …) are found when the service runs.
 */
export function serviceSpec({ platform = process.platform, home, port = 7420, host = '127.0.0.1', path = process.env.PATH || '/usr/bin:/bin', node = stableNode(path), bin = BIN }) {
  const args = [node, bin, 'serve', '--home', home, '--port', String(port), '--host', host];
  const log = join(home, 'logs', 'server.log');
  if (platform === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path)}</string>
    <key>TODO_DEVS_SERVICE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    return { platform, kind: 'launchd', file, content, log, node, bin };
  }
  if (platform === 'linux') {
    const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', 'todo-devs.service');
    const content = `[Unit]
Description=todo.devs server
# Give up after 5 failed starts in 5 minutes instead of looping forever.
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
ExecStart=${args.map(sd).join(' ')}
Environment=${sd(`PATH=${path}`)}
Environment=TODO_DEVS_SERVICE=1
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=${EXIT_PORT_IN_USE}
StandardOutput=append:${sdPath(log)}
StandardError=append:${sdPath(log)}

[Install]
WantedBy=default.target
`;
    return { platform, kind: 'systemd', file, content, log, node, bin };
  }
  throw new Error(`Services are supported on macOS (launchd) and Linux (systemd), not ${platform}`);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), missing: Boolean(r.error) };
}

const uid = () => userInfo().uid;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function tail(file, lines = 15) {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log yet)';
  }
}

/** Waits until the service's server wrote daemon.json and answers /api/health. */
async function waitHealthy(home, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = readDaemonInfo(home);
    if (d && d.port === port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) return true;
      } catch {
        /* not up yet */
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * Writes and (re)starts the service, then checks the server really came up.
 * @param {{home, port, host, healthTimeoutMs?}} opts
 */
export async function installService(opts) {
  const spec = serviceSpec(opts);
  if (spec.bin.includes(`${'/'}_npx${'/'}`)) throw new Error('Install todo.devs first (npm install -g todo-devs, or from a checkout) — an npx cache path can disappear');
  const running = readDaemonInfo(opts.home);
  if (running && running.port === Number(opts.port) && !serviceStatus(opts).installed) {
    throw new Error(`A server is already running on port ${running.port} (pid ${running.pid}). Stop it first, or pick another --port.`);
  }
  mkdirSync(dirname(spec.file), { recursive: true });
  mkdirSync(dirname(spec.log), { recursive: true });
  writeFileSync(spec.file, spec.content);
  const steps = [];
  if (spec.kind === 'launchd') {
    const target = `gui/${uid()}/${LABEL}`;
    run('launchctl', ['bootout', target]); // replace a previous install
    // bootout returns before the old job is gone; bootstrapping too early fails with "5: Input/output error".
    for (let i = 0; i < 50 && run('launchctl', ['print', target]).ok; i++) sleepSync(100);
    const r = run('launchctl', ['bootstrap', `gui/${uid()}`, spec.file]);
    if (!r.ok) {
      throw new Error(`launchctl bootstrap failed: ${r.out || 'launchctl not available'}. The service needs a logged-in macOS GUI session (not only SSH).`);
    }
    steps.push('loaded with launchctl');
  } else {
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', 'todo-devs.service'], ['--user', 'restart', 'todo-devs.service']]) {
      const r = run('systemctl', args);
      if (!r.ok) throw new Error(`systemctl ${args.join(' ')} failed: ${r.out || 'systemctl not available'}`);
    }
    steps.push('enabled and (re)started with systemctl --user (runs while you are logged in; `loginctl enable-linger` keeps it running after logout)');
  }
  const healthy = await waitHealthy(opts.home, Number(opts.port), opts.healthTimeoutMs ?? 15000);
  if (!healthy) throw new Error(`The service was installed but the server did not come up. Last log lines (${spec.log}):\n${tail(spec.log)}`);
  steps.push(`server is up on port ${opts.port}`);
  return { ...spec, steps };
}

export function uninstallService(opts) {
  const spec = serviceSpec(opts);
  if (spec.kind === 'launchd') run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]);
  else {
    run('systemctl', ['--user', 'disable', '--now', 'todo-devs.service']);
    run('systemctl', ['--user', 'daemon-reload']);
  }
  const existed = existsSync(spec.file);
  rmSync(spec.file, { force: true });
  return { ...spec, removed: existed };
}

export function serviceStatus(opts) {
  const spec = serviceSpec(opts);
  const installed = existsSync(spec.file);
  let active = false;
  if (installed) {
    active = spec.kind === 'launchd' ? run('launchctl', ['print', `gui/${uid()}/${LABEL}`]).out.includes('state = running') : run('systemctl', ['--user', 'is-active', 'todo-devs.service']).out === 'active';
  }
  return { kind: spec.kind, file: spec.file, log: spec.log, installed, active };
}

/**
 * For doctor: the node binary and CLI script an installed service points at,
 * and whether they still exist (they break after e.g. an nvm switch).
 */
export function installedServicePaths(platform = process.platform) {
  let file;
  try {
    file = serviceSpec({ platform, home: '/', node: 'node', bin: BIN }).file;
  } catch {
    return null;
  }
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const parts =
    platform === 'darwin'
      ? [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).slice(1, 3)
      : [...(text.match(/^ExecStart=(.*)$/m)?.[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].slice(0, 2).map((m) => m[1].replace(/\\(.)/g, '$1').replace(/\$\$/g, '$').replace(/%%/g, '%'));
  return { file, node: parts[0], bin: parts[1], ok: parts.length === 2 && parts.every((p) => existsSync(p)) };
}
