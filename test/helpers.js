import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/app.js';
import { createHttpServer } from '../src/server/http/server.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BIN = join(ROOT, 'bin', 'todo-devs.js');
export const FIXTURES = join(ROOT, 'test', 'fixtures');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simulated agents finish quickly in tests.
process.env.TODO_DEVS_MOCK_DELAY_MS ??= '40';

/** Fresh data directory, removed after the test. */
export function tmpHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'todo-devs-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An app on a throwaway home (closed + removed after the test). */
export function makeApp(t, options = {}) {
  const home = options.home || mkdtempSync(join(tmpdir(), 'todo-devs-test-'));
  const app = createApp({ home, log: () => {}, ...options });
  t.after(async () => {
    await app.close();
    if (!options.home) rmSync(home, { recursive: true, force: true });
  });
  return app;
}

/** Serves an app on a random loopback port; returns the base URL. */
export async function listen(t, app, options = {}) {
  const server = createHttpServer(app, options);
  await new Promise((resolve) => server.listen(options.port || 0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}`, server };
}

export async function rpc(url, method, params = {}, headers = {}) {
  const res = await fetch(`${url}/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ method, params }) });
  return { status: res.status, body: await res.json() };
}

/** Resolves with the first bus event matching `pred` (local events). */
export function nextEvent(app, pred, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('timed out waiting for event'));
    }, timeoutMs);
    const off = app.bus.subscribe((e) => {
      if (!pred(e)) return;
      clearTimeout(timer);
      off();
      resolve(e);
    });
  });
}

export async function waitFor(check, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

/** Default project + the built-in mock agent (optionally every agent switched to mock). */
export async function setup(app, { allMock = false } = {}) {
  const [project] = await app.call('projects.list');
  const agents = await app.call('agents.list');
  if (allMock) for (const a of agents) await app.call('agents.update', { id: a.id, harness: 'mock', model: a.tier === 3 ? 'mock-large' : 'mock-small' });
  const mock = agents.find((a) => a.harness === 'mock');
  return { project, agents: await app.call('agents.list'), mock };
}

/** Spawns the CLI (`todo-devs …`). Resolves with {code, stdout, stderr}. */
export function cli(args, { env = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, NODE_OPTIONS: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Starts `todo-devs serve` as a real process on a random port.
 * Returns {url, token, stop()} once daemon.json points at it.
 */
export async function startDaemon(t, home, extraArgs = [], env = {}) {
  const child = spawn(process.execPath, [BIN, 'serve', '--home', home, '--port', '0', ...extraArgs], { env: { ...process.env, NODE_OPTIONS: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  t.after(stop);
  const daemonFile = join(home, 'daemon.json');
  const info = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    if (!existsSync(daemonFile)) return null;
    try {
      const d = JSON.parse(readFileSync(daemonFile, 'utf8'));
      return d.pid === child.pid ? d : null;
    } catch {
      return null;
    }
  });
  return { url: `http://127.0.0.1:${info.port}`, token: info.token, child, stop, output: () => output };
}

/** Makes the fake ssh / todo-devs shims executable and puts them first on PATH. */
export function fakeSshEnv() {
  for (const f of ['ssh', 'todo-devs']) chmodSync(join(FIXTURES, 'bin', f), 0o755);
  return { PATH: `${join(FIXTURES, 'bin')}:${process.env.PATH}`, TODO_DEVS_BIN: BIN, NODE_OPTIONS: '' };
}
