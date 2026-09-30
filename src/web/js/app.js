import { getPeer, onEvent, onPeerChange, rpc } from './api.js';
import { h, mountInto, promptForm, toast } from './dom.js';
import { views } from './views/index.js';
import { sessionSlot } from './session.js';

const PROJECT_KEY = 'todo-devs.project';
const state = { projects: [], projectId: null, viewId: null, unmount: null };

const projectKey = () => `${PROJECT_KEY}:${getPeer() || 'local'}`;
const els = {
  nav: document.getElementById('nav'),
  main: document.getElementById('main'),
  projectSlot: document.getElementById('project-slot'),
  sessionSlot: document.getElementById('session-slot'),
};

function currentProject() {
  return state.projects.find((p) => p.id === state.projectId) || null;
}

async function loadProjects() {
  state.projects = await rpc('projects.list');
  const saved = localStorage.getItem(projectKey());
  state.projectId = state.projects.some((p) => p.id === saved) ? saved : state.projects[0]?.id || null;
  renderProjectPicker();
}

function selectProject(id) {
  state.projectId = id;
  localStorage.setItem(projectKey(), id);
  renderProjectPicker();
  mountView();
}

async function createProject() {
  const values = await promptForm('New project', [
    { name: 'name', label: 'Name', placeholder: 'e.g. payments-service' },
    { name: 'repoPath', label: 'Git repository path (optional)', placeholder: '/home/me/code/repo' },
    { name: 'description', label: 'Description', type: 'textarea' },
  ]);
  if (!values?.name) return;
  const project = await rpc('projects.create', { name: values.name, description: values.description, repoPath: values.repoPath || null });
  await loadProjects();
  selectProject(project.id);
}

async function editProject() {
  const p = currentProject();
  if (!p) return;
  const values = await promptForm('Project settings', [
    { name: 'name', label: 'Name', value: p.name },
    { name: 'repoPath', label: 'Git repository path (worktrees are created here)', value: p.repoPath || '' },
    { name: 'description', label: 'Description / brief shared with agents', type: 'textarea', value: p.description },
  ]);
  if (!values) return;
  await rpc('projects.update', { id: p.id, name: values.name, description: values.description, repoPath: values.repoPath || null });
  await loadProjects();
  mountView();
}

function renderProjectPicker() {
  mountInto(
    els.projectSlot,
    h(
      'select',
      { class: 'project-select', title: 'Project', onChange: (e) => selectProject(e.target.value) },
      state.projects.map((p) => h('option', { value: p.id, selected: p.id === state.projectId }, p.name)),
    ),
    h('button', { class: 'icon-btn', title: 'Project settings', onClick: () => editProject().catch(showError) }, '⚙'),
    h('button', { class: 'icon-btn', title: 'New project', onClick: () => createProject().catch(showError) }, '＋'),
  );
}

function renderNav() {
  mountInto(
    els.nav,
    views.map((v) => h('a', { href: `#/${v.id}`, class: ['nav-item', v.id === state.viewId && 'active'] }, h('span', { class: 'nav-icon' }, v.icon), v.title)),
  );
}

function showError(err) {
  console.error(err);
  toast(err.message || String(err), 'error');
}

function mountView() {
  state.unmount?.();
  state.unmount = null;
  const view = views.find((v) => v.id === state.viewId) || views[0];
  state.viewId = view.id;
  renderNav();
  const root = h('div', { class: `view view-${view.id}` });
  mountInto(els.main, root);
  const ctx = {
    project: currentProject(),
    projects: state.projects,
    rpc,
    onEvent,
    showError,
    navigate: (id) => (location.hash = `#/${id}`),
    reloadProjects: () => loadProjects().then(mountView),
  };
  try {
    const cleanup = view.mount(root, ctx);
    state.unmount = typeof cleanup === 'function' ? cleanup : null;
  } catch (err) {
    showError(err);
  }
}

function route() {
  state.viewId = location.hash.replace(/^#\/?/, '').split('/')[0] || views[0].id;
  mountView();
}

async function boot() {
  sessionSlot(els.sessionSlot, { showError });
  try {
    await loadProjects();
  } catch (err) {
    showError(err);
  }
  onEvent((e) => {
    if (e.type.startsWith('project.')) loadProjects().catch(showError);
  });
  onPeerChange(async () => {
    try {
      await loadProjects();
    } catch (err) {
      state.projects = [];
      showError(err);
    }
    mountView();
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('unhandledrejection', (e) => showError(e.reason));
  route();
}

boot();
