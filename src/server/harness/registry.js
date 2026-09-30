import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Reasoning effort levels an agent can be configured with. */
export const EFFORTS = ['low', 'medium', 'high', 'max'];

/** Model tiers used by the orchestrator: 1 = small/fast, 2 = standard, 3 = frontier. */
export const TIERS = [1, 2, 3];

/** Claude Code reads its extended-thinking budget from MAX_THINKING_TOKENS. */
const CLAUDE_THINKING = { low: '0', medium: '8000', high: '24000', max: '63999' };
/** Codex accepts model_reasoning_effort = minimal | low | medium | high. */
const CODEX_EFFORT = { low: 'low', medium: 'medium', high: 'high', max: 'high' };

/** Effort guidance appended to prompts for harnesses without a native knob. */
export const EFFORT_GUIDANCE = {
  low: 'Effort: LOW. Take the most direct path, keep changes minimal, skip exploration.',
  medium: 'Effort: MEDIUM. Balance speed and care; verify the main path works.',
  high: 'Effort: HIGH. Investigate thoroughly, consider edge cases, verify your work.',
  max: 'Effort: MAX. Be exhaustive: explore alternatives, test rigorously, double-check every change.',
};

/**
 * Harness definitions. `build(ctx)` returns the process to spawn:
 *   { command, args, env?, stdin? }
 * ctx = { agent, prompt, system, cwd, shellCommand }
 * The prompt is always passed as a single argv entry (never through a shell).
 */
export const HARNESSES = {
  mock: {
    name: 'Mock (simulated)',
    description: 'Built-in simulated agent. Produces deterministic output — great for trying flows without API keys.',
    binary: null,
    models: ['mock-small', 'mock-large'],
    nativeEffort: false,
  },
  'claude-code': {
    name: 'Claude Code',
    description: 'Anthropic Claude Code CLI in headless mode (claude -p).',
    binary: 'claude',
    models: ['opus', 'sonnet', 'haiku'],
    nativeEffort: true,
    build: ({ agent, prompt, system }) => ({
      command: 'claude',
      args: [
        '-p',
        prompt,
        '--output-format',
        'text',
        ...(agent.model ? ['--model', agent.model] : []),
        ...(system ? ['--append-system-prompt', system] : []),
        '--permission-mode',
        agent.config.permissionMode || 'acceptEdits',
        ...(agent.config.maxTurns ? ['--max-turns', String(agent.config.maxTurns)] : []),
      ],
      env: { MAX_THINKING_TOKENS: CLAUDE_THINKING[agent.effort] },
    }),
  },
  codex: {
    name: 'OpenAI Codex CLI',
    description: 'codex exec (non-interactive) with native reasoning effort.',
    binary: 'codex',
    models: ['gpt-5', 'gpt-5-codex', 'gpt-5-mini'],
    nativeEffort: true,
    build: ({ agent, prompt, system }) => ({
      command: 'codex',
      args: [
        'exec',
        ...(agent.model ? ['--model', agent.model] : []),
        '-c',
        `model_reasoning_effort="${CODEX_EFFORT[agent.effort]}"`,
        '--sandbox',
        agent.config.sandbox || 'workspace-write',
        '--skip-git-repo-check',
        system ? `${system}\n\n${prompt}` : prompt,
      ],
    }),
  },
  'kiro-cli': {
    name: 'Kiro CLI',
    description: 'kiro-cli chat in non-interactive mode.',
    binary: 'kiro-cli',
    models: ['auto', 'claude-sonnet-4.5', 'claude-haiku-4.5'],
    nativeEffort: false,
    build: ({ agent, prompt, system }) => ({
      command: 'kiro-cli',
      args: [
        'chat',
        '--no-interactive',
        '--trust-all-tools',
        ...(agent.model && agent.model !== 'auto' ? ['--model', agent.model] : []),
        system ? `${system}\n\n${prompt}` : prompt,
      ],
    }),
  },
  gemini: {
    name: 'Gemini CLI',
    description: 'Google Gemini CLI (gemini -p).',
    binary: 'gemini',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    nativeEffort: false,
    build: ({ agent, prompt, system }) => ({
      command: 'gemini',
      args: [...(agent.model ? ['-m', agent.model] : []), '--yolo', '-p', system ? `${system}\n\n${prompt}` : prompt],
    }),
  },
  aider: {
    name: 'Aider',
    description: 'aider --message (one-shot) for git-aware edits.',
    binary: 'aider',
    models: ['sonnet', 'gpt-4.1', 'deepseek'],
    nativeEffort: false,
    build: ({ agent, prompt, system }) => ({
      command: 'aider',
      args: [...(agent.model ? ['--model', agent.model] : []), '--yes-always', '--no-pretty', '--message', system ? `${system}\n\n${prompt}` : prompt],
    }),
  },
  shell: {
    name: 'Shell command',
    description: 'Runs the task input `command` (or the agent command template) with sh -c. No LLM.',
    binary: 'sh',
    models: [],
    nativeEffort: false,
    build: ({ agent, shellCommand }) => {
      const command = shellCommand || agent.config.command;
      if (!command) throw new Error('shell harness needs task input {"command": "..."} or an agent command');
      return { command: 'sh', args: ['-c', command] };
    },
  },
  custom: {
    name: 'Custom CLI template',
    description: 'Any CLI. Template tokens: {prompt} {system} {model} {effort} {cwd}. Example: mycli run --model {model} {prompt}',
    binary: null,
    models: [],
    nativeEffort: false,
    build: ({ agent, prompt, system, cwd }) => {
      const template = agent.config.command;
      if (!template) throw new Error('custom harness needs a command template');
      const values = { prompt, system: system || '', model: agent.model || '', effort: agent.effort, cwd: cwd || '' };
      const [command, ...args] = splitCommand(template).map((token) => token.replace(/\{(prompt|system|model|effort|cwd)\}/g, (_, k) => values[k]));
      return { command, args };
    },
  },
};

