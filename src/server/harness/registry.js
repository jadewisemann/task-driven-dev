import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Reasoning effort levels an agent can be configured with. */
export const EFFORTS = ['low', 'medium', 'high', 'max'];

/** Model tiers used by the orchestrator: 1 = small/fast, 2 = standard, 3 = frontier. */
export const TIERS = [1, 2, 3];

/**
 * Autonomy posture, mapped consistently onto each harness's permission flags:
 *   safe — may read and edit files in its working directory, no arbitrary shell
 *   auto — may also run commands (tests, builds) inside the working directory
 *   full — no guard rails (bypass permission prompts / sandbox). Use with care.
 */
export const AUTONOMY = ['safe', 'auto', 'full'];

/** Longest single argv entry we will hand to spawn (Linux MAX_ARG_STRLEN is 128 KiB). */
export const MAX_ARG_CHARS = 100_000;

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

const CLAUDE_AUTONOMY = {
  safe: ['--permission-mode', 'acceptEdits'],
  auto: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep'],
  full: ['--permission-mode', 'bypassPermissions'],
};
const CODEX_AUTONOMY = {
  safe: ['--sandbox', 'workspace-write'],
  auto: ['--full-auto'],
  full: ['--sandbox', 'danger-full-access'],
};
const GEMINI_AUTONOMY = { safe: ['--approval-mode', 'auto_edit'], auto: ['--approval-mode', 'auto_edit'], full: ['--yolo'] };
const KIRO_AUTONOMY = { safe: ['--trust-tools=fs_read,fs_write'], auto: ['--trust-all-tools'], full: ['--trust-all-tools'] };
const AIDER_AUTONOMY = { safe: ['--yes-always', '--no-suggest-shell-commands'], auto: ['--yes-always'], full: ['--yes-always'] };

const withSystem = (system, prompt) => (system ? `${system}\n\n---\n\n${prompt}` : prompt);

/**
 * Harness definitions. `build(ctx)` returns the process to spawn:
 *   { command, args, env?, stdin? }
 * ctx = { agent, prompt, system, cwd, shellCommand, promptFile, extra }
 *   - prompts go through stdin (or a prompt file) wherever the CLI supports it,
 *     so their size is not bounded by argv limits and they never touch a shell;
 *   - `extra` are the agent's extraArgs, placed before any positional argument.
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
    description: 'Anthropic Claude Code CLI in headless mode (claude -p, prompt on stdin).',
    binary: 'claude',
    models: ['opus', 'sonnet', 'haiku'],
    nativeEffort: true,
    build: ({ agent, prompt, system, extra }) => ({
      command: 'claude',
      args: [
        '-p',
        '--output-format',
        'text',
        ...(agent.model ? ['--model', agent.model] : []),
        ...(system ? ['--append-system-prompt', system] : []),
        ...CLAUDE_AUTONOMY[agent.config.autonomy],
        ...(agent.config.maxTurns ? ['--max-turns', String(agent.config.maxTurns)] : []),
        ...extra,
      ],
      env: { MAX_THINKING_TOKENS: CLAUDE_THINKING[agent.effort] },
      stdin: prompt,
    }),
  },
  codex: {
    name: 'OpenAI Codex CLI',
    description: 'codex exec (non-interactive, prompt on stdin) with native reasoning effort.',
    binary: 'codex',
    models: ['gpt-5', 'gpt-5-codex', 'gpt-5-mini'],
    nativeEffort: true,
    build: ({ agent, prompt, system, extra }) => ({
      command: 'codex',
      args: [
        'exec',
        ...(agent.model ? ['--model', agent.model] : []),
        '-c',
        `model_reasoning_effort="${CODEX_EFFORT[agent.effort]}"`,
        ...CODEX_AUTONOMY[agent.config.autonomy],
        '--skip-git-repo-check',
        ...extra,
        '-', // read the prompt from stdin
      ],
      stdin: withSystem(system, prompt),
    }),
  },
  'kiro-cli': {
    name: 'Kiro CLI',
    description: 'kiro-cli chat in non-interactive mode.',
    binary: 'kiro-cli',
    models: ['auto', 'claude-sonnet-4.5', 'claude-haiku-4.5'],
    nativeEffort: false,
    build: ({ agent, prompt, system, extra }) => ({
      command: 'kiro-cli',
      args: [
        'chat',
        '--no-interactive',
        ...KIRO_AUTONOMY[agent.config.autonomy],
        ...(agent.model && agent.model !== 'auto' ? ['--model', agent.model] : []),
        ...extra,
        withSystem(system, prompt),
      ],
    }),
  },
  gemini: {
    name: 'Gemini CLI',
    description: 'Google Gemini CLI, non-interactive (prompt on stdin).',
    binary: 'gemini',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    nativeEffort: false,
    build: ({ agent, prompt, system, extra }) => ({
      command: 'gemini',
      args: [...(agent.model ? ['-m', agent.model] : []), ...GEMINI_AUTONOMY[agent.config.autonomy], ...extra],
      stdin: withSystem(system, prompt),
    }),
  },
  aider: {
    name: 'Aider',
    description: 'aider --message-file (one-shot) for git-aware edits.',
    binary: 'aider',
    models: ['sonnet', 'gpt-4.1', 'deepseek'],
    nativeEffort: false,
    build: ({ agent, prompt, system, extra, promptFile }) => ({
      command: 'aider',
      args: [...(agent.model ? ['--model', agent.model] : []), ...AIDER_AUTONOMY[agent.config.autonomy], '--no-pretty', ...extra, '--message-file', promptFile],
      promptFileContent: withSystem(system, prompt),
    }),
  },
  shell: {
    name: 'Shell command',
    description: 'Runs the agent command (or, if allowed, the task input `command`) with sh -c. No LLM.',
    binary: 'sh',
    models: [],
    nativeEffort: false,
    build: ({ agent, shellCommand }) => {
      const taskCommand = agent.config.allowTaskCommand && typeof shellCommand === 'string' && shellCommand.trim() ? shellCommand : null;
      const command = taskCommand || agent.config.command;
      if (!command || !command.trim()) {
        throw new Error('shell harness needs an agent command (or allowTaskCommand + task input {"command": "..."})');
      }
      return { command: 'sh', args: ['-c', command] };
    },
  },
  custom: {
    name: 'Custom CLI template',
    description: 'Any CLI. Tokens: {prompt} {prompt_file} {system} {model} {effort} {cwd}. Use {stdin} alone to pipe the prompt. Example: mycli run --model {model} {prompt_file}',
    binary: null,
    models: [],
    nativeEffort: false,
    build: ({ agent, prompt, system, cwd, extra, promptFile }) => {
      const tokens = splitCommand(agent.config.command || '');
      if (tokens.length === 0) throw new Error('custom harness needs a command template');
      const useStdin = tokens.includes('{stdin}');
      const values = { prompt, prompt_file: promptFile, system: system || '', model: agent.model || '', effort: agent.effort, cwd: cwd || '' };
      const [command, ...args] = tokens.filter((t) => t !== '{stdin}').map((t) => t.replace(/\{(prompt_file|prompt|system|model|effort|cwd)\}/g, (_, k) => values[k]));
      const usesFile = tokens.some((t) => t.includes('{prompt_file}'));
      return {
        command,
        args: [...args, ...extra],
        ...(useStdin ? { stdin: prompt } : {}),
        ...(usesFile ? { promptFileContent: prompt } : {}),
      };
    },
  },
};

/**
 * Splits a command template into argv tokens with POSIX-like quoting:
 * single quotes are literal; inside double quotes a backslash only escapes
 * `"` and `\` (so Windows paths survive); outside quotes it escapes any char.
 * No shell is ever involved.
 */
