/**
 * Newline-delimited JSON framing used by the SSH stdio bridge.
 * One JSON-RPC message per line; lines are UTF-8, never contain raw newlines.
 *
 * - Only newly received data is scanned for newlines (linear in input size).
 * - A line longer than `maxLine` is discarded up to its terminating newline and
 *   reported through onError; its tail is never parsed as a message.
 * - Exceptions thrown by `onMessage` are reported, never allowed to escape the
 *   stream handler (which would crash the process).
 */
export function createLineReader(stream, onMessage, { onError = () => {}, maxLine = 16 * 1024 * 1024 } = {}) {
  let parts = [];
  let size = 0;
  let discarding = false;
  stream.setEncoding?.('utf8');

  const deliver = (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      onError(new Error(`invalid JSON line: ${text.slice(0, 120)}`));
      return;
    }
    try {
      onMessage(msg);
    } catch (err) {
      onError(err);
    }
  };

  stream.on('data', (chunk) => {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf('\n', start)) !== -1) {
      const piece = chunk.slice(start, nl);
      start = nl + 1;
      if (discarding) {
        discarding = false;
        continue;
      }
      parts.push(piece);
      const line = parts.join('');
      parts = [];
      size = 0;
      deliver(line);
    }
    if (start < chunk.length && !discarding) {
      const rest = chunk.slice(start);
      size += rest.length;
      parts.push(rest);
      if (size > maxLine) {
        parts = [];
        size = 0;
        discarding = true;
        onError(Object.assign(new Error(`message larger than ${maxLine} bytes dropped`), { oversize: true }));
      }
    }
  });
}

export const writeLine = (stream, msg) => stream.write(`${JSON.stringify(msg)}\n`);
