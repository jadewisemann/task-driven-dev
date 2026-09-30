/**
 * Minimal argv parser: positionals, `--key value`, `--key=value`, `--flag`.
 * Flags listed in `booleans` never consume the following token.
 */
export function parseArgs(argv, { booleans = [] } = {}) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (booleans.includes(key) || next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { positionals, flags };
}
