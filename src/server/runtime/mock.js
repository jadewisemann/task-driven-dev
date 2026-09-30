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
 * Makes the mock answer structured questions plausibly so graphs can be tried
 * without a model: `{"key": "a" | "b"}` hints get the first option, a router's
 * "Routes: x, y" list gets its first route, and `MOCK: {...}` lines are merged verbatim.
 */
function answerHints(prompt) {
  const out = {};
  // Board task prompts (built by the context builder) only honour explicit MOCK lines.
  const structured = !prompt.startsWith('# Task:');
  if (structured) for (const m of prompt.matchAll(/"(\w+)"\s*:\s*"([\w-]+)"\s*\|/g)) out[m[1]] ??= m[2];
  const routes = structured && prompt.match(/^Routes: (.+)$/m);
  if (routes) {
    out.route = routes[1].split(',')[0].trim();
    out.reason = 'simulated decision';
  }
  for (const m of prompt.matchAll(/^MOCK: (\{.*\})$/gm)) {
    try {
      Object.assign(out, JSON.parse(m[1]));
    } catch {
      /* ignore malformed hints */
    }
  }
  return out;
}

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
  const json = {
    status: 'done',
    summary: `${agent.name} completed "${title}" (simulated).`,
    ...answerHints(prompt),
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.json || {}),
  };
  const stdout = `${opts.output || `Simulated work for "${title}" by ${agent.name}.`}\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
  onData?.('stdout', stdout);
  return { code: 0, stdout, stderr: '', cancelled: false, timedOut: false };
}
