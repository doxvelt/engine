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
    assert.equal(await page.getByRole('textbox', { name: 'Stage whisper', exact: true }).inputValue(), 'SUSPENDED-DIRECTION');
    await page.getByRole('button', { name: 'Revise / alternate paths' }).first().click();
    await page.getByRole('button', { name: 'Cancel · return to continuation', exact: true }).scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `horizontal overflow at ${width}x${height}`);
    await page.screenshot({ path: path.join(root, `${width}x${height}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    results.push({ width, height, closeReopen: true, suspendedModes: true, focusCancel: true, generatedAlternative: true, inputIsolation: true, cycleContinuation: true, overflow: false });
    await context.close(); ownedContexts.delete(context); activePage = null;
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
