import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './lib/package-notices.mjs';

const archive = path.resolve(process.argv[2] ?? 'dist/doxvelt-v0.2.0-alpha.1-windows-x64.zip');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Desktop package verification requires Windows x64 and the pinned DSH desktop host.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await readFile(archive)), (await readFile(archive + '.sha256', 'utf8')).split(' ')[0], 'ZIP checksum');
const root = await mkdtemp(path.join(tmpdir(), 'dx-'));
console.log(`Package verification directory: ${root}`);
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:DOXVELT_PACKAGE_ZIP -DestinationPath $env:DOXVELT_PACKAGE_EXTRACT'], {
  env: { ...process.env, DOXVELT_PACKAGE_ZIP: archive, DOXVELT_PACKAGE_EXTRACT: root },
});
const extracted = path.join(root, path.basename(archive, '.zip'));
const release = JSON.parse(await readFile(path.join(extracted, 'release.json'), 'utf8'));
assert.equal(release.dirty, false, 'Only clean release source can pass verification');
assert.match(release.sourceCommit, /^[0-9a-f]{40}$/);
const home = path.join(root, 'dsh');
const profile = path.join(home, 'profiles/desktop');
await mkdir(profile, { recursive: true });
await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'doxvelt-package-verification', private: true, dsh: { profile: { bundles: [] } } }));
await writeFile(path.join(profile, 'cordis.yml'), '[]\n');
await writeFile(path.join(profile, 'cordis.patch.yml'), '# Keep unrelated settings\n- id: preserved\n  disabled: true\n# BEGIN DOXVELT INSTALLATION\n- id: doxvelt\n  config:\n    reverie: "old-checkout-path"\n# END DOXVELT INSTALLATION\n');
const installRoot = path.join(root, 'plugins');
const dshCommand = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command dsh).Source']).trim();
const installEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^path$/i.test(name)));
installEnvironment.Path = [path.dirname(dshCommand), path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0'), path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(path.delimiter);
installEnvironment.DSH_HOME = home;
installEnvironment.NODE_PATH = '';
const install = () => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(extracted, 'install.ps1'), '-InstallRoot', installRoot], {
  cwd: root, env: installEnvironment,
});
console.log(install());
const patch = await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8');
assert.match(patch, /id: preserved/);
assert.doesNotMatch(patch, /old-checkout-path|BEGIN DOXVELT INSTALLATION/);
const manifestBefore = await readFile(path.join(profile, 'package.json'), 'utf8');
const installed = JSON.parse(manifestBefore);
assert.equal(installed.dsh.profile.bundles.filter(name => name === '@doxvelt/dsh').length, 1);
const plugin = await realpath(path.resolve(profile, installed.dependencies['@doxvelt/dsh'].replace(/^link:/, '')));
assert.ok(plugin.toLowerCase().startsWith((await realpath(installRoot)).toLowerCase() + path.sep), `Plugin ${plugin} must be inside ${installRoot}`);
console.log(install());
assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), manifestBefore, 'Reinstallation is idempotent');
await writeFile(path.join(extracted, 'client.js'), '\n// damaged download\n', { flag: 'a' });
assert.throws(install, /Package verification failed/);
assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), manifestBefore, 'Damaged update preserves registration');

for (const name of Object.keys(process.env)) if (name.startsWith('DOXVELT_')) delete process.env[name];
process.chdir(root);
const { apply } = await import(pathToFileURL(path.join(plugin, 'host.mjs')).href);
const workspace = path.join(root, 'workspace');
await mkdir(workspace);
const events = [];
const session = { id: 'package-check', header: { cwd: workspace }, get seq() { return events.length; }, eventAt: i => events[i],
  append: (type, data) => events.push({ type, data }) };
