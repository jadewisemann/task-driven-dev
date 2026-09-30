import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = resolve(fileURLToPath(new URL('../../bin/todo-devs.js', import.meta.url)));
export const LABEL = 'dev.tododevs.server';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** systemd quoting: every argument in double quotes, with \ and " escaped. */
const sd = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

/**
 * The service definition for this platform. The PATH of the installing shell is
 * captured so agent CLIs (claude, codex, …) are found when the service runs.
 */
export function serviceSpec({ platform = process.platform, home, port = 7420, host = '127.0.0.1', path = process.env.PATH || '/usr/bin:/bin' }) {
  const args = [process.execPath, BIN, 'serve', '--home', home, '--port', String(port), '--host', host];
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
  <dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    return { platform, kind: 'launchd', file, content, log };
  }
  if (platform === 'linux') {
    const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', 'todo-devs.service');
    const content = `[Unit]
Description=todo.devs server
After=network-online.target

[Service]
ExecStart=${args.map(sd).join(' ')}
Environment=${sd(`PATH=${path}`)}
Restart=on-failure
RestartSec=5
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
    return { platform, kind: 'systemd', file, content, log };
  }
  throw new Error(`Services are supported on macOS (launchd) and Linux (systemd), not ${platform}`);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), missing: Boolean(r.error) };
}

const uid = () => userInfo().uid;

export function installService(opts) {
  const spec = serviceSpec(opts);
  mkdirSync(dirname(spec.file), { recursive: true });
  mkdirSync(dirname(spec.log), { recursive: true });
  writeFileSync(spec.file, spec.content);
  const steps = [];
  if (spec.kind === 'launchd') {
    run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]); // replace a previous install
    const r = run('launchctl', ['bootstrap', `gui/${uid()}`, spec.file]);
    steps.push(r.ok ? 'loaded with launchctl' : `launchctl bootstrap failed: ${r.out}`);
    if (!r.ok) throw new Error(steps.at(-1));
  } else {
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'todo-devs.service']]) {
      const r = run('systemctl', args);
      if (!r.ok) throw new Error(`systemctl ${args.join(' ')} failed: ${r.out || 'systemctl not available'}`);
    }
    steps.push('enabled with systemctl --user (runs while you are logged in; `loginctl enable-linger` keeps it running after logout)');
  }
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