/**
 * Splits a command template into argv tokens honouring single/double quotes
 * and backslash escapes. No shell is ever involved.
 */
export function splitCommand(template) {
  const tokens = [];
  let current = '';
  let quote = null;
  let inToken = false;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < template.length) current += template[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === '\\' && i + 1 < template.length) {
      current += template[++i];
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote) throw new Error('Unterminated quote in command template');
  if (inToken) tokens.push(current);
  return tokens;
}

/** Whether `binary` is found on PATH. */
export function isInstalled(binary) {
  if (!binary) return true;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, binary), constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

export function listHarnesses() {
  return Object.entries(HARNESSES).map(([id, h]) => ({
    id,
    name: h.name,
    description: h.description,
    binary: h.binary,
    models: h.models,
    nativeEffort: h.nativeEffort,
    installed: isInstalled(h.binary),
  }));
}

/**
 * Resolves how to run an agent. Returns { kind: 'builtin', harness } for the
 * mock harness, or { kind: 'process', command, args, env, display } otherwise.
 * Extra args and env from the agent config are merged in.
 */
export function prepareInvocation(agent, ctx) {
  const def = HARNESSES[agent.harness];
  if (!def) throw new Error(`Unknown harness: ${agent.harness}`);
  if (!def.build) return { kind: 'builtin', harness: agent.harness };
  const system = def.nativeEffort ? ctx.system : [ctx.system, EFFORT_GUIDANCE[agent.effort]].filter(Boolean).join('\n\n');
  const spec = def.build({ agent, ...ctx, system });
  const args = [...spec.args, ...(agent.config.extraArgs || [])];
  const env = Object.fromEntries(Object.entries({ ...(spec.env || {}), ...(agent.config.env || {}) }).filter(([, v]) => v !== undefined));
  const display = [spec.command, ...args.map((a) => (a.length > 60 ? `<${a.length} chars>` : /\s/.test(a) ? JSON.stringify(a) : a))].join(' ');
  return { kind: 'process', command: spec.command, args, env, display };
}

/** Guesses a tier from a model name when the user didn't set one. */
export function inferTier(model = '') {
  const m = model.toLowerCase();
  if (/(haiku|mini|flash|small|nano|lite|8b|mock-small)/.test(m)) return 1;
  if (/(opus|o3|pro|ultra|large|gpt-5(?!-mini)|mock-large)/.test(m)) return 3;
  return 2;
}
