#!/usr/bin/env node
import { parseArgs } from '../src/cli/args.js';
import { runCli } from '../src/cli/main.js';

const { positionals, flags } = parseArgs(process.argv.slice(2), { booleans: ['help', 'json', 'run', 'watch', 'wait', 'auto-approve'] });

runCli(positionals, flags).then(
  (code) => {
    if (typeof code === 'number') process.exitCode = code;
  },
  (err) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  },
);
