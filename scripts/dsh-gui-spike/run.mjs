import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalApiServer } from '../../src/local-api/server.ts';
import { engineRequest } from './saved-episode.mjs';
import { EpisodeMemory } from '../../src/memory/episodes.ts';

const [dependencies, executablePath] = process.argv.slice(2);
if (!dependencies || !executablePath) {
  throw new Error('Usage: node run.mjs <directory containing node_modules> <Chromium executable>');
}
const runtime = path.resolve(dependencies, 'node_modules');
const cli = path.join(runtime, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const playwright = path.join(runtime, 'playwright-core', 'index.mjs');
const { chromium } = await import(pathToFileURL(playwright).href);
const root = await mkdtemp(path.resolve(dependencies, 'ferry-run-'));
const workspace = path.join(root, 'ferry-stage');
const fixture = path.join(root, 'fixture.json');
const overlay = path.join(root, 'overlay.json');
const plugin = fileURLToPath(new URL('./host.mjs', import.meta.url));
await mkdir(workspace);
await writeFile(fixture, JSON.stringify({ turns: [], calls: [], whispers: {} }));
await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'doxvelt-fixture', name: plugin }] }]));

const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|systemroot|comspec|pathext|temp|tmp|windir|localappdata|userprofile)$/i.test(key)));
const dbPath = path.join(root, 'doxvelt.sqlite');
const reverieExecutable = process.env.DOXVELT_REVERIE_EXECUTABLE;
let engine;
let memory;
let reflecting = false;
let holdReflection = false;
let reflectionCancelled = false;
let host;

async function startEngine() {
  if (reverieExecutable) memory = new EpisodeMemory({
    directory: path.join(root, 'memory'), executable: reverieExecutable, modelKey: 'browser-fixture',
    async reflect(request, signal) {
      if (holdReflection) {
        reflecting = true;
        try { await delay(10_000, undefined, { signal }); }
        catch (error) { reflectionCancelled = signal.aborted; throw error; }
      }
      assert.match(JSON.stringify(request.input), /sealed letter/);
      return JSON.stringify({ memories: [{ gist: 'I still remember the sealed letter agreement.',
        feeling: 'Trusted', detail: '', salience: 0.9, confidence: 0.8, cues: ['sealed letter'], sourceMessageIds: ['m1'] }], impressions: [] });
    },
  });
  engine = createLocalApiServer({ dbPath, ...(memory ? { episodeMemory: memory } : {}), actorTurnRuntime: {
    identity: { id: 'dsh-browser-fixture', version: '1' },
    async *runActorTurn(request) {
      const direction = request.context.routingDirection;
      assert.equal(request.actorId, 'nell');
      assert.match(request.prompt, /sealed letter/);
      if (direction.completeWhisper === 'Remember the sealed letter.') {
        assert.match(request.prompt, /I still remember the sealed letter agreement/);
        assert.doesNotMatch(request.prompt, /I left the sealed letter by the mooring post/);
      }
      const wrongAudience = direction.completeWhisper === 'Route to the wrong character, Mara.';
      if (wrongAudience) assert.ok(direction.references.some(reference => reference.id === 'mara'));
      const audience = wrongAudience ? ['nell', 'mara'] : ['nell', 'corin'];
      yield { type: 'completed', text: JSON.stringify({ text: 'I have the lantern.', audience }), stopReason: 'stop' };
    },
  } });
  engine.listen(0, '127.0.0.1');
  await once(engine, 'listening');
  return 'http://127.0.0.1:' + engine.address().port;
}

async function closeEngine() {
  if (!engine) return;
  const stopped = once(engine, 'close');
  engine.close();
  await stopped;
  engine = undefined;
  memory?.close();
  memory = undefined;
}

