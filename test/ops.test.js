import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { installService, installedServicePaths, serviceSpec } from '../src/cli/service.js';
import { Database } from '../src/server/core/db.js';
import { FIXTURES, ROOT, cli, makeApp, onCleanup, rpc, startDaemon, tmpHome } from './helpers.js';

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

test('version and doctor', async (t) => {
  assert.equal((await cli(['--version'])).stdout.trim(), VERSION);
  const home = tmpHome(t);
  const doctor = await cli(['doctor', '--home', home, '--json']);
  assert.equal(doctor.code, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
  assert.equal(byId.node, 'ok');
  assert.equal(byId.git, 'ok');
  assert.equal(byId.server, 'warn', 'no server running');

  const daemon = await startDaemon(t, home);
  const viaServer = (await rpc(daemon.url, 'system.doctor')).body.result;
  assert.equal(viaServer.checks.find((c) => c.id === 'db').status, 'ok');
  assert.equal(viaServer.checks.find((c) => c.id === 'server').status, 'ok');
  const info = (await rpc(daemon.url, 'system.info')).body.result;
  assert.equal(info.version, VERSION);
  assert.match(info.feedbackUrl, /\/issues\/new\/choose$/);
});

test('service definitions for launchd and systemd', () => {
  const home = '/Users/me/My Data/.todo-devs';
  const mac = serviceSpec({ platform: 'darwin', home, port: 7421, host: '0.0.0.0', path: '/opt/homebrew/bin:/usr/bin' });
  assert.equal(mac.kind, 'launchd');
  assert.match(mac.file, /Library\/LaunchAgents\/dev\.tododevs\.server\.plist$/);
  assert.match(mac.content, /<string>serve<\/string>\s*<string>--home<\/string>\s*<string>\/Users\/me\/My Data\/\.todo-devs<\/string>/);
  assert.match(mac.content, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  assert.match(mac.content, /<string>0\.0\.0\.0<\/string>/);
  const linux = serviceSpec({ platform: 'linux', home: '/home/me/.todo-devs', path: '/usr/bin' });
  assert.equal(linux.kind, 'systemd');
  assert.match(linux.content, /ExecStart=".+node.*" ".+todo-devs\.js" "serve" "--home" "\/home\/me\/\.todo-devs"/);
  assert.match(linux.content, /Restart=on-failure/);
  assert.throws(() => serviceSpec({ platform: 'win32', home }), /macOS .* Linux/);
});

test('service install --print shows the unit without installing', async (t) => {
  const home = tmpHome(t);
  const { file } = serviceSpec({ home });
  const before = existsSync(file);
  const res = await cli(['service', 'install', '--print', '--home', home]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, process.platform === 'darwin' ? /<plist/ : /\[Service\]/);
  assert.equal(existsSync(file), before, 'nothing is written by --print');
});

test('backup while running, restore refused while running, restore when stopped', async (t) => {
  const home = tmpHome(t);
  const daemon = await startDaemon(t, home);
  const [project] = (await rpc(daemon.url, 'projects.list')).body.result;
  await rpc(daemon.url, 'tasks.create', { projectId: project.id, title: 'keep me' });
  const out = join(tmpHome(t), 'snap.db');
  const b = await cli(['backup', '--home', home, '--out', out]);
  assert.equal(b.code, 0, b.stderr);
  assert.ok(existsSync(out));
  const refused = await cli(['restore', out, '--home', home]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Stop the server/);
  await rpc(daemon.url, 'tasks.create', { projectId: project.id, title: 'after backup' });
  await daemon.stop();
  const r = await cli(['restore', out, '--home', home]);
  assert.equal(r.code, 0, r.stderr);
  const app = makeApp(t, { home });
  assert.deepEqual((await app.call('tasks.list')).map((x) => x.title), ['keep me']);
  assert.match((await cli(['restore', join(home, 'nope.db'), '--home', tmpHome(t)])).stderr, /not found/);
});

test('npm package installs and runs (global install into a temp prefix)', async (t) => {
  const dir = tmpHome(t);
  const tgz = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '' } }).toString().trim().split('\n').pop();
  const prefix = join(dir, 'prefix');
  execFileSync('npm', ['install', '-g', '--prefix', prefix, join(dir, tgz)], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'ignore' });
  const bin = join(prefix, 'bin', 'todo-devs');
  assert.equal(execFileSync(bin, ['--version'], { env: { ...process.env, NODE_OPTIONS: '' } }).toString().trim(), VERSION);
  const doctor = JSON.parse(execFileSync(bin, ['doctor', '--json', '--home', join(dir, 'home')], { env: { ...process.env, NODE_OPTIONS: '' } }).toString());
  assert.equal(doctor.checks.find((c) => c.id === 'node').status, 'ok');
  // The web UI ships in the package.
  assert.ok(existsSync(join(prefix, 'lib', 'node_modules', 'todo-devs', 'src', 'web', 'index.html')));
  assert.ok(!existsSync(join(prefix, 'lib', 'node_modules', 'todo-devs', 'test')), 'tests are not published');
});

