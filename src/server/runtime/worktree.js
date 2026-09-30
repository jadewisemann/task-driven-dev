import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess } from './process.js';

/** Serialises git operations per repository (worktree add/merge touch shared refs & locks). */
const repoLocks = new Map();
function withRepoLock(repo, fn) {
  const prev = repoLocks.get(repo) || Promise.resolve();
  const next = prev.then(fn, fn);
  repoLocks.set(
    repo,
    next.catch(() => {}),
  );
  return next;
}

async function git(cwd, args, { allowFail = false } = {}) {
  const res = await runProcess({ command: 'git', args, cwd, env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 120_000 });
  if (res.code !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || res.stdout).trim()}`);
  return { ok: res.code === 0, out: res.stdout.trim(), err: res.stderr.trim() };
}

/** The user's git identity when configured, else a bot identity (merges and commits both need one). */
async function identityArgs(cwd) {
  const hasIdentity = (await git(cwd, ['config', 'user.email'], { allowFail: true })).out !== '';
  return hasIdentity ? [] : ['-c', 'user.name=todo-devs', '-c', 'user.email=todo-devs@localhost'];
}

export async function isGitRepo(path) {
  if (!path || !existsSync(path)) return false;
  const res = await git(path, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  return res.ok && res.out === 'true';
}

const slugify = (text) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'task';

export const branchFor = (task) => `todo-devs/${task.id.split('_')[1]}-${slugify(task.title)}`;

/**
 * Creates (or reuses) an isolated worktree for a task and merges the branches
 * of its finished predecessors so the agent starts from their combined work.
 *
 * @returns {Promise<{path: string, branch: string, merged: string[], conflicts: string[]}>}
 */
export function ensureWorktree({ repoPath, root, task, baseRef = 'HEAD', upstreamBranches = [], clean = false, log = () => {} }) {
  return withRepoLock(repoPath, async () => {
    // The branch is fixed at first run; renaming the task later must not orphan its work.
    const branch = task.branch || branchFor(task);
    const path = task.worktreePath || join(root, task.id);
    mkdirSync(root, { recursive: true });
    if (existsSync(join(path, '.git'))) {
      log(`reusing worktree ${path} (${branch})`);
      if (clean) {
        await git(path, ['reset', '--hard', '-q']);
        await git(path, ['clean', '-fdq']);
        log('discarded uncommitted changes from the previous attempt');
      }
    } else {
      const exists = (await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).ok;
      await git(repoPath, ['worktree', 'prune'], { allowFail: true });
      if (exists) await git(repoPath, ['worktree', 'add', path, branch]);
      else await git(repoPath, ['worktree', 'add', '-b', branch, path, baseRef]);
      log(`created worktree ${path} on ${branch} from ${exists ? 'existing branch' : baseRef}`);
    }
    const merged = [];
    const conflicts = [];
    for (const upstream of upstreamBranches) {
      const known = (await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${upstream}`], { allowFail: true })).ok;
      if (!known) {
        conflicts.push(upstream);
        log(`WARNING: predecessor branch ${upstream} not found — its work is not included`);
        continue;
      }
      const res = await git(path, [...(await identityArgs(path)), 'merge', '--no-edit', '--no-ff', '-m', `todo-devs: merge ${upstream}`, upstream], { allowFail: true });
      if (res.ok) {
        merged.push(upstream);
        log(`merged predecessor branch ${upstream}`);
      } else {
        await git(path, ['merge', '--abort'], { allowFail: true });
        conflicts.push(upstream);
        log(`WARNING: could not merge ${upstream} — continuing without it: ${(res.err || res.out).split('\n')[0]}`);
      }
    }
    return { path, branch, merged, conflicts };
  });
}

/** Commits everything in the worktree. Returns the new commit sha, or null if nothing changed. */
export function commitAll({ repoPath, path, message }) {
  return withRepoLock(repoPath, async () => {
    await git(path, ['add', '-A']);
    const status = await git(path, ['status', '--porcelain']);
    if (!status.out) return null;
    await git(path, [...(await identityArgs(path)), 'commit', '-q', '-m', message]);
    return (await git(path, ['rev-parse', 'HEAD'])).out;
  });
}

export function scratchDir(home, task) {
  const dir = join(home || process.cwd(), 'scratch', task.id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
