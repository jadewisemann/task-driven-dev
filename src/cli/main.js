import { createApp } from '../server/app.js';
import { serve } from './serve.js';

const HELP = `todo.devs — agent kanban with dependency scheduling

Usage:
  todo-devs serve [--port 7420] [--host 127.0.0.1] [--home DIR]   Start web UI + API
  todo-devs call <method> [json-params]                            Call any RPC method
  todo-devs methods                                                List RPC methods

Global flags:
  --home DIR   data directory (default: $TODO_DEVS_HOME or ~/.todo-devs)
  --json       print raw JSON
`;

function parseParams(raw) {
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`params must be valid JSON, got: ${raw}`);
  }
}

/** Runs a single RPC call against an in-process app instance. */
async function callOnce(flags, method, params) {
  const app = createApp({ home: flags.home, log: () => {} });
  try {
    return await app.call(method, params);
  } finally {
    await app.close();
  }
}

export function print(value, flags) {
  if (flags.json || typeof value !== 'object' || value === null) {
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  } else if (Array.isArray(value) && value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
    console.table(value);
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

/** @returns {Promise<number|void>} exit code */
export async function runCli(positionals, flags) {
  const [command, ...rest] = positionals;
  switch (command) {
    case 'serve': {
      const allowedHosts = typeof flags['allow-host'] === 'string' ? flags['allow-host'].split(',') : [];
      await serve({ home: flags.home, port: flags.port ?? 7420, host: flags.host ?? '127.0.0.1', allowedHosts });
      return new Promise(() => {}); // keep running until a signal arrives
    }
    case 'call': {
      if (!rest[0]) throw new Error('usage: todo-devs call <method> [json-params]');
      print(await callOnce(flags, rest[0], parseParams(rest[1])), { ...flags, json: true });
      return 0;
    }
    case 'methods':
      print(await callOnce(flags, 'system.methods', {}), flags);
      return 0;
    case undefined:
    case 'help':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      return 1;
  }
}
