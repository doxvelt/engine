import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [dependencies, chrome, reverie, mode] = process.argv.slice(2);
if (!dependencies || !chrome || !reverie) throw new Error('Usage: node workspace-test.mjs <DSH dependencies> <Chromium> <Reverie executable>');
const modules = path.resolve(dependencies, 'node_modules');
const calls = [];
const reflection = 'A scripted memory of the ferry.';
const generated = 'I will wait by the ferry.';
const provider = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  calls.push(input);
  const model = input.model;
  const isReflection = model === 'memory-route';
  const result = isReflection ? { memories: [{ gist: reflection, feeling: 'Trusted', detail: '',
    salience: 0.9, confidence: 0.8, cues: ['ferry'], sourceMessageIds: ['m1'] }], impressions: [] }
    : { text: generated, audience: ['nell', 'corin'] };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const first = isReflection ? { content: JSON.stringify(result) }
    : { role: 'assistant', tool_calls: [{ index: 0, id: 'result', type: 'function', function: { name: 'doxvelt_turn', arguments: JSON.stringify(result) } }] };
  for (const [delta, finish_reason] of [[first, null], [{}, isReflection ? 'stop' : 'tool_calls']]) {
    response.write('data: ' + JSON.stringify({ id: 'verification', object: 'chat.completion.chunk', model,
      choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } } : {}) }) + '\n\n');
  }
  response.end('data: [DONE]\n\n');
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const modelPatch = { id: 'llm-pi-ai', config: { providers: { 'doxvelt-verification': {
  api: 'openai-completions', baseURL: 'http://127.0.0.1:' + provider.address().port + '/v1',
  apiKeyEnv: 'DOXVELT_VERIFICATION_KEY', models: [{ id: 'actor-route' }, { id: 'memory-route' }],
  retryPolicy: { mode: 'normal', maxRetries: 0 },
} } } };
const { chromium } = await import(pathToFileURL(path.join(modules, 'playwright-core/index.mjs')));
const root = await mkdtemp(path.resolve(dependencies, 'workspace-play-'));
const first = path.join(root, 'first');
const second = path.join(root, 'second');
await mkdir(first);
await mkdir(second);
const bootstrap = path.join(root, 'bootstrap.mjs');
await writeFile(bootstrap, `export const inject = ['workspaceRegistry'];
export async function apply(ctx) {
  await ctx.workspaceRegistry.create(${JSON.stringify(first)}, 'Collection one');
  await ctx.workspaceRegistry.create(${JSON.stringify(second)}, 'Collection two');
}
`);
const overlay = path.join(root, 'overlay.json');
await writeFile(overlay, JSON.stringify([{ insert: [
  { id: 'test-workspaces', name: bootstrap },
  { id: 'doxvelt', name: fileURLToPath(new URL('./host.mjs', import.meta.url)), config: { reverie: path.resolve(reverie) } },
] }, modelPatch]));
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DOXVELT_|DSH_HOME$)/.test(key)));
let executable = process.execPath;
let args = [path.join(modules, '@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', overlay, '--no-open', '--port', '0'];
if (mode === '--desktop') {
  const installation = path.join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness');
  const runtime = path.join(installation, 'resources/runtime');
  const profile = path.join(root, 'harness/profiles/desktop');
  await mkdir(path.join(profile, 'node_modules/@doxvelt'), { recursive: true });
  const bundle = fileURLToPath(new URL('./', import.meta.url));
  await symlink(bundle, path.join(profile, 'node_modules/@doxvelt/dsh'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'doxvelt-desktop-verification', private: true,
    dependencies: { '@doxvelt/dsh': 'link:' + bundle },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@doxvelt/dsh'] } } }));
  await writeFile(path.join(profile, 'cordis.yml'), '[]');
  const patches = [{ insert: [{ id: 'test-workspaces', name: bootstrap }] }, { id: 'doxvelt', config: { reverie: path.resolve(reverie) } }, modelPatch,
    { id: 'desktop-product-telemetry', disabled: true }, { id: 'product-analytics', disabled: true }];
  await writeFile(path.join(profile, 'cordis.patch.yml'), JSON.stringify(patches));
  executable = path.join(installation, 'DeepSeek Harness.exe');
  const packaged = path.join(installation, 'resources/app.asar/dsh');
  args = ['--expose-internals', path.join(packaged, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'), packaged, profile,
    path.join(runtime, 'primary-runtime'), path.join(runtime, 'primary-runtime/dependencies/pnpm/bin/pnpm.mjs'), path.join(runtime, 'bin')];
}
let host;
let done;
let log = '';
let browser;
let page;
const browserErrors = [];
async function startHost() {
  log = '';
  host = spawn(executable, args, {
    cwd: first, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...inherited, DOXVELT_VERIFICATION_KEY: 'scripted-test-key', DSH_HOME: path.join(root, 'harness'), ...(mode === '--desktop' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
  });
  done = once(host, 'close');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('DSH startup timed out')), 30000);
    host.on('error', reject);
    host.on('close', code => { clearTimeout(timeout); reject(new Error('DSH stopped: ' + code)); });
    host.on('message', message => {
      if (message.type === 'ready') { clearTimeout(timeout); resolve(message.url); }
      if (message.type === 'fatal') { clearTimeout(timeout); reject(new Error(message.message)); }
    });
    host.stderr.on('data', bytes => { log += bytes; });
    host.stdout.on('data', bytes => {
      log += bytes;
      const found = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(log)?.[1];
      if (found) { clearTimeout(timeout); resolve(found); }
    });
  });
}
async function stopHost() {
  if (!host) return;
  if (mode === '--desktop' && host.connected) host.send({ type: 'shutdown' });
  else host.kill();
  await done;
  host = undefined;
}
try {
  const url = await startHost();
  browser = await chromium.launch({ executablePath: chrome, headless: true, chromiumSandbox: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 850 }, locale: 'en-US' });
  page.on('pageerror', error => browserErrors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.goto(url);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const signIn = page.getByRole('dialog', { name: 'Get started' });
  try { await signIn.getByRole('button', { name: 'Close', exact: true }).click({ timeout: 3000 }); }
  catch (error) { if (error.name !== 'TimeoutError' || await signIn.isVisible()) throw error; }
  const workspace = page.getByRole('button', { name: 'Choose workspace', exact: true });
  if (await workspace.isVisible()) {
    await workspace.click();
    await page.getByRole('menuitem', { name: 'Collection one', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Activate Doxvelt for this workspace', exact: true }).click();
  await page.getByRole('button', { name: 'New episode', exact: true }).waitFor();
  assert.deepEqual(JSON.parse(await readFile(path.join(first, '.doxvelt/workspace.json'), 'utf8')), { version: 1 });
  await assert.rejects(readFile(path.join(second, '.doxvelt/workspace.json')), { code: 'ENOENT' });
  const editor = page.locator('[contenteditable="true"]').first();
  assert.equal(await editor.innerText(), '');
  await page.getByRole('button', { name: 'New episode', exact: true }).click();
  for (const [kind, name, body] of [
    ['world', 'River valley', 'The river runs through a quiet valley.'],
    ['scenario', 'The crossing', 'A storm is approaching the last ferry.'],
    ['format', 'Short script', 'Write a short character performance.'],
    ['character', 'Corin', '@corin is the ferryman. :+3'],
    ['character', 'Nell', '@nell wants to cross the river. :+3'],
  ]) {
    await page.getByRole('button', { name: 'New ' + kind + '…', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Description (Markdown)', { exact: true }).fill(body);
    await page.getByRole('button', { name: 'Create ' + kind, exact: true }).click();
    await page.getByRole('dialog', { name: 'Create episode', exact: true }).waitFor();
  }
  await page.getByLabel('Episode date', { exact: true }).fill('2000-03-01');
  await page.getByRole('button', { name: 'Create episode', exact: true }).click();
  await page.getByRole('button', { name: 'Episode memory', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.innerText.includes('#all'));
  await page.getByRole('button', { name: 'New scene', exact: true }).click();
  await page.getByLabel('Scene heading', { exact: true }).fill('At the ferry landing — dusk');
  await page.getByRole('button', { name: 'Add scene heading', exact: true }).click();
  await page.getByRole('heading', { name: 'At the ferry landing — dusk', exact: true }).waitFor();
  const line = 'The ferry is ready; we should leave before the storm.';
  await editor.fill('/perform @Corin #Nell ' + line);
  await editor.press('Enter');
  await page.locator('[data-doxvelt-turn]').getByText(line, { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'At the ferry landing — dusk', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.innerText.trimEnd() === '/perform @Corin #Nell');
  await page.getByRole('button', { name: 'Episode memory', exact: true }).click();
  await page.getByLabel('Fictional date', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Fictional date', { exact: true }).inputValue(), '2000-03-01');
  await page.getByRole('button', { name: 'Close episode memory', exact: true }).click();
  await page.reload();
  try { await signIn.getByRole('button', { name: 'Close', exact: true }).click({ timeout: 3000 }); }
  catch (error) { if (error.name !== 'TimeoutError' || await signIn.isVisible()) throw error; }
  await page.locator('[data-doxvelt-turn]').getByText(line, { exact: true }).waitFor();
  assert.equal(await page.locator('[data-doxvelt-turn]').count(), 1);
  await page.screenshot({ path: path.join(root, 'workspace-play.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Collection', exact: true }).click();
  await page.getByRole('button', { name: 'worlds/river-valley.md', exact: true }).click();
  const source = page.getByLabel('Source Markdown', { exact: true });
  assert.match(await source.inputValue(), /quiet valley/);
  await source.fill((await source.inputValue()) + '\nThe river is wide.');
  await page.getByRole('button', { name: 'Save source', exact: true }).click();
  await page.getByRole('dialog', { name: 'Workspace collection', exact: true }).waitFor();
  assert.match(await readFile(path.join(first, 'worlds/river-valley.md'), 'utf8'), /river is wide/);
  await page.getByRole('button', { name: 'Close Doxvelt setup', exact: true }).click();
  assert.equal(calls.length, 0, 'Manual play and source editing make no model calls');
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByLabel('Character generation', { exact: true }).selectOption(JSON.stringify({ provider: 'doxvelt-verification', model: 'actor-route' }));
  await page.getByLabel('Memory reflection', { exact: true }).selectOption(JSON.stringify({ provider: 'doxvelt-verification', model: 'memory-route' }));
  await page.getByRole('button', { name: 'Save model choices', exact: true }).click();
  await page.getByRole('tab', { name: 'Generate', exact: true }).click();
  await page.getByRole('tablist', { name: 'Actor', exact: true }).getByRole('tab', { name: 'Nell · actor-route', exact: true }).click();
  await editor.fill('/generate @Nell #Corin Keep the ferry safe.');
  await editor.press('Enter');
  await page.locator('[data-doxvelt-turn]').getByText(generated, { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.innerText.trimEnd() === '/generate @Nell #Corin');
  assert.equal(calls[0].model, 'actor-route');
  assert.doesNotMatch(JSON.stringify(calls[0]), /The river is wide/, 'Editing collection source does not rewrite the current story');
  assert.doesNotMatch(JSON.stringify(calls[0]), /ferry landing — dusk/i, 'A scene heading is not actor knowledge');
  await page.getByRole('button', { name: 'Episode memory', exact: true }).click();
  await page.getByRole('button', { name: 'Memorize', exact: true }).click();
  await page.getByText('Memories saved.', { exact: true }).waitFor();
  await page.getByText(reflection, { exact: true }).first().waitFor();
  assert.ok(calls.slice(1).every(call => call.model === 'memory-route'));
  assert.doesNotMatch(JSON.stringify(calls.slice(1)), /ferry landing — dusk/i, 'A scene heading is not reflection source');
  await page.getByRole('button', { name: 'Close episode memory', exact: true }).click();
  await page.getByRole('tab', { name: 'Perform', exact: true }).click();
  const continuation = 'There is still time to cross.';
  await editor.fill('/perform @Corin #Nell ' + continuation);
  await editor.press('Enter');
  await page.locator('[data-doxvelt-turn]').getByText(continuation, { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.innerText.trimEnd() === '/perform @Corin #Nell');
  assert.equal(await page.locator('[data-doxvelt-turn]').count(), 3, 'The same episode remains playable after memorization');
  await page.screenshot({ path: path.join(root, 'after-memorization.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Episode memory', exact: true }).click();
  await page.getByRole('button', { name: 'Memorize again', exact: true }).click();
  await page.getByText('Memories saved.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close episode memory', exact: true }).click();
  const callsBeforeRestart = calls.length;
  await page.close();
  await stopHost();
  page = await browser.newPage({ viewport: { width: 1280, height: 850 }, locale: 'en-US' });
  page.setDefaultTimeout(15000);
  await page.goto(await startHost());
  const restartedSignIn = page.getByRole('dialog', { name: 'Get started' });
  try { await restartedSignIn.getByRole('button', { name: 'Close', exact: true }).click({ timeout: 3000 }); }
  catch (error) { if (error.name !== 'TimeoutError' || await restartedSignIn.isVisible()) throw error; }
  const saved = page.getByLabel('Saved episode', { exact: true });
  await saved.getByRole('option', { name: 'The crossing', exact: true }).waitFor({ state: 'attached' });
  if (await saved.isEnabled()) await saved.selectOption({ label: 'The crossing' });
  await page.locator('[data-doxvelt-turn]').getByText(continuation, { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'At the ferry landing — dusk', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Episode memory', exact: true }).click();
  await page.getByText(reflection, { exact: true }).first().waitFor();
  assert.equal(calls.length, callsBeforeRestart, 'Restart reopens published native memory without reflection');
  await page.getByRole('button', { name: 'Close episode memory', exact: true }).click();
  for (const [width, height] of [[1440, 900], [1280, 600], [390, 844], [360, 640]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: 'Episode memory', exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Horizontal overflow at ' + width);
    await page.screenshot({ path: path.join(root, 'viewport-' + width + '.png'), animations: 'disabled' });
  }
  console.log('Passed ' + (mode === '--desktop' ? 'native desktop Host' : 'Web Host') + ': activation, inline authoring, dated episodes, compact routing, headings, generation, memorization, continued play, process restart and four viewport sizes.');
  console.log('Isolated browser evidence: ' + root);
} catch (error) {
  console.error(browserErrors);
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  if (page) console.error((await page.locator('body').innerText()).slice(-5000));
  console.error(log.replace(/http:\/\/127\.0\.0\.1:\d+\/[^\s]+/g, '[local launch link]'));
  throw error;
} finally {
  await browser?.close();
  await stopHost();
  const closed = once(provider, 'close');
  provider.close(); provider.closeAllConnections();
  await closed;
}
