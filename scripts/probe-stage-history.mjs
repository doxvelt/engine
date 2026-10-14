/** Node >=24; build UI first. Uses an externally installed Playwright, no repo dependency.
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs [CHROMIUM_EXECUTABLE=...] node scripts/probe-stage-history.mjs
 * Set PLAYWRIGHT_CDP_URL to attach to an already approved browser instead of launching.
 * Creates disposable .scratch fixtures/screenshots, serves real API + production Nuxt.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validStageBuffer } from '../src/local-ui/lib/stage-buffer.ts';
import { stageHistoryBrowserFixture } from './stage-history-browser-fixture.ts';

await mkdir('.scratch', { recursive: true });
const root = await mkdtemp(path.resolve('.scratch/stage-browser-'));
const apiPort = Number(process.env.STAGE_BROWSER_API_PORT || 8797);
const webPort = Number(process.env.STAGE_BROWSER_WEB_PORT || 3097);
const apiBase = `http://127.0.0.1:${apiPort}`, webOrigin = `http://127.0.0.1:${webPort}`;
const fixture = stageHistoryBrowserFixture(path.join(root, 'runtime.sqlite'), webOrigin);
let web, browser, activePage;
let webLog = '';
const ownedContexts = new Set();
const pageErrors = [];
const results = [];
try {
  fixture.server.listen(apiPort, '127.0.0.1');
  await once(fixture.server, 'listening');
  web = spawn(process.execPath, ['src/local-ui/.output/server/index.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(webPort), NUXT_PUBLIC_API_BASE: apiBase }, stdio: ['ignore', 'pipe', 'pipe'] });
  web.stdout.on('data', b => { webLog += b; }); web.stderr.on('data', b => { webLog += b; });
  for (let i = 0; i < 100; i++) {
    if (web.exitCode !== null) throw new Error(`Nuxt exited: ${webLog}`);
    try { if ((await fetch(webOrigin)).ok) break; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (i === 99) throw new Error(`Nuxt did not start: ${webLog}`);
  }
  const moduleName = process.env.PLAYWRIGHT_MODULE;
  if (!moduleName) throw new Error('Set PLAYWRIGHT_MODULE to an existing external Playwright installation. No dependency is installed by this harness.');
  const { chromium } = await import(pathToFileURL(path.resolve(moduleName)).href);
  browser = process.env.PLAYWRIGHT_CDP_URL
    ? await chromium.connectOverCDP(process.env.PLAYWRIGHT_CDP_URL)
    : await chromium.launch({ headless: true, chromiumSandbox: true,
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  function observe(page) {
    activePage = page;
    page.on('pageerror', error => pageErrors.push({ kind: 'pageerror', message: String(error), url: page.url() }));
    page.on('console', message => { if (message.type() === 'error') pageErrors.push({ kind: 'console', message: message.text(), url: page.url() }); });
    page.on('requestfailed', request => pageErrors.push({ kind: 'requestfailed', message: request.failure()?.errorText, url: request.url() }));
  }
  async function api(simulation, suffix, body) {
    const response = await fetch(`${apiBase}/simulations/${simulation}${suffix}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
  }
  async function recoverContinuation(width, height, action, entry) {
    const simulation = `recovery-${width}-${height}-${action}-${entry}`;
    const response = await fetch(`${apiBase}/simulations/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ simulationId: simulation, branchId: 'main', commandId: 'start', workspacePath: path.resolve('examples/executive-interviews'), scenarioId: 'executive-interviews' }) });
    assert.ok(response.ok, await response.clone().text());
    const context = await browser.newContext({ viewport: { width, height } });
    ownedContexts.add(context);
    let page = await context.newPage(); observe(page);
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    const url = `${webOrigin}/stage?simulation=${simulation}&branch=main`;
    const suffix = action === 'perform' ? '/turns' : '/drafts';
    const posts = [];
    let dropped = false;
    await context.route(`${apiBase}/simulations/${simulation}${suffix}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      posts.push(route.request().postDataJSON());
      // Commit/generate on the actual fixture API, then lose only its response.
      const result = await route.fetch();
      assert.ok(result.ok(), await result.text());
      if (!dropped) { dropped = true; await route.abort('failed'); }
      else await route.fulfill({ response: result });
    });
    await page.goto(url);
    await page.getByText('Saved in this browser only.', { exact: false }).waitFor();
    await page.getByRole('textbox', { name: 'Stage whisper', exact: true }).fill('RECOVERY-DIRECTION');
    await page.getByRole('tab', { name: 'Perform', exact: true }).click();
    await page.getByRole('textbox', { name: 'Performance', exact: true }).fill('RECOVERY-PERFORMANCE');
    if (action === 'generate') await page.getByRole('tab', { name: 'Stage whisper', exact: true }).click();
    const modelCalls = fixture.requests.length;
    await page.getByRole('button', { name: action === 'perform' ? 'Perform' : 'Generate draft', exact: true }).click();
    await page.getByRole('button', { name: 'Retry request', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.stage-dock .dx-error-note')?.textContent.includes('Failed to fetch'));
    assert.equal(posts.length, 1);
    const before = await api(simulation, '/stage?branchId=main');
    assert.equal(before.transcript.length, action === 'perform' ? 1 : 0);
    if (entry === 'reload') await page.reload();
    else {
      await page.close(); page = await context.newPage(); observe(page); page.on('pageerror', e => errors.push(String(e)));
      const opened = page.waitForResponse(r => r.url() === `${apiBase}/simulations/${simulation}/navigation` && r.request().method() === 'POST');
      await page.goto(url); assert.ok((await opened).ok(), 'fresh-entry navigation bookkeeping succeeds');
    }
    // Reload has no transient transport error. This must be a visible, usable
    // recovery action, never a direct call to the controller's resume method.
    const retry = page.getByRole('button', { name: 'Retry request', exact: true });
    await retry.waitFor(); assert.equal(await retry.isEnabled(), true);
    await page.getByText('A saved request is unresolved. Retry the original request to reconcile it.', { exact: true }).waitFor();
    assert.equal(posts.length, 1, 'reopening must not automatically submit another mutation');
    async function journal() {
      const records = await page.evaluate(sim => Object.keys(localStorage).filter(k => k.startsWith('doxvelt.stage.v1:')).map(k => JSON.parse(localStorage.getItem(k))).filter(r => r.scope.simulationId === sim), simulation);
      assert.ok(records.length > 0);
      for (const r of records) { assert.equal(validStageBuffer(r.data), true); assert.ok(r.data.requests.every(command => command.suffix !== '/navigation')); }
      const dominates = (a, b) => Object.entries(b).every(([id, n]) => (a[id] || 0) >= n);
      const heads = records.filter(r => !records.some(other => other !== r && dominates(other.clock, r.clock) && !dominates(r.clock, other.clock)));
      assert.equal(heads.length, 1, 'one authoritative browser buffer version');
      return heads[0].data;
    }
    const stored = await journal();
    assert.deepEqual(stored.requests.find(r => r.suffix === suffix).body, posts[0]);
    assert.equal(stored.performance, 'RECOVERY-PERFORMANCE'); assert.equal(stored.direction, 'RECOVERY-DIRECTION');
    await retry.click();
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Retry request'));
    assert.equal(posts.length, 2); assert.deepEqual(posts[1], posts[0], 'exact command ID and payload replay');
    const after = await api(simulation, '/stage?branchId=main');
    assert.equal(after.branch.headCommitId, before.branch.headCommitId);
    assert.equal(after.transcript.length, action === 'perform' ? 1 : 0, 'no duplicate canonical turn');
    assert.equal(fixture.requests.length, modelCalls + (action === 'generate' ? 1 : 0), 'no duplicate model call');
    assert.equal((await journal()).requests.length, 0);
    await page.getByRole('tab', { name: 'Stage whisper', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Stage whisper', exact: true }).inputValue(), 'RECOVERY-DIRECTION');
    await page.getByRole('tab', { name: 'Perform', exact: true }).click();
    const performance = page.getByRole('textbox', { name: 'Performance', exact: true });
    assert.equal(await performance.inputValue(), 'RECOVERY-PERFORMANCE');
    assert.equal(await performance.isEnabled(), true, 'Stage unlocks after reconciliation');
    await performance.fill('NEXT-INDEPENDENT-PERFORMANCE');
    await page.getByRole('button', { name: 'Perform', exact: true }).click();
    await page.getByText('NEXT-INDEPENDENT-PERFORMANCE', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Performance"]')?.disabled === false);
    assert.equal((await api(simulation, '/stage?branchId=main')).transcript.length, action === 'perform' ? 2 : 1);
    await page.getByRole('tab', { name: 'Stage whisper', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Stage whisper', exact: true }).inputValue(), 'RECOVERY-DIRECTION');
    await journal(); assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(root, `${width}x${height}-${action}-${entry}.png`), fullPage: true });
    results.push({ width, height, action, entry, visibleRetry: true, exactReplay: true, navigationExcluded: true, noDuplicate: true, continued: true, buffersPreserved: true });
    await context.close(); ownedContexts.delete(context); activePage = null;
  }
  for (const [width, height] of [[1440, 900], [1280, 600], [390, 844], [360, 640]]) {
    const simulation = `browser-${width}-${height}`;
    let response = await fetch(`${apiBase}/simulations/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ simulationId: simulation, branchId: 'main', commandId: 'start', workspacePath: path.resolve('examples/executive-interviews'), scenarioId: 'executive-interviews' }) });
    assert.ok(response.ok, await response.clone().text()); const started = await response.json();
    const draft = await api(simulation, '/drafts', { commandId: 'seed', branchId: 'main', expectedHead: started.root.id, actorId: 'ceo', audience: ['ceo'], stageWhisperIds: [], completeWhisper: 'ORIGIN-ELEPHANT', draftingPolicy: 'actor-knowledge-v1' });
    const accepted = await api(simulation, `/drafts/${draft.draft.id}/accept`, { commandId: 'accept-seed' });
    await api(simulation, '/turns', { commandId: 'later', branchId: 'main', expectedHead: accepted.commit.id, actorId: 'ceo', audience: ['ceo'], manualText: 'Later independent continuation', stageWhisperIds: [], knowledgePolicy: 'actor-knowledge-v1' });
    const originalProjection = await api(simulation, "/stage?branchId=main");
    const context = await browser.newContext({ viewport: { width, height } });
    ownedContexts.add(context);
    let page = await context.newPage(); observe(page);
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    const stageURL = `${webOrigin}/stage?simulation=${simulation}&branch=main`;
    await page.goto(stageURL);
    await page.getByText('Saved in this browser only.', { exact: false }).waitFor();
    await page.getByRole('textbox', { name: 'Stage whisper', exact: true }).fill('SUSPENDED-DIRECTION');
    await page.getByRole('tab', { name: 'Perform', exact: true }).click();
    await page.getByRole('textbox', { name: 'Performance', exact: true }).fill('SUSPENDED-PERFORMANCE');
    const revise = page.getByRole('button', { name: 'Revise / alternate paths' }).first();
    await revise.click();
    await page.getByRole('textbox', { name: 'Historical performance', exact: true }).fill('UNSENT-HISTORICAL');
    assert.equal(await page.locator('.stage-composer').count(), 0);
    await page.close(); page = await context.newPage(); observe(page); page.on('pageerror', e => errors.push(String(e))); await page.goto(stageURL);
    const historical = page.getByRole('textbox', { name: 'Historical performance', exact: true });
    await historical.waitFor(); assert.equal(await historical.inputValue(), 'UNSENT-HISTORICAL');
    await historical.press('Escape');
    assert.equal(await page.getByRole('textbox', { name: 'Performance', exact: true }).inputValue(), 'SUSPENDED-PERFORMANCE');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Revise / alternate paths');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-revise-turn')), originalProjection.transcript[0].messageVersionId, 'Escape returns focus to the selected immutable turn after reopen');
    await page.getByRole('tab', { name: 'Stage whisper', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Stage whisper', exact: true }).inputValue(), 'SUSPENDED-DIRECTION');
    await page.getByRole('button', { name: 'Revise / alternate paths' }).first().click();
    await page.getByRole('radio', { name: 'Regenerate / replace whisper' }).click();
    await page.getByRole('textbox', { name: 'Complete historical whisper', exact: true }).fill('LATEST-ONLY');
    const before = fixture.requests.length;
    await page.getByRole('button', { name: 'Generate saved alternative', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('branch') !== 'main');
    assert.equal(fixture.requests.length, before + 1);
    const request = fixture.requests.at(-1);
    assert.equal(request.context.routingDirection.completeWhisper, 'LATEST-ONLY');
    assert.ok(!request.prompt.includes('ORIGIN-ELEPHANT'));
    assert.ok(!request.prompt.includes('SUSPENDED-DIRECTION'));
    assert.ok(!request.prompt.includes('Later independent continuation'));
    assert.equal(await page.getByText('Later independent continuation', { exact: true }).count(), 0);
    // Cycle at the branching turn back to the source with its continuation intact.
    await page.getByRole('button', { name: 'Revise / alternate paths' }).first().click();
    const paths = await api(simulation, `/alternatives?${new URLSearchParams({ sourceBranchId: 'main', expectedHead: (await api(simulation, '/stage?branchId=main')).branch.headCommitId, sourceCommitId: accepted.commit.id, messageVersionId: (await api(simulation, '/stage?branchId=main')).transcript[0].messageVersionId, logicalMessageId: (await api(simulation, '/stage?branchId=main')).transcript[0].logicalMessageId, actorId: 'ceo' })}`);
    const originalIndex = paths.paths.findIndex(p => p.branchId === 'main') + 1;
    await page.getByRole('button', { name: `Select path ${originalIndex}: main`, exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('branch') === 'main');
    await page.getByText('Later independent continuation', { exact: true }).waitFor();
    // Navigation exposes the authoritative transcript before the asynchronous
    // browser overlay restore completes. Wait for that independent recovery gate.
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Stage whisper"]')?.value === 'SUSPENDED-DIRECTION');
    assert.equal(await page.getByRole('textbox', { name: 'Stage whisper', exact: true }).inputValue(), 'SUSPENDED-DIRECTION');
    await page.getByRole('button', { name: 'Revise / alternate paths' }).first().click();
    await page.getByRole('button', { name: 'Cancel · return to continuation', exact: true }).scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `horizontal overflow at ${width}x${height}`);
    await page.screenshot({ path: path.join(root, `${width}x${height}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    results.push({ width, height, closeReopen: true, suspendedModes: true, focusCancel: true, generatedAlternative: true, inputIsolation: true, cycleContinuation: true, overflow: false });
    await context.close(); ownedContexts.delete(context); activePage = null;
    for (const action of ['perform', 'generate']) for (const entry of ['reload', 'fresh']) await recoverContinuation(width, height, action, entry);
  }
  await writeFile(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`Deterministic real-browser proofs passed: ${root}. Live model quality, phone keyboards and assistive technology remain human gates.`);
} catch (error) {
  // Capture before closing our contexts. A screenshot failure must not obscure
  // the assertion or prevent the other diagnostics from being written.
  const captures = [];
  if (activePage && !activePage.isClosed()) {
    captures.push(activePage.locator('body').innerText({ timeout: 5000 }).then(body => writeFile(path.join(root, 'failure-body.txt'), body)));
    captures.push(activePage.content().then(html => writeFile(path.join(root, 'failure-page.html'), html)));
    captures.push(activePage.screenshot({ path: path.join(root, 'failure.png'), fullPage: true, timeout: 5000 }));
  }
  const captured = await Promise.allSettled(captures);
  await writeFile(path.join(root, 'failure.json'), JSON.stringify({ error: error?.stack || String(error),
    url: activePage?.url(), viewport: activePage?.viewportSize(), pageErrors, completed: results,
    captureErrors: captured.filter(r => r.status === 'rejected').map(r => String(r.reason)) }, null, 2));
  await writeFile(path.join(root, 'nuxt.log'), webLog);
  console.error(`Browser harness failed; diagnostics: ${root}`);
  throw error;
} finally {
  // Never close an existing/default CDP context. Only contexts created by this
  // harness are ours. Playwright close() disconnects a connectOverCDP transport;
  // it does not terminate the externally owned Chromium process.
  await Promise.allSettled([...ownedContexts].map(context => context.close()));
  try { await browser?.close(); }
  finally {
    if (web && web.exitCode === null && web.signalCode === null) {
      const exited = once(web, 'exit'); web.kill(); await exited;
    }
    if (fixture.server.listening) await new Promise(resolve => fixture.server.close(resolve));
  }
}