export function splitCommand(template) {
  const tokens = [];
  let current = '';
  let quote = null;
  let inToken = false;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && (template[i + 1] === '"' || template[i + 1] === '\\')) current += template[++i];
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
 * mock harness, or a process spec:
 *   { kind: 'process', command, args, env, stdin?, promptFile?, promptFileContent?, display }
 * `ctx.promptFile` is the path the runner will write `promptFileContent` to.
 */
export function prepareInvocation(agent, ctx) {
  const def = HARNESSES[agent.harness];
  if (!def) throw new Error(`Unknown harness: ${agent.harness}`);
  if (!def.build) return { kind: 'builtin', harness: agent.harness };
  const system = def.nativeEffort ? ctx.system : [ctx.system, EFFORT_GUIDANCE[agent.effort]].filter(Boolean).join('\n\n');
  const promptFile = ctx.promptFile || '<prompt-file>';
  const spec = def.build({ agent, ...ctx, system, promptFile, extra: agent.config.extraArgs || [] });
  if (!spec.command) throw new Error(`${agent.harness} harness produced an empty command`);
  const tooLong = spec.args.find((a) => a.length > MAX_ARG_CHARS);
  if (tooLong) {
    throw new Error(`Prompt is too large to pass as a CLI argument (${tooLong.length} chars). Lower the agent's context graph limits or use a harness that reads stdin.`);
  }
  const env = Object.fromEntries(Object.entries({ ...(spec.env || {}), ...(agent.config.env || {}) }).filter(([, v]) => v !== undefined));
  const display = [spec.command, ...spec.args.map((a) => (a.length > 60 ? `<${a.length} chars>` : /\s/.test(a) ? JSON.stringify(a) : a))].join(' ') + (spec.stdin ? ` < prompt(${spec.stdin.length} chars)` : '');
  return {
    kind: 'process',
    command: spec.command,
    args: spec.args,
    env,
    ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
    ...(spec.promptFileContent !== undefined ? { promptFile, promptFileContent: spec.promptFileContent } : {}),
    display,
  };
}

/** Guesses a tier from a model name when the user didn't set one. */
export function inferTier(model = '') {
  const m = model.toLowerCase();
  // Whole-word match so e.g. "gemini" does not count as "mini".
  const word = (w) => new RegExp(`(^|[-_.:/ ])${w}($|[-_.:/ ])`).test(m);
  if (['haiku', 'mini', 'flash', 'small', 'nano', 'lite'].some(word)) return 1;
  if (['opus', 'o3', 'pro', 'ultra', 'large'].some(word) || /^gpt-5($|-codex)/.test(m)) return 3;
  return 2;
}
