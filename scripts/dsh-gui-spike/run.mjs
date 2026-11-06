import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const host = spawn(process.execPath, [cli, 'web', '--patch', overlay, '--no-open', '--port', '0'], {
  cwd: workspace,
  windowsHide: true,
  env: { ...inherited, DSH_HOME: path.join(root, 'harness-home'), DOXVELT_SPIKE_ROOT: root },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const hostDone = once(host, 'close');
let log = '';
const launch = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('DSH startup timed out')), 30_000);
  host.on('error', reject);
  host.on('close', code => { clearTimeout(timer); reject(new Error('DSH exited with code ' + code)); });
  host.stdout.on('data', bytes => {
    log += bytes;
    const url = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(log)?.[1];
    if (url) { clearTimeout(timer); resolve(url); }
  });
  host.stderr.on('data', bytes => { log += bytes; });
});

let browser;
let page;
const pageErrors = [];
const results = [];
const readFixture = async () => JSON.parse(await readFile(fixture, 'utf8'));

try {
  const url = await launch;
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 850 }, locale: 'en-US' });
  page.setDefaultTimeout(12_000);
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(url);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const signIn = page.getByRole('dialog', { name: 'Get started' });
  const closeSignIn = async () => {
    const close = signIn.getByRole('button', { name: 'Close', exact: true });
    try { await close.click({ timeout: 3_000 }); }
    catch (error) { if (error.name !== 'TimeoutError' || await signIn.isVisible()) throw error; }
    await signIn.waitFor({ state: 'hidden' });
  };
  await closeSignIn();
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
  assert.equal((await readFixture()).turns[0].audience, 'Nell');
  results.push('Keyboard completion, bidirectional routing, and manual Enter');

  await editor.fill('/generate @Nell to actor | PRIVATE: Be discreet.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await rows.nth(1).waitFor();
  assert.match(await rows.nth(1).innerText(), /Nell → Corin/);
  await editor.fill('/generate @Mara to @Nell | Watch the weather.');
  await editor.press('Enter');
  await rows.nth(2).waitFor();
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
  await closeSignIn();
  assert.deepEqual(await rows.allInnerTexts(), before);
  assert.deepEqual(pageErrors, []);
  results.push('Generation failure preserves the input, retry commits once, reload restores four rows');
  await editor.fill('/generate @Mara to @Nell | Check the steering rope.');
  await page.screenshot({ path: path.join(root, 'stage.png'), animations: 'disabled' });
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
  if (host.exitCode === null && !host.killed) host.kill();
  await hostDone;
  await writeFile(path.join(root, 'host.log'), log.replace(/http:\/\/127\.0\.0\.1:\d+\/[^\s]+/g, '[local launch link]'));
}
