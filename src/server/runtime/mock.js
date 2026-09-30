const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const cancelled = () => reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    if (signal?.aborted) return cancelled();
    const onAbort = () => {
      clearTimeout(t);
      cancelled();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Built-in simulated agent. Behaviour can be steered per task through
 * `input.mock` = { delayMs?, fail?: boolean | number (fail the first N attempts), status?, output?, json? }
 * so dependency flows, retries, routing and review policies can be exercised
 * without any real model.
 */
export async function runMockAgent({ agent, prompt, input, attempt = 1, signal, onData }) {
  const opts = (input && typeof input === 'object' && input.mock) || {};
  const delay = Number(opts.delayMs ?? process.env.TODO_DEVS_MOCK_DELAY_MS ?? 600);
  const title = (prompt.match(/^# Task: (.+)$/m) || [])[1] || 'task';
  const steps = ['Reading task and context', `Planning (${agent.effort} effort, model ${agent.model || 'default'})`, 'Working', 'Verifying'];
  try {
    for (const step of steps) {
      onData?.('stdout', `[mock:${agent.name}] ${step}…\n`);
      await sleep(delay / steps.length, signal);
    }
  } catch (err) {
    if (err.cancelled) return { code: null, stdout: '', stderr: 'cancelled', cancelled: true, timedOut: false };
    throw err;
  }
  const shouldFail = opts.fail === true || (typeof opts.fail === 'number' && attempt <= opts.fail);
  if (shouldFail) {
    onData?.('stderr', `[mock:${agent.name}] simulated failure on attempt ${attempt}\n`);
    return { code: 1, stdout: '', stderr: `simulated failure (attempt ${attempt})`, cancelled: false, timedOut: false };
  }
  const json = { status: opts.status || 'done', summary: `${agent.name} completed "${title}" (simulated).`, ...(opts.json || {}) };
  const stdout = `${opts.output || `Simulated work for "${title}" by ${agent.name}.`}\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
  onData?.('stdout', stdout);
  return { code: 0, stdout, stderr: '', cancelled: false, timedOut: false };
}
