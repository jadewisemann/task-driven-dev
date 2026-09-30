/**
 * Ordered schema migrations. Each feature appends its own entries; never edit
 * an entry that has shipped — add a new one instead.
 */
export const migrations = [
  {
    id: '001_projects_tasks',
    up: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        repo_path TEXT,
        settings TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'backlog',
        priority INTEGER NOT NULL DEFAULT 1,
        complexity INTEGER NOT NULL DEFAULT 2,
        position REAL NOT NULL DEFAULT 0,
        assignee_id TEXT,
        labels TEXT,
        input TEXT,
        output TEXT,
        result TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX idx_tasks_project ON tasks(project_id, status, position);
      CREATE TABLE task_deps (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, depends_on),
        CHECK (task_id <> depends_on)
      );
      CREATE INDEX idx_task_deps_depends_on ON task_deps(depends_on);
    `,
  },
  {
    id: '002_agents',
    up: `
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'generalist',
        persona TEXT NOT NULL DEFAULT '',
        harness TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        effort TEXT NOT NULL DEFAULT 'medium',
        tier INTEGER NOT NULL DEFAULT 2,
        color TEXT NOT NULL DEFAULT '#7c5cff',
        config TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
    `,
  },
];
