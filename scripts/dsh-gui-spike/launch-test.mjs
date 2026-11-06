import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [dependencies, chrome, reverie] = process.argv.slice(2);
if (!dependencies || !chrome || !reverie) {
  throw new Error('Usage: node launch-test.mjs <scratch> <Chromium executable> <Reverie executable>');
}

const modules = path.resolve(dependencies, 'node_modules');
const dsh = path.join(modules, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const { chromium } = await import(pathToFileURL(path.join(modules, 'playwright-core', 'index.mjs')).href);
const stage = fileURLToPath(new URL('../dsh-stage.mjs', import.meta.url));
const scratch = await mkdtemp(path.resolve(dependencies, 'stage-launch-'));
const config = path.join(scratch, 'models.json');
const calls = [];
const privateLine = 'I left a silver key under the ferry rope.';
const recall = 'Nell remembers where Corin left the key.';
const performances = {
  'nell-route': { text: 'I will guard the key.', audience: ['nell', 'corin'] },
  'mara-route': { text: 'The far bank is quiet.', audience: ['mara', 'corin'] },
};
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(input);
    const model = input.model;
    const usage = { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 };
    if (input.stream) {
      assert.ok(performances[model]);
      const send = (delta, finish_reason) => {
        response.write('data: ' + JSON.stringify({ id: 'turn', object: 'chat.completion.chunk', model,
          choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage } : {}) }) + '\n\n');
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      send({ role: 'assistant', content: JSON.stringify(performances[model]) }, null);
      send({}, 'stop');
      response.end('data: [DONE]\n\n');
    } else {
      assert.equal(model, 'memory-route');
      const content = JSON.stringify({ memories: [{ gist: recall, feeling: 'Trusted', detail: '',
        salience: 0.9, confidence: 0.8, cues: ['key'], sourceMessageIds: ['m1'] }], impressions: [] });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'reflection', object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }));
    }
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');

let browser;
let launcher;
let launcherDone;
let launcherLog = '';
try {
  const baseUrl = 'http://127.0.0.1:' + provider.address().port + '/v1';
  const route = modelId => ({ modelId, baseUrl });
  await writeFile(config, JSON.stringify({
    actors: { nell: route('nell-route'), mara: route('mara-route') }, reflection: route('memory-route'),
  }));

  async function launch() {
    launcher = spawn(process.execPath, [stage, '--dsh', dsh, '--reverie', reverie,
      '--models', config, '--data', scratch, '--no-open'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    launcherDone = once(launcher, 'exit');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Doxvelt launch timed out.')), 30_000);
      launcher.on('error', reject);
      launcher.on('close', code => { clearTimeout(timer); reject(new Error('Doxvelt exited with code ' + code)); });
      launcher.stderr.on('data', bytes => { launcherLog += bytes; });
      launcher.stdout.on('data', bytes => {
        launcherLog += bytes;
        const url = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(launcherLog)?.[1];
        if (url) { clearTimeout(timer); resolve(url); }
      });
    });
  }

  async function openEpisode(url) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, locale: 'en-US' });
    page.setDefaultTimeout(12_000);
    await page.goto(url);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const signIn = page.getByRole('dialog', { name: 'Get started' });
    await signIn.getByRole('button', { name: 'Close', exact: true }).click();
    const picker = page.getByLabel('Saved episode', { exact: true });
    await picker.getByRole('option', { name: 'The last crossing' }).waitFor({ state: 'attached' });
    await picker.selectOption({ label: 'The last crossing' });
    await page.getByRole('button', { name: 'Episode memory', exact: true }).waitFor();
    return page;
  }

  async function play(page, input, performance) {
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.fill(input);
    await composer.press('Enter');
    await page.locator('[data-doxvelt-turn]').getByText(performance, { exact: false }).waitFor();
    await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.innerText.trimEnd().endsWith('|'));
  }

  browser = await chromium.launch({ executablePath: chrome, headless: true, chromiumSandbox: true });
  const url = await launch();
  const page = await openEpisode(url);
  await play(page, '/perform @Corin to @Nell | ' + privateLine, privateLine);
  await play(page, '/generate @Nell to @Corin | Watch the key.', performances['nell-route'].text);
  await play(page, '/generate @Mara to @Corin | Watch the far bank.', performances['mara-route'].text);
  assert.deepEqual(calls.map(call => call.model), ['nell-route', 'mara-route']);
  assert.match(JSON.stringify(calls[0].messages), /silver key under the ferry rope/);
  assert.doesNotMatch(JSON.stringify(calls[1].messages), /silver key under the ferry rope|I will guard the key|Watch the key/);
  await page.getByRole('button', { name: 'Episode memory', exact: true }).click();
  await page.getByLabel('Fictional date').fill('2000-03-01');
  await page.getByRole('button', { name: 'Set date', exact: true }).click();
  await page.getByRole('button', { name: 'Memorize', exact: true }).click();
  await page.getByText('Memories saved.', { exact: true }).waitFor();
  await page.getByText(recall, { exact: true }).first().waitFor();
  assert.ok(calls.length > 2);
  assert.ok(calls.slice(2).every(call => call.model === 'memory-route'));
  console.log('Passed launcher model routing, private audience and whispers, and native reflection over the configured model endpoint.');
} catch (error) {
  console.error(launcherLog.replace(/http:\/\/127\.0\.0\.1:\d+\/[^\s]+/g, '[local launch link]'));
  throw error;
} finally {
  await browser?.close();
  if (launcher?.connected) launcher.disconnect();
  await launcherDone;
  const closed = once(provider, 'close');
  provider.close();
  provider.closeAllConnections();
  await closed;
}
