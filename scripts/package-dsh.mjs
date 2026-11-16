import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { packageNotices, run } from './lib/package-notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  'reverie-archive': { type: 'string' }, out: { type: 'string', default: 'dist' },
  'allow-dirty': { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('bun run desktop:package [--reverie-archive <pinned ZIP>] [--out <directory>] [--allow-dirty]');
  console.log('Builds a Windows x64 release ZIP. Downloads only the version and checksum pinned in scripts/desktop-release.json.');
  process.exit(0);
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Desktop packaging currently requires Windows x64.');
const pin = JSON.parse(await readFile(path.join(root, 'scripts/desktop-release.json'), 'utf8'));
const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const plugin = JSON.parse(await readFile(path.join(root, 'scripts/dsh-gui-spike/package.json'), 'utf8'));
if (source.version !== plugin.version || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(source.version)) throw new Error('Root and plugin release versions must match.');
const dirty = Boolean(run('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root }).trim());
if (dirty && !values['allow-dirty']) throw new Error('Commit release changes before packaging; use --allow-dirty only for local validation.');
const commit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
const out = path.resolve(values.out);
await mkdir(out, { recursive: true });
const staging = await mkdtemp(path.join(out, '.desktop-build-'));
const name = `doxvelt-v${source.version}-windows-x64`;
const directory = path.join(staging, name);
const native = path.join(directory, `native/${pin.platform}-${pin.arch}`);
await mkdir(native, { recursive: true });
const archiveBytes = values['reverie-archive'] ? await readFile(path.resolve(values['reverie-archive'])) : await (async () => {
  const response = await fetch(`https://github.com/${pin.reverie.repository}/releases/download/${pin.reverie.tag}/${pin.reverie.asset}`);
  if (!response.ok) throw new Error(`Pinned Reverie download failed: HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
})();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
if (sha256(archiveBytes) !== pin.reverie.sha256) throw new Error('Reverie ZIP does not match the pinned release checksum.');
const reverieZip = path.join(staging, pin.reverie.asset);
await writeFile(reverieZip, archiveBytes);
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:DOXVELT_PACKAGE_ZIP -DestinationPath $env:DOXVELT_PACKAGE_EXTRACT'], {
  env: { ...process.env, DOXVELT_PACKAGE_ZIP: reverieZip, DOXVELT_PACKAGE_EXTRACT: path.join(staging, 'reverie') },
});
const reverie = path.join(staging, 'reverie', pin.reverie.asset.replace(/\.zip$/, ''));
for (const required of ['reverie-engine.exe', 'LICENSE', 'NOTICE', 'notices/README.md']) await readFile(path.join(reverie, required));
await cp(reverie, path.join(native, 'reverie'), { recursive: true });
run(process.execPath, [path.join(root, 'scripts/cargo.mjs'), 'build', '--release', '--locked'], { cwd: root, stdio: 'inherit' });
await copyFile(path.join(root, 'api/target/release/doxvelt-api.exe'), path.join(native, 'doxvelt-api.exe'));
const meta = path.join(staging, 'bundle.json');
run('bun', ['scripts/bundle-dsh.mjs', path.join(directory, 'host.mjs'), meta], { cwd: root, stdio: 'inherit' });
const metafile = JSON.parse(await readFile(meta, 'utf8'));
for (const output of Object.values(metafile.outputs)) {
  if (output.imports.some(item => item.external && !item.path.startsWith('node:'))) throw new Error('Release host has an unbundled dependency.');
}
await packageNotices(root, directory, metafile);
await writeFile(path.join(directory, 'package.json'), JSON.stringify({ ...plugin, os: [pin.platform], cpu: [pin.arch],
  engines: { node: '>=24' }, exports: { '.': './host.mjs', './client': './client.js' } }, null, 2) + '\n');
for (const filename of ['client.js', 'cordis.patch.yml']) await copyFile(path.join(root, 'scripts/dsh-gui-spike', filename), path.join(directory, filename));
await copyFile(path.join(root, 'scripts/install-dsh-package.ps1'), path.join(directory, 'install.ps1'));
await copyFile(path.join(root, 'README.md'), path.join(directory, 'README.md'));
await writeFile(path.join(directory, 'release.json'), JSON.stringify({ version: source.version, sourceCommit: commit, dirty, ...pin }, null, 2) + '\n');
const sums = [];
async function hashTree(folder) {
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(folder, entry.name);
    if (entry.isDirectory()) await hashTree(filename);
    else if (entry.isFile()) sums.push(`${sha256(await readFile(filename))}  ${path.relative(directory, filename).replaceAll('\\', '/')}`);
    else throw new Error('Release payload cannot contain links.');
  }
}
await hashTree(directory);
await writeFile(path.join(directory, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
const temporaryZip = path.join(staging, name + '.zip');
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:DOXVELT_PACKAGE_SOURCE -DestinationPath $env:DOXVELT_PACKAGE_ZIP -CompressionLevel Optimal'], {
  env: { ...process.env, DOXVELT_PACKAGE_SOURCE: directory, DOXVELT_PACKAGE_ZIP: temporaryZip },
});
const checksum = sha256(await readFile(temporaryZip));
const archive = path.join(out, name + '.zip');
await rename(temporaryZip, archive);
await writeFile(archive + '.sha256', `${checksum}  ${path.basename(archive)}\n`);
console.log(`Packaged ${archive}\nSHA256 ${checksum}\nSource ${commit}${dirty ? ' (uncommitted development build; do not publish)' : ''}`);
