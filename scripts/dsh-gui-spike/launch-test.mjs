import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSimulationArchive } from '../../src/core/archive-verifier.ts';
import { openBranchStore } from '../../src/store/branch-sqlite.ts';

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
const newWhisper = 'Answer Corin from the landing.';
const replacement = 'There is a lantern on the landing.';
const nextWhisper = 'Answer Mara after the revised opening.';
const nextPerformance = 'Mara, I will take the long way home.';
let nextAttempts = 0;
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
      const prompt = JSON.stringify(input.messages);
      let performance = performances[model];
      if (prompt.includes(newWhisper)) performance = { text: replacement, audience: ['mara', 'corin'] };
      if (prompt.includes(nextWhisper)) {
        nextAttempts++;
        performance = { text: nextPerformance, audience: nextAttempts === 1 ? ['nell', 'mara'] : ['nell', 'corin'] };
      }
      send({ role: 'assistant', content: JSON.stringify(performance) }, null);
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
  await page.getByRole('button', { name: 'Close episode memory' }).click();
  const turns = page.locator('[data-doxvelt-turn]');
  const edit = turns.filter({ hasText: performances['nell-route'].text }).getByRole('button', { name: 'Regenerate this turn' });
  await edit.click();
  const direction = page.getByLabel('Revision stage whisper');
  assert.equal(await direction.inputValue(), 'Watch the key.');
  assert.equal(await page.getByLabel('Revision actor').inputValue(), 'Nell');
  await page.getByRole('button', { name: 'Close turn editor' }).click();
  assert.equal(await turns.count(), 3);
  assert.equal(await edit.evaluate(button => button === document.activeElement), true);
  await edit.click();
  await page.getByLabel('Revision actor').selectOption('Mara');
  await direction.fill(newWhisper);
  await page.getByRole('button', { name: 'Generate and open new path' }).click();
  await turns.getByText(replacement, { exact: false }).waitFor();
  assert.equal(await turns.count(), 2);
  assert.equal(calls.at(-1).model, 'mara-route');
  assert.match(JSON.stringify(calls.at(-1).messages), /Answer Corin from the landing/);
  assert.doesNotMatch(JSON.stringify(calls.at(-1).messages), /silver key under the ferry rope|I will guard the key|Watch the key|The far bank is quiet/);
  const store = await openBranchStore(path.join(scratch, 'doxvelt.sqlite')).open();
  try {
    const [story] = store.listSimulations('local');
    const archive = store.exportSimulation('local', story.simulationId);
    validateSimulationArchive(archive);
    const entry = archive.commandResults.find(item => item.canonicalInput.kind === 'saved_alternative');
    assert.equal(entry.canonicalInput.payload.request.replacementActorId, 'mara');
  } finally {
    store.close();
  }
  await page.getByLabel('Story path').selectOption({ label: 'Original' });
  await turns.getByText(performances['mara-route'].text, { exact: false }).waitFor();
  assert.equal(await turns.count(), 3);
  const typed = '/perform @Corin to @Nell | Unsent continuation after the edit.';
  await page.locator('[contenteditable="true"]').first().fill(typed);
  await turns.filter({ hasText: privateLine }).getByRole('button', { name: 'Edit turn', exact: true }).click();
  const corrected = 'I left the silver key under the old ferry rope.';
  await page.getByLabel('Revised performance').fill(corrected);
  const beforeCorrection = calls.length;
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await turns.getByText(corrected, { exact: true }).waitFor();
  assert.equal(await turns.count(), 3);
  assert.equal(await turns.nth(1).getByText(performances['nell-route'].text, { exact: true }).count(), 1);
  assert.equal(await turns.nth(2).getByText(performances['mara-route'].text, { exact: true }).count(), 1);
  assert.equal(calls.length, beforeCorrection);
  await page.waitForFunction(text => document.querySelector('[contenteditable="true"]')?.innerText === text, typed);
  await page.getByText('Memories are out of date for', { exact: false }).waitFor();

  // A replacement earlier than the correction commit still inherits corrected turns in its prefix.
  await turns.filter({ hasText: performances['nell-route'].text }).getByRole('button', { name: 'Regenerate this turn' }).click();
  await page.getByLabel('Revision stage whisper').fill('Reply after the correction.');
  await page.getByRole('button', { name: 'Generate and open new path' }).click();
  await turns.getByText(corrected, { exact: true }).waitFor();
  await turns.getByText(performances['nell-route'].text, { exact: true }).waitFor();
  await turns.nth(2).waitFor({ state: 'hidden' });
  assert.equal(await turns.count(), 2);
  assert.match(JSON.stringify(calls.at(-1).messages), /under the old ferry rope/);
  assert.doesNotMatch(JSON.stringify(calls.at(-1).messages), /under the ferry rope/);

  await page.getByLabel('Story path').selectOption({ label: 'Original' });
  await turns.getByText(privateLine, { exact: true }).waitFor();
  await turns.filter({ hasText: privateLine }).getByRole('button', { name: 'Edit turn', exact: true }).click();
  await page.getByText('Next turn direction', { exact: true }).click();
  assert.equal(await page.getByLabel('Next actor', { exact: true }).inputValue(), 'Nell');
  assert.equal(await page.getByLabel('Next stage whisper').inputValue(), 'Watch the key.');
  await page.getByLabel('Speaking character').selectOption('Mara');
  const revisedOpening = 'I saw a lost hound on the ferry.';
  await page.getByLabel('Revised performance').fill(revisedOpening);
  assert.equal(await page.getByRole('button', { name: 'Save correction', exact: true }).isDisabled(), true);
  await page.getByLabel('Next stage whisper').fill(nextWhisper);
  await page.screenshot({ path: path.join(scratch, 'saved-turn-editor.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Save & generate next turn', exact: true }).click();
  await page.getByText('Edit saved. The next turn did not generate.', { exact: false }).waitFor();
  assert.equal(await turns.count(), 3);
  assert.equal(nextAttempts, 1);
  await page.getByRole('button', { name: 'Retry next turn', exact: true }).click();
  await turns.getByText(nextPerformance, { exact: true }).waitFor();
  assert.equal(await turns.count(), 2);
  assert.match(await turns.first().innerText(), /Mara → Nell/);
  assert.equal(await turns.getByText(revisedOpening, { exact: true }).count(), 1);
  assert.equal(nextAttempts, 2);
  assert.equal(calls.at(-1).model, 'nell-route');
  assert.match(JSON.stringify(calls.at(-1).messages), /a lost hound on the ferry/);
  assert.doesNotMatch(JSON.stringify(calls.at(-1).messages), /under the ferry rope|Watch the key|I will guard the key|The far bank is quiet/);

  const revised = await openBranchStore(path.join(scratch, 'doxvelt.sqlite')).open();
  try {
    const [story] = revised.listSimulations('local');
    const archive = revised.exportSimulation('local', story.simulationId);
    validateSimulationArchive(archive);
    assert.ok(archive.commandResults.some(item => item.canonicalInput.kind === 'correct_turn_body'));
    const manual = archive.commandResults.filter(item => item.canonicalInput.kind === 'saved_alternative' &&
      item.canonicalInput.payload.request.action === 'manual');
    assert.equal(manual.length, 1);
    assert.equal(manual[0].canonicalInput.payload.request.replacementActorId, 'mara');
  } finally {
    revised.close();
  }
  console.log('Passed launcher model routes, native reflection, historical regeneration, wording correction, and safe retry after saving an edit.');
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
