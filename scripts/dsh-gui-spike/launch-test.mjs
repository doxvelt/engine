import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSimulationArchive } from '../../src/core/archive-verifier.ts';
import { AUDIENCE_PROPOSAL_JSON_SCHEMA } from '../../src/core/output-contracts.ts';
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
const providerErrors = [];
const privateLine = 'I left a silver key under the ferry rope.';
const recall = 'Nell remembers where Corin left the key.';
const newWhisper = 'Answer Corin from the landing.';
const replacement = 'There is a lantern on the landing.';
const nextWhisper = 'Answer Mara after the revised opening.';
const nextPerformance = 'Mara, I will take the long way home.';
let nextAttempts = 0;
const limitWhisper = 'Choose within the audience limit and keep @Mara out of the exchange.';
const limitedPerformance = 'Corin, I can see the far bank.';
const limitedRevision = 'Corin, the far bank is still in sight.';
let limitAttempts = 0;
const performances = {
  'nell-route': { text: 'I will guard the key.', audience: ['nell', 'corin'] },
  'mara-route': { text: 'The far bank is quiet.', audience: ['mara', 'corin'] },
  'nell-careful-route': { text: 'I will count the lights before we leave.', audience: ['nell', 'corin'] },
  'nell-updated-route': { text: 'I counted a light on the far bank.', audience: ['nell', 'corin'] },
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
    assert.equal(input.stream, true);
    assert.match(request.headers['user-agent'], /deepseek/i);
    if (model !== 'memory-route') {
      assert.ok(performances[model]);
      assert.equal(input.response_format, undefined);
      assert.equal(input.tools.length, 1);
      assert.equal(input.tools[0].function.name, 'doxvelt_turn');
      assert.deepEqual(input.tools[0].function.parameters, AUDIENCE_PROPOSAL_JSON_SCHEMA);
      const send = (delta, finish_reason) => {
        response.write('data: ' + JSON.stringify({ id: 'turn', object: 'chat.completion.chunk', model,
          choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage } : {}) }) + '\n\n');
      };
      const prompt = input.messages.map(({ content }) => Array.isArray(content) ? content.map(part => part.text ?? '').join('\n') : content).join('\n');
      let performance = performances[model];
      if (prompt.includes(newWhisper)) performance = { text: replacement, audience: ['mara', 'corin'] };
      if (prompt.includes(nextWhisper)) {
        nextAttempts++;
        performance = { text: nextPerformance, audience: nextAttempts === 1 ? ['nell', 'mara'] : ['nell', 'corin'] };
      }
      if (prompt.includes(limitWhisper)) {
        limitAttempts++;
        assert.match(prompt, /The director limits your choice/);
        const references = prompt.match(/Available recipient identity references \(no additional knowledge\): (.+)/);
        assert.deepEqual(JSON.parse(references?.[1] ?? '[]').map(item => item.id), ['corin', 'nell']);
        performance = { text: limitAttempts === 3 ? limitedRevision : limitedPerformance,
          audience: limitAttempts === 1 ? ['nell', 'mara'] : ['nell', 'corin'] };
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'result', type: 'function', function: { name: 'doxvelt_turn', arguments: JSON.stringify(performance) } }] }, null);
      send({}, 'tool_calls');
      response.end('data: [DONE]\n\n');
    } else {
      assert.equal(model, 'memory-route');
      const content = JSON.stringify({ memories: [{ gist: recall, feeling: 'Trusted', detail: '',
        salience: 0.9, confidence: 0.8, cues: ['key'], sourceMessageIds: ['m1'] }], impressions: [] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ content }, null], [{}, 'stop']]) {
        response.write('data: ' + JSON.stringify({ id: 'reflection', object: 'chat.completion.chunk', model,
          choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage } : {}) }) + '\n\n');
      }
      response.end('data: [DONE]\n\n');
    }
  } catch (error) {
    providerErrors.push(error.message);
    if (response.headersSent) { response.destroy(); return; }
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
async function stopLauncher() {
  if (launcher?.connected) launcher.disconnect();
  await launcherDone;
  launcher = undefined;
  launcherDone = undefined;
}
try {
  const baseUrl = 'http://127.0.0.1:' + provider.address().port + '/v1';
  const route = modelId => ({ modelId, baseUrl });
  const modelSettings = {
    actors: { nell: [
      { id: 'default', label: 'Quick', ...route('nell-route') },
      { id: 'careful', label: 'Careful', ...route('nell-careful-route') },
    ], mara: route('mara-route') }, reflection: route('memory-route'),
  };
  await writeFile(config, JSON.stringify(modelSettings));

  async function launch(args = [], data = scratch) {
    launcherLog = '';
    launcher = spawn(process.execPath, [stage, '--dsh', dsh, '--reverie', reverie,
      '--models', config, '--data', data, '--no-open', ...args],
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

  async function openEpisode(url, firstRun = true) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, locale: 'en-US' });
    page.setDefaultTimeout(12_000);
    await page.goto(url);
    if (firstRun) await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const signIn = page.getByRole('dialog', { name: 'Get started' });
    try { await signIn.getByRole('button', { name: 'Close', exact: true }).click({ timeout: 3_000 }); }
    catch (error) { if (error.name !== 'TimeoutError' || await signIn.isVisible()) throw error; }
    const picker = page.getByLabel('Saved episode', { exact: true });
    try {
      const workspace = page.getByRole('button', { name: 'Choose workspace', exact: true });
      if (!firstRun) {
        await picker.or(workspace).first().waitFor();
        if (await workspace.isVisible()) {
          await workspace.click();
          await page.getByRole('menuitem', { name: 'stage', exact: true }).click();
        }
      }
      await picker.getByRole('option', { name: 'The last crossing' }).waitFor({ state: 'attached' });
      if (await picker.isEnabled()) await picker.selectOption({ label: 'The last crossing' });
      else assert.equal(await picker.locator('option:checked').textContent(), 'The last crossing');
    } catch (error) {
      await page.screenshot({ path: path.join(scratch, 'open-episode-failure.png') }).catch(() => {});
      console.error((await page.locator('body').innerText()).slice(0, 1500));
      throw error;
    }
    await page.getByRole('button', { name: 'Episode memory', exact: true }).waitFor();
    return page;
  }

  async function play(page, input, performance) {
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.fill(input);
    await composer.press('Enter');
    await page.locator('[data-doxvelt-turn]').getByText(performance, { exact: false }).waitFor();
    await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.innerText.trimEnd().match(/^\/(perform|generate) @\S+ (?:#\S+ ?)+$/));
  }

  browser = await chromium.launch({ executablePath: chrome, headless: true, chromiumSandbox: true });
  const url = await launch();
  const page = await openEpisode(url);
  await play(page, '/perform @Corin #Nell ' + privateLine, privateLine);
  await play(page, '/generate @Nell #Corin Watch the key.', performances['nell-route'].text);
  await play(page, '/generate @Mara #Corin Watch the far bank.', performances['mara-route'].text);
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
  const typed = '/perform @Corin #Nell Unsent continuation after the edit.';
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
  try {
    await page.waitForFunction(text => document.querySelector('[contenteditable="true"]')?.innerText === text, typed);
  } catch (error) {
    console.error('Composer after correction:', await page.locator('[contenteditable="true"]').first().innerText());
    throw error;
  }
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

  const groupLine = 'Nell and Mara, the ferryman is waiting.';
  await play(page, '/perform @Corin #Nell #Mara ' + groupLine, groupLine);
  assert.match(await turns.last().innerText(), /Corin → (Mara, Nell|Nell, Mara)/);
  const audience = page.getByLabel('Audience', { exact: true });
  assert.match(await audience.locator('option:checked').textContent(), /Mara \+ Nell|Nell \+ Mara/);
  await audience.selectOption({ label: 'Everyone' });
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.press('End');
  await page.keyboard.insertText('The crossing is clear for everyone.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await turns.getByText('The crossing is clear for everyone.', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.innerText.trimEnd() === '/perform @Corin #all');
  assert.match(await turns.last().innerText(), /Corin → (Mara, Nell|Nell, Mara)/);

  await page.getByRole('tab', { name: 'Generate', exact: true }).click();
  await page.getByLabel('Actor', { exact: true }).selectOption('Nell');
  await audience.selectOption({ label: 'Actor chooses' });
  await page.getByLabel('Audience limit', { exact: true }).selectOption('Corin');
  await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.innerText.trimEnd() === '/generate @Nell #actor:Corin');
  await composer.fill('/generate @Nell #actor:Mara ');
  assert.equal(await page.getByLabel('Audience limit', { exact: true }).inputValue(), 'Mara');
  await composer.fill('/generate @Nell #actor:Corin ' + limitWhisper);
  const beforeLimitedTurn = await turns.count();
  await composer.press('Enter');
  await page.getByText('Generation did not produce a valid turn.', { exact: false }).waitFor();
  assert.equal(await turns.count(), beforeLimitedTurn);
  assert.match(await composer.innerText(), /within the audience limit/);
  await composer.press('Enter');
  await turns.getByText(limitedPerformance, { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.innerText.trimEnd() === '/generate @Nell #actor:Corin');
  assert.equal(limitAttempts, 2);
  assert.deepEqual(providerErrors, []);
  assert.match(await turns.last().innerText(), /Nell → Corin/);

  await turns.filter({ hasText: limitedPerformance }).getByRole('button', { name: 'Regenerate this turn' }).click();
  const revisionAudience = page.getByRole('group', { name: 'Revision audience' });
  await revisionAudience.getByRole('checkbox', { name: 'Actor chooses' }).check();
  await revisionAudience.getByRole('checkbox', { name: 'Corin' }).check();
  assert.equal(await page.getByLabel('Revision stage whisper').inputValue(), limitWhisper);
  await page.getByRole('button', { name: 'Generate and open new path' }).click();
  await turns.getByText(limitedRevision, { exact: true }).waitFor();
  assert.equal(limitAttempts, 3);
  assert.deepEqual(providerErrors, []);

  const careful = performances['nell-careful-route'].text;
  const picker = page.getByLabel('Actor', { exact: true });
  await picker.selectOption({ label: 'Nell · Careful' });
  await page.getByLabel('Audience', { exact: true }).selectOption('Corin');
  await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.innerText.trimEnd() === '/generate @Nell#careful #Corin');
  await play(page, '/generate @Nell#careful #Corin Count the lights.', careful);
  assert.equal(calls.at(-1).model, 'nell-careful-route');
  assert.match(JSON.stringify(calls.at(-1).messages), /far bank is still in sight/);
  assert.equal(await picker.inputValue(), 'Nell#careful');
  await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.innerText.trimEnd() === '/generate @Nell#careful #Corin');
  await turns.filter({ hasText: limitedRevision }).getByRole('button', { name: 'Edit turn', exact: true }).click();
  await page.getByText('Next turn direction', { exact: true }).click();
  assert.equal(await page.getByLabel('Next actor', { exact: true }).inputValue(), 'Nell#careful');
  await page.getByRole('button', { name: 'Close turn editor' }).click();
  await turns.filter({ hasText: careful }).getByRole('button', { name: 'Regenerate this turn' }).click();
  assert.equal(await page.getByLabel('Revision actor').inputValue(), 'Nell#careful');
  await page.getByRole('button', { name: 'Close turn editor' }).click();

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
    const limited = archive.commandResults.find(item => item.canonicalInput.kind === 'accept_draft' &&
      item.canonicalInput.payload.routing?.audienceLimit);
    assert.deepEqual(limited.canonicalInput.payload.routing.audienceLimit, ['corin']);
    assert.deepEqual(limited.canonicalInput.payload.audience, ['nell', 'corin']);
    const historicalLimit = archive.commandResults.find(item => item.canonicalInput.kind === 'saved_alternative' &&
      item.canonicalInput.payload.request.audienceLimit);
    assert.deepEqual(historicalLimit.canonicalInput.payload.request.audienceLimit, ['corin']);
    assert.deepEqual(historicalLimit.canonicalInput.payload.generated.audience, ['nell', 'corin']);
    const carefulReceipt = archive.commandResults.find(item => item.canonicalInput.kind === 'accept_draft' &&
      item.canonicalInput.payload.runtimeProfile.id === 'actor-careful');
    assert.equal(carefulReceipt.canonicalInput.payload.actorId, 'nell');
    assert.equal(carefulReceipt.canonicalInput.payload.generatedArtifact.provenance.modelId, 'nell-careful-route');
  } finally {
    revised.close();
  }
  const playedPath = await page.getByLabel('Story path').inputValue();
  await page.close();
  await stopLauncher();
  const database = path.join(scratch, 'doxvelt.sqlite');
  modelSettings.actors.nell[1].modelId = 'nell-updated-route';
  await writeFile(config, JSON.stringify(modelSettings));
  const reopened = await openEpisode(await launch(['--database', database], path.join(scratch, 'fresh-dsh')));
  const restoredTurns = reopened.locator('[data-doxvelt-turn]');
  await restoredTurns.getByText(limitedRevision, { exact: true }).waitFor();
  assert.equal(await reopened.getByLabel('Story path').inputValue(), playedPath);
  assert.equal(await restoredTurns.getByText(groupLine, { exact: true }).count(), 1);
  assert.match(await restoredTurns.last().innerText(), /Nell → Corin/);
  await restoredTurns.filter({ hasText: careful }).getByRole('button', { name: 'Regenerate this turn' }).click();
  await reopened.getByText('The original actor configuration is unavailable.', { exact: false }).waitFor();
  const revisionActor = reopened.getByLabel('Revision actor');
  assert.equal(await revisionActor.inputValue(), '');
  assert.equal(await reopened.getByRole('button', { name: 'Generate and open new path' }).isDisabled(), true);
  await revisionActor.selectOption('Nell#careful');
  await reopened.getByRole('button', { name: 'Generate and open new path' }).click();
  await restoredTurns.getByText(performances['nell-updated-route'].text, { exact: true }).waitFor();
  assert.equal(calls.at(-1).model, 'nell-updated-route');
  await reopened.close();
  await stopLauncher();

  const source = path.join(scratch, 'authored-source');
  await cp(fileURLToPath(new URL('../../examples/last-crossing', import.meta.url)), source, { recursive: true });
  const joss = path.join(source, 'entities', 'joss');
  await mkdir(joss);
  await writeFile(path.join(joss, 'IDENTITY.md'), '---\nid: joss\nkind: agent\nname: Joss\nvisibility: public\n---\n\n@joss is a passenger on the ferry. :+3\n');
  const authored = path.join(scratch, 'authored-story');
  const openedSource = await openEpisode(await launch(['--story', source, '--scenario', 'last-crossing'], authored));
  const authoredTurns = openedSource.locator('[data-doxvelt-turn]');
  assert.equal(await authoredTurns.count(), 0);
  const sharedAside = 'The violet parcel is under my coat.';
  await openedSource.getByLabel('Audience', { exact: true }).selectOption({ label: 'Joss + Nell' });
  const authoredComposer = openedSource.locator('[contenteditable="true"]').first();
  await authoredComposer.press('End');
  await openedSource.keyboard.insertText(sharedAside);
  await authoredComposer.press('Enter');
  await authoredTurns.getByText(sharedAside, { exact: true }).waitFor();
  assert.match(await authoredTurns.first().innerText(), /Corin → Joss, Nell/);
  await openedSource.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.innerText.trimEnd() === '/perform @Corin #Joss #Nell');
  await play(openedSource, '/generate @Mara #Corin Check the far bank.', performances['mara-route'].text);
  assert.doesNotMatch(JSON.stringify(calls.at(-1).messages), /violet parcel/);
  const sourceStore = await openBranchStore(path.join(authored, 'doxvelt.sqlite')).open();
  try {
    const [story, example] = sourceStore.listSimulations('local');
    assert.match(story.simulationId, /^story-/);
    assert.equal(example, undefined);
  } finally {
    sourceStore.close();
  }
  await openedSource.close();
  await stopLauncher();

  const restoredMemories = await openEpisode(await launch(['--database', database]), false);
  const reflectionCalls = calls.filter(call => call.model === 'memory-route').length;
  await restoredMemories.getByLabel('Story path').selectOption({ label: 'Original' });
  await restoredMemories.locator('[data-doxvelt-turn]').getByText(privateLine, { exact: true }).waitFor();
  await restoredMemories.getByRole('button', { name: 'Episode memory', exact: true }).click();
  await restoredMemories.getByText(recall, { exact: true }).first().waitFor();
  assert.equal(calls.filter(call => call.model === 'memory-route').length, reflectionCalls);
  console.log('Passed launcher routes, exact actor configuration history, saved-turn editing, audiences, and restart of saved stories and native memories.');
} catch (error) {
  if (providerErrors.length) console.error(providerErrors);
  console.error(launcherLog.replace(/http:\/\/127\.0\.0\.1:\d+\/[^\s]+/g, '[local launch link]'));
  throw error;
} finally {
  await browser?.close();
  await stopLauncher();
  const closed = once(provider, 'close');
  provider.close();
  provider.closeAllConnections();
  await closed;
}