function startHost(name, engineUrl) {
  const child = spawn(process.execPath, [cli, 'web', '--patch', overlay, '--no-open', '--port', '0'], {
    cwd: workspace,
    windowsHide: true,
    env: { ...inherited, DSH_HOME: path.join(root, name), DOXVELT_SPIKE_ROOT: root, DOXVELT_SPIKE_ENGINE: engineUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = once(child, 'close');
  let log = '';
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DSH startup timed out')), 30_000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); reject(new Error('DSH exited with code ' + code)); });
    child.stdout.on('data', bytes => {
      log += bytes;
      const launchUrl = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(log)?.[1];
      if (launchUrl) { clearTimeout(timer); resolve(launchUrl); }
    });
    child.stderr.on('data', bytes => { log += bytes; });
  });
  return { url, async close() {
    if (child.exitCode === null && !child.killed) child.kill();
    await done;
    await writeFile(path.join(root, name + '.log'), log.replace(/http:\/\/127\.0\.0\.1:\d+\/[^\s]+/g, '[local launch link]'));
  } };
}

let browser;
let page;
const pageErrors = [];
const results = [];
const readFixture = async () => JSON.parse(await readFile(fixture, 'utf8'));

async function closeSignIn(page) {
  const signIn = page.getByRole('dialog', { name: 'Get started' });
  const close = signIn.getByRole('button', { name: 'Close', exact: true });
  try { await close.click({ timeout: 3_000 }); }
  catch (error) { if (error.name !== 'TimeoutError' || await signIn.isVisible()) throw error; }
  await signIn.waitFor({ state: 'hidden' });
}

async function openPage(url) {
  const tab = await browser.newPage({ viewport: { width: 1280, height: 850 }, locale: 'en-US' });
  tab.setDefaultTimeout(12_000);
  tab.on('pageerror', error => pageErrors.push(String(error)));
  await tab.goto(url);
  await tab.getByRole('button', { name: 'Continue', exact: true }).click();
  await closeSignIn(tab);
  return tab;
}

async function waitForDraft(page, text) {
  await page.waitForFunction(expected =>
    document.querySelector('[contenteditable="true"]')?.innerText.trimEnd() === expected, text);
}

try {
  let engineUrl = await startEngine();
  const saved = await engineRequest(engineUrl, '/examples/last-crossing/play', {});
  const savedRoute = '/simulations/' + saved.simulationId;
  const initial = await engineRequest(engineUrl, savedRoute + '/stage');
  const savedLine = 'I left the sealed letter by the mooring post.';
  await engineRequest(engineUrl, savedRoute + '/turns', {
    branchId: saved.branchId, expectedHead: initial.branch.headCommitId, commandId: 'before-dsh',
    actorId: 'corin', audience: ['nell'], manualText: savedLine, stageWhisperIds: [],
    knowledgePolicy: 'actor-knowledge-v1',
  });
  host = startHost('harness-home', engineUrl);
  const url = await host.url;
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  page = await openPage(url);
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor();
  const rows = page.locator('[data-doxvelt-turn]');
  const audience = page.getByLabel('Audience', { exact: true });
  await audience.waitFor();

  await editor.fill('/perform @Corin to @Ne');
  const nell = page.getByRole('option', { name: 'Nell Doxvelt character', exact: true });
  await nell.waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await editor.press('End');
  await editor.press('Space');
  await page.keyboard.insertText('| Mara, this letter is only for Nell.');
  assert.equal(await audience.inputValue(), 'Nell');
  await audience.selectOption('Mara');
  assert.match(await editor.innerText(), /to @Mara/);
  await editor.fill('/perform @Corin to @Nell | Mara, this letter is only for Nell.');
  assert.equal(await audience.inputValue(), 'Nell');
  await editor.press('Enter');
  await rows.nth(0).waitFor();
  await waitForDraft(page, '/perform @Corin to @Nell |');
  assert.equal((await readFixture()).turns[0].audience, 'Nell');
  results.push('Keyboard completion, bidirectional routing, and manual Enter');

  await editor.fill('/generate @Nell to actor | PRIVATE: Be discreet.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await rows.nth(1).waitFor();
  await waitForDraft(page, '/generate @Nell to actor |');
  assert.match(await rows.nth(1).innerText(), /Nell → Corin/);
  await editor.fill('/generate @Mara to @Nell | Watch the weather.');
  await editor.press('Enter');
  await rows.nth(2).waitFor();
  await waitForDraft(page, '/generate @Mara to @Nell |');
  const played = await readFixture();
  assert.deepEqual(played.calls.map(call => call.configuration), ['fixture-a', 'fixture-b']);
  assert.deepEqual(played.calls.map(call => call.perceived), [['1'], []]);
  assert.doesNotMatch((await rows.allInnerTexts()).join('\n'), /Be discreet/);
  await page.getByRole('button', { name: 'Edit turn 2' }).click();
  await page.getByRole('button', { name: 'Show stage whisper' }).click();
  await page.getByText('PRIVATE: Be discreet.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel correction' }).click();
  assert.equal(await rows.count(), 3);
  results.push('Two actor configurations in one conversation, private direction, and automatic append');

  await editor.fill('/perform @Corin to @Nell | Unsent continuation.');
  await page.getByRole('button', { name: 'Edit turn 1' }).click();
  await page.getByRole('textbox', { name: 'Correct performance' }).fill('Mara, the sealed letter is only for Nell.');
  await page.getByRole('button', { name: 'Save correction' }).click();
  await page.getByRole('textbox', { name: 'Correct performance' }).waitFor({ state: 'hidden' });
  await rows.nth(0).getByText('Mara, the sealed letter is only for Nell.', { exact: false }).waitFor();
  assert.deepEqual((await readFixture()).turns.slice(1), played.turns.slice(1));
  assert.match(await editor.innerText(), /Unsent continuation/);
  results.push('Inline correction preserves the later turns and unsent continuation');

  await editor.fill('/generate @Nell to actor | force failure');
  await editor.press('Enter');
  await page.getByText('Scripted generation failed. Try again.', { exact: true }).waitFor();
  assert.match(await editor.innerText(), /force failure/);
  assert.equal(await rows.count(), 3);
  await editor.press('Enter');
  await rows.nth(3).waitFor();
  assert.equal((await readFixture()).turns.length, 4);
  const before = await rows.allInnerTexts();
  await page.reload();
  await rows.nth(3).waitFor();
  await closeSignIn(page);
  assert.deepEqual(await rows.allInnerTexts(), before);
  assert.deepEqual(pageErrors, []);
  results.push('Generation failure preserves the input, retry commits once, reload restores four rows');
  await editor.fill('/generate @Mara to @Nell | Check the steering rope.');
  await editor.press('Enter');
  await rows.nth(4).waitFor();
  await waitForDraft(page, '/generate @Mara to @Nell |');
  assert.equal(await page.getByLabel('Action', { exact: true }).inputValue(), 'generate');
  assert.equal(await page.getByLabel('Actor', { exact: true }).inputValue(), 'Mara');
  assert.equal(await audience.inputValue(), 'Nell');
  assert.equal(await editor.evaluate(element => element === document.activeElement), true);
  await page.keyboard.insertText('Try the spare rope.');
  assert.match(await editor.innerText(), /to @Nell \|\s+Try the spare rope\./);
  await page.keyboard.press('Enter');
  await rows.nth(5).waitFor();
  assert.deepEqual((await readFixture()).calls.at(-1), {
    configuration: 'fixture-b', whisper: 'Try the spare rope.', perceived: ['3', '5'],
  });
  await waitForDraft(page, '/generate @Mara to @Nell |');
  await page.screenshot({ path: path.join(root, 'sticky-mode.png'), animations: 'disabled' });
  results.push('The next generated turn accepts typing and Enter without reselecting the mode, character, or audience');

  await page.close();
  await host.close();
  host = undefined;
  await closeEngine();
  engineUrl = await startEngine();
  host = startHost('fresh-harness-home', engineUrl);
  page = await openPage(await host.url);
  const restoredRows = page.locator('[data-doxvelt-turn]');
  const savedPicker = page.getByLabel('Saved episode', { exact: true });
  assert.equal(await restoredRows.count(), 0);
  const restoredEditor = page.locator('[contenteditable="true"]').first();
  await restoredEditor.fill('/perform @Corin to @Nell | Unsent saved-episode draft.');
  assert.equal(await savedPicker.isDisabled(), true);
  await restoredEditor.fill('/perform @Corin to @Nell | ');
  await savedPicker.selectOption(saved.simulationId);
  await restoredRows.getByText(savedLine).waitFor();
  assert.equal(await restoredRows.count(), 1);
  assert.equal(await savedPicker.locator('option:checked').textContent(), 'The last crossing');
  await waitForDraft(page, '/perform @Corin to @Nell |');

  await page.waitForFunction(() => {
    const selection = document.getSelection();
    const editor = document.activeElement;
    if (!editor?.matches('[contenteditable="true"]') || !selection?.isCollapsed ||
        !editor.contains(selection.anchorNode)) return false;
    const tail = selection.getRangeAt(0).cloneRange();
    tail.setEnd(editor, editor.childNodes.length);
    return tail.toString() === '';
  });
  await page.keyboard.insertText('I will watch the ferry rope.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await restoredRows.nth(1).waitFor();
  await waitForDraft(page, '/perform @Corin to @Nell |');
  assert.equal(await restoredEditor.evaluate(element => element === document.activeElement), true);
  await page.keyboard.insertText('Nell, bring the lantern.');
  await page.keyboard.press('Enter');
  await restoredRows.nth(2).waitFor();
  const durable = await engineRequest(engineUrl, savedRoute + '/stage');
  assert.deepEqual(durable.transcript.map(turn => turn.text), [
    savedLine, 'I will watch the ferry rope.', 'Nell, bring the lantern.',
  ]);
  assert.ok(durable.transcript.every(turn => turn.actorId === 'corin' && turn.audience.includes('nell') && !turn.audience.includes('mara')));
  assert.deepEqual(pageErrors, []);
  await waitForDraft(page, '/perform @Corin to @Nell |');
  await page.screenshot({ path: path.join(root, 'saved-episode.png'), animations: 'disabled' });
  results.push('A fresh DSH profile reopens the SQLite episode after the local API restarts and appends two manual turns');

  await restoredEditor.fill('/generate @Nell to @Corin | Route to the wrong character, Mara.');
  await restoredEditor.press('Enter');
  await page.getByText('Generation did not produce a valid turn. The direction is still in the composer.', { exact: true }).waitFor();
  assert.match(await restoredEditor.innerText(), /Route to the wrong character/);
  assert.equal((await engineRequest(engineUrl, savedRoute + '/stage')).transcript.length, 3);
  await restoredEditor.fill('/generate @Nell to @Corin | Acknowledge Corin.');
  await restoredEditor.press('Enter');
  await restoredRows.getByText('I have the lantern.', { exact: true }).waitFor();
  const committed = (await engineRequest(engineUrl, savedRoute + '/stage')).transcript.at(-1);
  assert.equal(committed.actorId, 'nell');
  assert.deepEqual(committed.audience.sort(), ['corin', 'nell']);
  assert.equal(committed.text, 'I have the lantern.');
  results.push('DSH generates and commits a real Doxvelt turn, and rejects a conflicting audience');
  if (memory) {
    await page.getByText('Episode memory', { exact: true }).click();
    await page.getByLabel('Fictional date').fill('2000-03-01');
    await page.getByRole('button', { name: 'Set date', exact: true }).click();
    holdReflection = true;
    await page.getByRole('button', { name: 'Memorize', exact: true }).click();
    for (let i = 0; i < 60 && !reflecting; i++) await delay(50);
    assert.ok(reflecting, 'The cancellation test reached the reflection provider.');
    await page.getByRole('button', { name: 'Cancel memorization', exact: true }).click();
    await page.getByText('Memorization cancelled.', { exact: true }).waitFor();
    for (let i = 0; i < 60 && !reflectionCancelled; i++) await delay(50);
    assert.ok(reflectionCancelled, 'The provider received cancellation.');
    assert.equal((await engineRequest(engineUrl, savedRoute + '/episode-memory')).episodes[0].status, 'unmemorized');
    holdReflection = false;
    await page.getByRole('button', { name: 'Memorize', exact: true }).click();
    await page.getByText('Memories saved.', { exact: true }).waitFor();
    await page.getByText('I still remember the sealed letter agreement.', { exact: true }).first().waitFor();
    await page.screenshot({ path: path.join(root, 'episode-memory.png'), animations: 'disabled' });
    await waitForDraft(page, '/generate @Nell to @Corin |');
    await page.getByRole('button', { name: 'End and open next episode', exact: true }).click();
    await page.locator('[data-doxvelt-turn]').first().waitFor({ state: 'hidden' });
    await page.getByText('Episode memory', { exact: true }).click();
    await page.getByLabel('Fictional date').fill('2001-03-01');
    await page.getByRole('button', { name: 'Set date', exact: true }).click();
    await page.getByRole('button', { name: 'Close episode memory' }).click();
    const sequelEditor = page.locator('[contenteditable="true"]').first();
    await sequelEditor.fill('/generate @Nell to @Corin | Remember the sealed letter.');
    await sequelEditor.press('Enter');
    await page.locator('[data-doxvelt-turn]').getByText('I have the lantern.', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-doxvelt-turn]').count(), 1);
    results.push('Stock DSH forms inspectable native memories and uses them in a later fictional episode');

    const transcriptPicker = page.getByLabel('Episode transcript', { exact: true });
    await transcriptPicker.selectOption({ index: 1 });
    await page.getByText('Closed episode', { exact: true }).waitFor();
    await page.locator('[data-doxvelt-turn]').getByText(savedLine, { exact: false }).waitFor();
    assert.equal(await page.locator('[data-doxvelt-turn]').count(), 4);
    await page.getByRole('button', { name: 'Episode memory', exact: true }).click();
    await page.getByText('I still remember the sealed letter agreement.', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Close episode memory' }).click();
    await transcriptPicker.selectOption({ label: 'Current episode' });
    await page.getByText('Closed episode', { exact: true }).waitFor({ state: 'hidden' });
    await page.locator('[data-doxvelt-turn]').getByText('I have the lantern.', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-doxvelt-turn]').count(), 1);
    results.push('A closed episode reopens with its own transcript and memory, then returns to current play');

    const source = await engineRequest(engineUrl, savedRoute + '/stage');
    const original = source.transcript[0];
    const { operation } = await engineRequest(engineUrl, savedRoute + '/alternatives', {
      sourceBranchId: saved.branchId, expectedHead: source.branch.headCommitId,
      sourceCommitId: original.commitId, messageVersionId: original.messageVersionId,
      logicalMessageId: original.logicalMessageId, actorId: original.actorId, commandId: 'alternative-audience',
      action: 'manual', audience: ['mara'], manualText: 'Mara, I left the sealed letter at the inn.',
    });
    assert.equal(operation.status, 'saved');
    await page.reload();
    await closeSignIn(page);
    const pathPicker = page.getByLabel('Story path', { exact: true });
    await pathPicker.selectOption(operation.outcome.branchId);
    await page.locator('[data-doxvelt-turn]').getByText('Mara, I left the sealed letter at the inn.', { exact: false }).waitFor();
    await page.getByText('Memories are out of date for', { exact: false }).waitFor();
    assert.equal(await pathPicker.inputValue(), operation.outcome.branchId);
    await pathPicker.selectOption(saved.branchId);
    await page.locator('[data-doxvelt-turn]').getByText('I have the lantern.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Memories are out of date for', { exact: false }).count(), 0);
    await page.getByRole('button', { name: 'Episode memory', exact: true }).click();
    await page.getByLabel('Memory episode').selectOption({ index: 0 });
    await page.getByText('I still remember the sealed letter agreement.', { exact: true }).first().waitFor();
    results.push('Stock DSH switches saved paths, shows memory drift and restores the original memory version');

    await page.getByRole('button', { name: 'Close episode memory' }).click();
    await transcriptPicker.selectOption({ index: 1 });
    const closedTurns = page.locator('[data-doxvelt-turn]');
    const originalRow = closedTurns.filter({ hasText: savedLine });
    await originalRow.getByRole('button', { name: 'Edit turn', exact: true }).click();
    const closedCorrection = 'I left the sealed letter beside the mooring post.';
    await page.getByLabel('Revised performance').fill(closedCorrection);
    await page.getByRole('button', { name: 'Save correction', exact: true }).click();
    await closedTurns.getByText(closedCorrection, { exact: true }).waitFor();
    await page.getByText('Closed episode', { exact: true }).waitFor();
    assert.equal(await closedTurns.count(), 4);
    await page.getByText('Memories are out of date for', { exact: false }).waitFor();
    await transcriptPicker.selectOption({ label: 'Current episode' });
    await page.getByText('Closed episode', { exact: true }).waitFor({ state: 'hidden' });
    await closedTurns.getByText('I have the lantern.', { exact: true }).waitFor();
    assert.equal(await closedTurns.count(), 1);
    await page.getByText('Memories are out of date for', { exact: false }).waitFor();
    results.push('Correcting a closed episode preserves its sequel and shows memory drift in both episodes');
  }
  console.log(JSON.stringify({ results, evidence: root }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    const body = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
    console.error(body.slice(0, 4_000));
  }
  console.error(JSON.stringify({ results, pageErrors, evidence: root }, null, 2));
  throw error;
} finally {
  if (browser) await browser.close();
  if (host) await host.close();
  await closeEngine();
}