test('backup: default location, 0600, refuses when there is no database', async (t) => {
  const home = tmpHome(t);
  assert.match((await cli(['backup', '--home', home])).stderr, /No database/);
  const app = makeApp(t, { home });
  await app.call('projects.create', { name: 'p' });
  const b = await cli(['backup', '--home', home]);
  assert.equal(b.code, 0, b.stderr);
  const file = b.stdout.match(/backup written: (.+) \(/)[1];
  assert.ok(file.startsWith(join(home, 'backups')));
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('restore: rejects non-databases, foreign databases, newer schemas and databases in use', async (t) => {
  const home = tmpHome(t);
  const dir = tmpHome(t);
  const notDb = join(dir, 'x.db');
  writeFileSync(notDb, 'hello');
  assert.match((await cli(['restore', notDb, '--home', home])).stderr, /not a SQLite database/);
  const foreign = join(dir, 'foreign.db');
  const f = new Database(foreign);
  f.exec('CREATE TABLE other (x)');
  f.close();
  assert.match((await cli(['restore', foreign, '--home', home])).stderr, /not a todo\.devs database/);

  const app = makeApp(t, { home });
  const good = join(dir, 'good.db');
  app.db.exec(`VACUUM INTO '${good}'`);
  const before = statSync(good).mtimeMs;
  assert.match((await cli(['restore', good, '--home', home])).stderr, /in use by process/, 'an open app (CLI session / SSH bridge) blocks restore');
  await app.close();

  const newer = join(dir, 'newer.db');
  copyFileSync(good, newer);
  const n = new Database(newer);
  n.run("INSERT INTO schema_migrations (id, applied_at) VALUES ('999_future', 'x')");
  n.close();
  assert.match((await cli(['restore', newer, '--home', home])).stderr, /newer todo\.devs/);
  const ok = await cli(['restore', good, '--home', home]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(statSync(good).mtimeMs, before, 'the backup file itself is not modified');
  assert.ok(!existsSync(`${good}-wal`));
  assert.ok(!existsSync(join(home, 'todo-devs.db.restore-tmp')));
  assert.match((await cli(['restore', join(home, 'todo-devs.db'), '--home', home])).stderr, /live database/);
});

test('systemd unit escapes $ and % and limits restarts', () => {
  const spec = serviceSpec({ platform: 'linux', home: '/home/me/100% $HOME dir', path: '/usr/bin', node: '/usr/bin/node', bin: '/opt/td/bin/todo-devs.js' });
  assert.match(spec.content, /"--home" "\/home\/me\/100%% \$\$HOME dir"/);
  assert.match(spec.content, /StandardOutput=append:\/home\/me\/100%% \$HOME dir\/logs\/server\.log/);
  assert.match(spec.content, /StartLimitBurst=5/);
  assert.match(spec.content, /RestartPreventExitStatus=3/);
});

/** Runs installService with fake service managers, HOME/XDG in a temp dir. */
async function fakeInstall(t, platform, { start }) {
  const base = tmpHome(t);
  const home = join(base, 'data');
  const log = join(base, 'svc.log');
  const port = 7600 + Math.floor(Math.random() * 300);
  const saved = { ...process.env };
  Object.assign(process.env, {
    HOME: join(base, 'home'),
    XDG_CONFIG_HOME: join(base, 'xdg'),
    PATH: `${join(FIXTURES, 'svcbin')}:${process.env.PATH}`,
    FAKE_SVC_LOG: log,
    FAKE_SVC_START: start ? '1' : '0',
    FAKE_SVC_HOME: home,
    FAKE_SVC_PORT: String(port),
    TODO_DEVS_BIN: join(ROOT, 'bin', 'todo-devs.js'),
    NODE_OPTIONS: '',
  });
  onCleanup(t, () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  onCleanup(t, () => {
    try {
      process.kill(Number(readFileSync(join(home, 'fake.pid'), 'utf8')), 'SIGTERM');
    } catch {
      /* not started */
    }
  });
  let error = null;
  let result = null;
  try {
    result = await installService({ platform, home, port, host: '127.0.0.1', healthTimeoutMs: 8000 });
  } catch (err) {
    error = err;
  }
  return { result, error, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [], home, port };
}

for (const platform of ['linux', 'darwin']) {
  test(`service install (${platform}): restarts via the service manager and waits for the server`, async (t) => {
    const ok = await fakeInstall(t, platform, { start: true });
    assert.equal(ok.error, null, ok.error?.message);
    if (platform === 'linux') assert.deepEqual(ok.calls, ['systemctl --user daemon-reload', 'systemctl --user enable todo-devs.service', 'systemctl --user restart todo-devs.service']);
    else assert.deepEqual(ok.calls.map((c) => c.split(' ')[1]), ['bootout', 'print', 'bootstrap']);
    assert.match(ok.result.steps.at(-1), /server is up/);
    assert.ok(existsSync(ok.result.file));
    assert.equal(installedServicePaths(platform).ok, true);
  });
}

test('service install reports a server that never comes up', async (t) => {
  const res = await fakeInstall(t, 'linux', { start: false });
  assert.match(res.error?.message || '', /did not come up/);
});

test('local-only commands refuse --peer', async (t) => {
  const res = await cli(['service', 'status', '--peer', 'box', '--home', tmpHome(t)]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /this machine only/);
});
