import { spawn } from 'node:child_process';

const MAX_CAPTURE = 2 * 1024 * 1024;

/**
 * Spawns a process without a shell, streams its output and resolves when it
 * exits. The child gets its own process group so timeouts / cancellation kill
 * everything it started (e.g. an agent CLI's tool subprocesses).
 *
 * @param {{command: string, args?: string[], env?: object, cwd?: string, stdin?: string,
 *          timeoutMs?: number, signal?: AbortSignal, onData?: (stream: 'stdout'|'stderr', text: string) => void}} opts
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, cancelled: boolean}>}
 */
export function runProcess({ command, args = [], env = {}, cwd, stdin, timeoutMs, signal, onData }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const isWindows = process.platform === 'win32';

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows,
      windowsHide: true,
    });

    const killTree = (sig = 'SIGTERM') => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (!isWindows && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        child.kill(sig);
      }
    };
    const hardKill = () => {
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 3000).unref();
    };

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          hardKill();
        }, timeoutMs)
      : null;
    const onAbort = () => {
      cancelled = true;
      hardKill();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const capture = (stream) => (chunk) => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout' && stdout.length < MAX_CAPTURE) stdout += text;
      if (stream === 'stderr' && stderr.length < MAX_CAPTURE) stderr += text;
      onData?.(stream, text);
    };
    child.stdout.on('data', capture('stdout'));
    child.stderr.on('data', capture('stderr'));

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, timedOut, cancelled, ...result });
    };
    child.on('error', (err) => {
      const message = err.code === 'ENOENT' ? `Command not found: ${command} (is the CLI installed and on PATH?)` : err.message;
      stderr += `${message}\n`;
      onData?.('stderr', `${message}\n`);
      finish({ code: 127, signal: null });
    });
    child.on('close', (code, sig) => finish({ code, signal: sig }));

    child.stdin.on('error', () => {}); // child may exit before reading stdin (EPIPE)
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
