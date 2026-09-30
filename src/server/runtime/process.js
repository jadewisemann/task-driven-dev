import { spawn } from 'node:child_process';

const MAX_CAPTURE = 2 * 1024 * 1024;
/** After the leader exits, wait this long for its pipes to drain before force-closing them. */
const EXIT_GRACE_MS = 250;

/** Appends to a buffer that keeps only the last `max` chars (results live at the end of agent output). */
function tailAppend(buf, text, max) {
  const next = buf.text + text;
  if (next.length <= max) return { text: next, truncated: buf.truncated };
  return { text: next.slice(next.length - max), truncated: true };
}

/**
 * Spawns a process without a shell, streams its output and resolves when it
 * exits. The child gets its own process group; on timeout, abort *and* normal
 * exit the whole group is signalled, so background children an agent leaves
 * behind (dev servers, watchers) cannot keep the run — or its pipes — alive.
 *
 * @param {{command: string, args?: string[], env?: object, cwd?: string, stdin?: string,
 *          timeoutMs?: number, signal?: AbortSignal, onSpawn?: (pid: number) => void,
 *          onData?: (stream: 'stdout'|'stderr', text: string) => void}} opts
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string,
 *          truncated: boolean, timedOut: boolean, cancelled: boolean}>}
 */
export function runProcess({ command, args = [], env = {}, cwd, stdin, timeoutMs, signal, onSpawn, onData }) {
  return new Promise((resolve) => {
    let out = { text: '', truncated: false };
    let err = { text: '', truncated: false };
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let exitInfo = null;
    const isWindows = process.platform === 'win32';

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows,
      windowsHide: true,
    });
    if (child.pid) onSpawn?.(child.pid);

    /** Signals the whole process group; ESRCH (already gone) is fine. */
    const signalGroup = (sig) => {
      if (!child.pid) return;
      try {
        if (!isWindows) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* group already gone */
      }
    };
    const terminate = () => {
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), 3000).unref();
    };

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate();
          // If the leader already exited but pipes are held, don't wait for them.
          setTimeout(() => finish(exitInfo || { code: null, signal: 'SIGKILL' }), 3500).unref();
        }, timeoutMs)
      : null;
    const onAbort = () => {
      cancelled = true;
      terminate();
      setTimeout(() => finish(exitInfo || { code: null, signal: 'SIGKILL' }), 3500).unref();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    // setEncoding uses a StringDecoder, so multi-byte characters split across chunks stay intact.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      out = tailAppend(out, text, MAX_CAPTURE);
      onData?.('stdout', text);
    });
    child.stderr.on('data', (text) => {
      err = tailAppend(err, text, MAX_CAPTURE);
      onData?.('stderr', text);
    });

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ stdout: out.text, stderr: err.text, truncated: out.truncated, timedOut, cancelled, ...result });
    }

    child.on('error', (e) => {
      const message = e.code === 'ENOENT' ? `Command not found: ${command} (is the CLI installed and on PATH?)` : e.message;
      err = tailAppend(err, `${message}\n`, MAX_CAPTURE);
      onData?.('stderr', `${message}\n`);
      finish({ code: 127, signal: null });
    });
    child.on('exit', (code, sig) => {
      exitInfo = { code, signal: sig };
      // Leader is done: clean up anything it left running in its group, then let pipes drain briefly.
      signalGroup('SIGTERM');
      setTimeout(() => finish(exitInfo), EXIT_GRACE_MS).unref();
    });
    child.on('close', () => exitInfo && finish(exitInfo));

    child.stdin.on('error', () => {}); // child may exit before reading stdin (EPIPE)
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