const dispose = [];
let endpoint;
let reflections = 0;
let generations = 0;
let recalled = false;
const memoryText = 'I remember the packaged ferry crossing.';
const context = {
  on(name, callback) { if (name === 'dispose') dispose.push(callback); },
  get() { return undefined; },
  workspaceRegistry: { list: () => [{ path: workspace }] },
  sessions: { get: id => id === session.id ? session : undefined, async flush() {} },
  connection: { fetch: { register(value) { endpoint = value; } } },
  llm: {
    listProviders: () => [{ id: 'scripted', name: 'Scripted verification' }],
    async listModels() { return [{ id: 'memory', name: 'Memory' }, { id: 'actor', name: 'Actor' }]; },
    async *stream(request) {
      if (request.model === 'actor') {
        generations++;
        recalled = JSON.stringify(request).includes(memoryText);
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'packaged-turn', name: 'doxvelt_turn',
          arguments: JSON.stringify({ text: 'I remember the crossing.', audience: [] }) } };
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      reflections++;
      const text = JSON.stringify({ memories: [{ gist: memoryText, detail: '', feeling: 'Trust', cues: ['ferry'], salience: 0.9, confidence: 0.8, sourceMessageIds: ['m1'] }], impressions: [] });
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  },
};
async function command(mode, fields = {}) {
  const response = await endpoint.fetch(new Request('http://localhost/api/doxvelt-fixture', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, mode, ...fields }) }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
try {
  await apply(context);
  assert.equal((await command('saved')).workspace.active, false);
  await command('workspace-activate');
  for (const [kind, id, body] of [['world', 'river', 'A quiet river.'], ['scenario', 'ferry', 'A ferry crossing.'], ['format', 'script', 'Short dialogue.'], ['character', 'corin', '@corin is a ferryman. :+3']])
    await command('collection-create', { object: { kind, id, name: id, body } });
  let collection = await command('collection');
  const file = collection.files.find(item => item.path === 'worlds/river.md');
  const source = await command('collection-read', { path: file.path });
  await command('collection-save', { source: { path: file.path, text: source.text + '\nThe river is wide.\n', expectedRevision: file.revision } });
  collection = await command('collection');
  await command('workspace-save-models', { configuration: { version: 1, actorModel: { provider: 'scripted', model: 'actor' }, reflectionModel: { provider: 'scripted', model: 'memory' } }, expectedRevision: collection.configurationRevision });
  const started = await command('create-story', { setup: { operationId: 'packaged-story', collectionRevision: collection.revision,
    worldId: 'river', scenarioId: 'ferry', formatId: 'script', characterIds: ['corin'], date: '2000-03-01' } });
  await command('open-saved', { simulationId: started.simulationId });
  await command('perform', { character: 'corin', audience: '!self', body: 'The ferry is ready.' });
  assert.equal(reflections, 0, 'Manual setup/play must not call a model');
  await command('memory-memorize', { slot: 'first' });
  assert.equal(reflections, 1, 'Bundled Reverie receives reflection through the host');
  const status = await command('memory-status');
  assert.ok(JSON.stringify(status).includes(memoryText), 'Published memory is inspectable');
  await command('memory-next', { label: 'The crossing' });
  events.length = 0;
  await command('open-saved', { simulationId: started.simulationId });
  const nextMemory = await command('memory-status');
  const current = nextMemory.episodes.find(episode => episode.episodeId === null);
  await command('memory-date', { slot: current.slot, date: '2000-03-02' });
  assert.equal(reflections, 1, 'Reopening published memory makes no new model calls');
  await command('generate', { character: 'corin', audience: '!self', body: 'Remember the ferry crossing.' });
  assert.equal(generations, 1);
  assert.ok(recalled, 'A later episode receives recalled memory from bundled Reverie');
  assert.ok((await readdir(path.join(workspace, '.doxvelt'))).length > 0);
  console.log('Passed release ZIP checksum, clean provenance, installation/reinstallation without toolchains, damaged-update rejection, source authoring, manual/model play and bundled memory formation/recall.');
  console.log(`Isolated package evidence: ${root}`);
} finally {
  for (const close of dispose) await close();
}
