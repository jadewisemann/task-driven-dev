import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createLineReader, writeLine } from '../../remote/jsonl.js';

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;

/**
 * Client side of a remote session: spawns the transport (e.g. `ssh host todo-devs rpc`),
 * speaks line-delimited JSON-RPC over its stdio and surfaces the remote's live
 * events. Reconnects lazily on the next call after the connection drops.
 *
 * Emits: 'event' (remote bus event), 'status' ({state, info?, error?})
 */
export class RemoteClient extends EventEmitter {
  /** @param {{command: string, args: string[], env?: object, label?: string}} spec */
  constructor(spec) {
    super();
    this.spec = spec;
    this.child = null;
    this.state = 'disconnected'; // disconnected | connecting | connected | error
    this.info = null;
    this.error = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderrTail = '';
    this.connecting = null;
  }

  status() {
    return { state: this.state, info: this.info, error: this.error, stderr: this.stderrTail.slice(-2000) };
  }

  setState(state, extra = {}) {
    this.state = state;
    Object.assign(this, extra);
    this.emit('status', this.status());
  }

  connect() {
    if (this.state === 'connected') return Promise.resolve(this.info);
    if (this.connecting) return this.connecting;
    this.stderrTail = '';
    this.setState('connecting', { error: null });
    this.connecting = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connecting = null;
        this.setState('error', { error: err.message });
        this.kill();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error(`remote did not answer within ${CONNECT_TIMEOUT_MS / 1000}s${this.stderrTail ? `: ${this.stderrTail.trim().split('\n').pop()}` : ''}`)), CONNECT_TIMEOUT_MS);

      let child;
      try {
        child = spawn(this.spec.command, this.spec.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(this.spec.env || {}) }, windowsHide: true });
      } catch (err) {
        fail(err);
        return;
      }
      this.child = child;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (t) => (this.stderrTail = (this.stderrTail + t).slice(-8000)));
      child.stdin.on('error', () => {});
      child.on('error', (err) => fail(err.code === 'ENOENT' ? new Error(`${this.spec.command} not found on PATH`) : err));
      child.on('exit', (code) => {
        const reason = new Error(`remote session ended (exit ${code})${this.stderrTail ? `: ${this.stderrTail.trim().split('\n').pop()}` : ''}`);
        if (!settled) fail(reason);
        if (this.child === child) {
          this.child = null;
          this.rejectAll(reason);
          if (this.state === 'connected') this.setState('disconnected', { error: reason.message });
        }
      });
      createLineReader(child.stdout, (msg) => {
        if (msg.method === 'hello') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.connecting = null;
          this.setState('connected', { info: msg.params, error: null });
          resolve(msg.params);
          return;
        }
        if (msg.method === 'event') return this.emit('event', msg.params);
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(Object.assign(new Error(msg.error.message), msg.error));
        else entry.resolve(msg.result);
      });
    });
    return this.connecting;
  }

  async call(method, params = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`remote call ${method} timed out`), { code: -32010 }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      writeLine(this.child.stdin, { jsonrpc: '2.0', id, method, params });
    });
  }

  rejectAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(Object.assign(new Error(err.message), { code: -32010 }));
    }
    this.pending.clear();
  }

  kill() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.end();
    setTimeout(() => child.exitCode === null && child.kill('SIGTERM'), 1000).unref();
  }

  close() {
    this.rejectAll(new Error('remote session closed'));
    this.kill();
    this.connecting = null;
    this.setState('disconnected', { error: null });
  }
}
