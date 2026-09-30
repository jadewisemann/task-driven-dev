// Browser tests for the web UI. Needs Playwright:
//   npm i --no-save playwright && npx playwright install chromium
// (or set PLAYWRIGHT_CORE_DIR / CHROMIUM_PATH to use an existing install).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { listen, makeApp, setup } from '../helpers.js';

process.env.TODO_DEVS_MOCK_DELAY_MS = '300';

async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    if (!process.env.PLAYWRIGHT_CORE_DIR) throw new Error('Playwright is not installed: npm i --no-save playwright && npx playwright install chromium');
    return createRequire(`${process.env.PLAYWRIGHT_CORE_DIR}/`)('playwright-core').chromium;
  }
}

let browser;
before(async () => {
  const chromium = await loadChromium();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--no-proxy-server'] });
});
after(() => browser?.close());

/**
 * A fresh server + page. Call `done()` at the end of the test: it closes the
 * page (before the server goes away) and fails on any browser console error.
 */
async function openBoard(t, { allMock = false } = {}) {
  const app = makeApp(t);
  await setup(app, { allMock });
  const { url } = await listen(t, app);
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  let closed = false;
  const done = async () => {
    closed = true;
    await context.close();
    assert.deepEqual(errors, [], 'browser console errors');
  };
  t.after(() => !closed && context.close());
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.board');
  return { app, page, done };
}

async function addCard(page, column, title) {
  const input = page.locator(`.col-${column} .quick-add`);
  await input.fill(title);
  await input.press('Enter');
  await page.waitForSelector(`.card >> text=${title}`);
}

async function assign(page, agent, title) {
  await page.dragAndDrop(`.roster-chip >> text=${agent}`, `.card >> text=${title}`);
  await page.waitForSelector(`.card:has-text("${title}") .card-footer:has-text("${agent}")`);
}

async function dependsOn(page, title, predecessor) {
  await page.click(`.card >> text=${title}`);
  await page.click(`.dep-item >> text=${predecessor}`);
  await page.click('.drawer .btn.primary');
  await page.waitForSelector('.drawer', { state: 'detached' });
}

test('board: add cards, drag between columns, dependencies, drawer assignment', async (t) => {
  const { app, page, done } = await openBoard(t);
  await addCard(page, 'backlog', 'Design schema');
  await addCard(page, 'backlog', 'Build API');
  await dependsOn(page, 'Build API', 'Design schema');
  await page.dragAndDrop('.card >> text=Design schema', '.col-todo .column-list');
  await page.waitForSelector('.col-todo .card >> text=Design schema');
  await page.waitForSelector('.card:has-text("Build API") .deps.waiting');
  await assign(page, 'Forge', 'Build API');
  await page.click('.card >> text=Build API');
  await page.locator('.drawer label.field:has-text("Assignee") select').selectOption({ label: 'Sprint (engineer, T1)' });
  await page.click('.drawer .btn.primary');
  await page.waitForSelector('.card:has-text("Build API") .card-footer:has-text("Sprint")');
  const [p] = await app.call('projects.list');
  const tasks = await app.call('tasks.list', { projectId: p.id });
  const api = tasks.find((x) => x.title === 'Build API');
  assert.deepEqual(api.dependsOn, [tasks.find((x) => x.title === 'Design schema').id]);
  await done();
});

test('runner: Run all executes in dependency order with live logs', async (t) => {
  const { page, done } = await openBoard(t);
  for (const title of ['A first', 'B second']) {
    await addCard(page, 'todo', title);
    await assign(page, 'Mocky', title);
  }
  await dependsOn(page, 'B second', 'A first');
  await page.click('text=▶ Run all');
  await page.click('.modal .btn.primary');
  await page.waitForSelector('.sched-finished', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('.col-done .card').length === 2);
  await page.click('.card >> text=B second');
  await page.waitForSelector('.log-console span');
  assert.match(await page.locator('.log-console').innerText(), /Mocky/);
  await page.keyboard.press('Escape');
  await page.click('a[href="#/runs"]');
  await page.waitForSelector('.run-item');
  assert.equal(await page.locator('.run-item').count(), 2);
  await done();
});

test('agents: edit effort from the editor and preview the prompt', async (t) => {
  const { app, page, done } = await openBoard(t);
  await addCard(page, 'todo', 'Some task');
  await page.click('a[href="#/agents"]');
  await page.click('.agent-card >> text=Forge');
  await page.click('.seg >> text=max');
  await page.click('text=Show what this agent sees');
  await page.waitForSelector('.preview-block');
  await page.click('.drawer .btn.primary');
  await page.waitForSelector('.agent-card:has-text("Forge") .spec:has-text("max")');
  assert.equal((await app.call('agents.list')).find((a) => a.name === 'Forge').effort, 'max');
  await done();
});

test('workflows: create from template, connect a node, run it', async (t) => {
  const { page, done } = await openBoard(t, { allMock: true });
  await page.click('a[href="#/workflows"]');
  await page.click('text=+ New workflow');
  await page.fill('.modal input[name=name]', 'Triage');
  await page.selectOption('.modal select[name=template]', 'json-triage');
  await page.click('.modal .btn.primary');
  await page.waitForSelector('.wf-node');
  assert.equal(await page.locator('.wf-node').count(), 6);
  const edgesBefore = await page.locator('.wf-edge-group').count();
  await page.click('.pal-item:has-text("Transform")');
  await page.locator('.wf-node:has-text("Incoming item") .port-out').first().dragTo(page.locator('.wf-node:has-text("Transform") .wf-node-body'));
  await page.waitForFunction((n) => document.querySelectorAll('.wf-edge-group').length === n, edgesBefore + 1);
  await page.click('.save-btn');
  // Hold the workflows.run response so the run's finished event always arrives first
  // (regression test: the panel used to stay on "running…").
  await page.route('**/api/rpc', async (route) => {
    const response = await route.fetch();
    if ((route.request().postData() || '').includes('"workflows.run"')) await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({ response });
  });
  await page.click('text=▶ Run');
  await page.click('.modal .btn.primary');
  await page.waitForFunction(() => /succeeded|failed|cancelled/.test(document.querySelector('.run-status')?.textContent || ''), null, { timeout: 15000 });
  assert.match(await page.locator('.run-status').innerText(), /succeeded/);
  await done();
});

test('orchestrator: plan a goal, review the draft, run it to the end', async (t) => {
  const { page, done } = await openBoard(t, { allMock: true });
  await page.click('a[href="#/flow"]');
  await page.fill('.composer textarea', '- Design the users database schema\n- Build the signup REST API\n- Write e2e tests');
  await page.click('text=Plan only');
  await page.waitForSelector('.plan-table');
  assert.equal(await page.locator('.plan-table tbody tr:not(.desc-row)').count(), 4);
  await page.click('text=▶ Run plan');
  await page.waitForSelector('.plan-finished', { timeout: 30000 });
  assert.equal(await page.locator('.dag-node.status-done').count(), 4);
  await done();
});

test('settings: version, health checks and alpha feedback link', async (t) => {
  const { page, done } = await openBoard(t);
  await page.click('.alpha-tag');
  await page.waitForSelector('.doctor-table tr');
  assert.match(await page.locator('.alpha-badge').innerText(), /alpha · v\d/);
  assert.ok((await page.locator('.doctor-table tr').count()) >= 6);
  assert.match(await page.locator('a:has-text("Report an issue")').getAttribute('href'), /\/issues$/);
  await done();
});
