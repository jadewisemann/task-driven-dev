/**
 * Newline-delimited JSON framing used by the SSH stdio bridge.
 * One JSON-RPC message per line; lines are UTF-8, never contain raw newlines.
 */
export function createLineReader(stream, onMessage, { onError = () => {}, maxLine = 64 * 1024 * 1024 } = {}) {
  let buffer = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > maxLine && !buffer.includes('\n')) {
      buffer = '';
      onError(new Error('message too large'));
      return;
    }
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        onError(new Error(`invalid JSON line: ${line.slice(0, 120)}`));
        continue;
      }
      onMessage(msg);
    }
  });
}

export const writeLine = (stream, msg) => stream.write(`${JSON.stringify(msg)}\n`);
