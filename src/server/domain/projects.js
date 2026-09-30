import { parseJson, toJson } from '../core/db.js';
import { check, invalidParams, notFound } from '../core/errors.js';
import { newId, now } from '../core/ids.js';

const mapRow = (r) =>
  r && {
    id: r.id,
    name: r.name,
    description: r.description,
    repoPath: r.repo_path,
    settings: parseJson(r.settings, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

export function createProjectService({ db, bus }) {
  const svc = {
    list() {
      return db.all('SELECT * FROM projects ORDER BY created_at').map(mapRow);
    },

    get(id) {
      const project = mapRow(db.get('SELECT * FROM projects WHERE id = ?', [id]));
      if (!project) throw notFound('Project', id);
      return project;
    },

    create({ name, description = '', repoPath = null, settings = {} }) {
      const id = newId('prj');
      const ts = now();
      db.run('INSERT INTO projects (id, name, description, repo_path, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        id,
        name,
        description,
        repoPath,
        toJson(settings),
        ts,
        ts,
      ]);
      const project = svc.get(id);
      bus.publish('project.created', { project });
      return project;
    },

    update(id, patch) {
      const current = svc.get(id);
      const next = { ...current, ...patch, settings: { ...current.settings, ...(patch.settings || {}) } };
      db.run('UPDATE projects SET name = ?, description = ?, repo_path = ?, settings = ?, updated_at = ? WHERE id = ?', [
        next.name,
        next.description,
        next.repoPath,
        toJson(next.settings),
        now(),
        id,
      ]);
      const project = svc.get(id);
      bus.publish('project.updated', { project });
      return project;
    },

    delete(id) {
      svc.get(id);
      db.run('DELETE FROM projects WHERE id = ?', [id]);
      bus.publish('project.deleted', { projectId: id });
      return { ok: true };
    },

    /** Guarantees at least one project exists (first boot). */
    ensureDefault() {
      const first = db.get('SELECT * FROM projects ORDER BY created_at LIMIT 1');
      return first ? mapRow(first) : svc.create({ name: 'My Project', description: 'Default board' });
    },
  };
  return svc;
}

export function registerProjectRpc(rpc, projects) {
  const patchFrom = (p) => {
    const patch = {};
    if (p.name !== undefined) patch.name = check.string(p, 'name');
    if (p.description !== undefined) patch.description = check.string(p, 'description', { allowEmpty: true });
    if (p.repoPath !== undefined) patch.repoPath = p.repoPath === null ? null : check.string(p, 'repoPath');
    if (p.settings !== undefined) {
      if (typeof p.settings !== 'object' || p.settings === null) throw invalidParams('"settings" must be an object');
      patch.settings = p.settings;
    }
    return patch;
  };
  rpc.group('projects', {
    list: { handler: () => projects.list(), description: 'List projects' },
    get: { handler: (p) => projects.get(check.string(p, 'id')), description: 'Get a project' },
    create: {
      handler: (p) => projects.create({ ...patchFrom(p), name: check.string(p, 'name') }),
      description: 'Create a project {name, description?, repoPath?}',
    },
    update: { handler: (p) => projects.update(check.string(p, 'id'), patchFrom(p)), description: 'Update a project' },
    delete: { handler: (p) => projects.delete(check.string(p, 'id')), description: 'Delete a project and its tasks' },
  });
}
