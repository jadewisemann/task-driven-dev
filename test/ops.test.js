import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serviceSpec } from '../src/cli/service.js';
import { ROOT, cli, makeApp, rpc, startDaemon, tmpHome } from './helpers.js';

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
  assert.match(info.feedbackUrl, /\/issues$/);
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
