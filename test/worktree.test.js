import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeApp, nextEvent, tmpHome } from './helpers.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd }).toString().trim();

test('worktrees: each task on its own branch, successors start from predecessor work', async (t) => {
  const base = tmpHome(t);
  const repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const app = makeApp(t, { home: join(base, 'home') });
  const project = await app.call('projects.create', { name: 'wt', repoPath: repo });
  const sh = await app.call('agents.create', {
    name: 'Shelly',
    harness: 'shell',
    config: { command: 'ls > seen.txt; echo "$(basename "$(pwd)")" > "file-$(basename "$(pwd)").txt"; echo done', allowTaskCommand: true },
  });
  const A = await app.call('tasks.create', { projectId: project.id, title: 'Write A', status: 'todo', assigneeId: sh.id });
  const B = await app.call('tasks.create', { projectId: project.id, title: 'Write B', status: 'todo', assigneeId: sh.id, dependsOn: [A.id] });
  const bad = await app.call('tasks.create', { projectId: project.id, title: 'Bad', status: 'todo', assigneeId: sh.id, input: { command: 'exit 3' } });
  const finished = nextEvent(app, (e) => e.type === 'scheduler.finished', 60000);
  await app.call('scheduler.start', { projectId: project.id });
  await finished;

  const a = await app.call('tasks.get', { id: A.id });
  const b = await app.call('tasks.get', { id: B.id });
  assert.equal(a.status, 'done');
  assert.equal(b.status, 'done');
  assert.equal((await app.call('tasks.get', { id: bad.id })).status, 'failed');
  assert.match(a.branch, /^todo-devs\/.+-write-a$/);
  assert.ok(a.result.commit, 'work is committed');
  assert.ok(existsSync(join(b.worktreePath, `file-${A.id}.txt`)), "B's worktree contains A's file");
  assert.match(readFileSync(join(b.worktreePath, 'seen.txt'), 'utf8'), new RegExp(`file-${A.id}`));
  assert.match(git(repo, 'branch', '--list', 'todo-devs/*'), /write-b/);
  assert.match(git(b.worktreePath, 'log', '--oneline'), /merge todo-devs\//);

  // Renaming a task keeps its branch (successors can still find its work).
  await app.call('tasks.update', { id: A.id, title: 'Renamed A' });
  assert.equal((await app.call('tasks.get', { id: A.id })).branch, a.branch);
});
