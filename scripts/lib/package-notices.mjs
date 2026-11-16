import { copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || `${command} exited ${result.status}.`);
  return result.stdout;
}

async function copyNotices(source, target, top = true) {
  let count = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory() && /^(?:licenses?|third[_-]party)$/i.test(entry.name)) {
      count += await copyNotices(path.join(source, entry.name), path.join(target, entry.name), false);
    } else if (entry.isFile() && (!top || /^(?:LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE|AUTHORS|UNLICENSE)(?:[._-]|$)/i.test(entry.name))) {
      await mkdir(target, { recursive: true });
      await copyFile(path.join(source, entry.name), path.join(target, entry.name));
      count++;
    }
  }
  return count;
}

export async function packageNotices(root, directory, metafile) {
  const notices = path.join(directory, 'notices');
  await mkdir(notices, { recursive: true });
  const index = ['# Included dependency notices', '', 'Reverie retains its own LICENSE, NOTICE and notices beside its executable.',
    'The lists below cover the bundled JavaScript and Doxvelt native dependency sources, including build dependencies.', '', '## JavaScript', ''];
  const packages = new Map();
  for (const filename of Object.keys(metafile.inputs)) {
    if (!filename.includes('node_modules/')) continue;
    let folder = path.dirname(path.resolve(root, filename));
    while (folder !== path.dirname(folder)) {
      try {
        const manifest = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
        if (manifest.name && manifest.version) { packages.set(`${manifest.name}@${manifest.version}`, { folder, manifest }); break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      folder = path.dirname(folder);
    }
  }
  for (const [name, { folder, manifest }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const target = path.join(notices, 'javascript', name.replaceAll('/', '_'));
    if (!await copyNotices(folder, target)) throw new Error(`Missing JavaScript license: ${name}`);
    index.push(`- ${name}: ${manifest.license ?? 'see included license'}`);
  }
  index.push('', '## Rust dependencies', '');
  const cargo = path.join(root, 'scripts/cargo.mjs');
  const sysroot = run(process.execPath, [cargo, '--print-sysroot'], { cwd: root }).trim();
  const target = sysroot.match(/(x86_64-pc-windows-(?:gnu|msvc))$/)?.[1];
  if (!target) throw new Error('Unsupported release Rust target.');
  const metadata = JSON.parse(run(process.execPath, [cargo, 'metadata', '--format-version', '1', '--locked', '--offline', '--filter-platform', target], { cwd: root }));
  for (const pkg of metadata.packages.filter(pkg => pkg.source).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!await copyNotices(path.dirname(pkg.manifest_path), path.join(notices, 'crates', `${pkg.name}-${pkg.version}`)))
      throw new Error(`Missing native license: ${pkg.name}`);
    index.push(`- ${pkg.name} ${pkg.version}: ${pkg.license ?? 'see included license'}`);
    if (pkg.name === 'libsqlite3-sys') {
      const sqlite = await readFile(path.join(path.dirname(pkg.manifest_path), 'sqlite3/sqlite3.c'), 'utf8');
      await writeFile(path.join(notices, 'SQLite-header.txt'), sqlite.slice(0, sqlite.indexOf('*/') + 2) + '\n');
    }
  }
  const rust = path.join(sysroot, 'share/doc/rust');
  await mkdir(path.join(notices, 'rust'));
  await copyFile(path.join(rust, 'COPYRIGHT-library.html'), path.join(notices, 'rust/COPYRIGHT-library.html'));
  await cp(path.join(rust, 'licenses'), path.join(notices, 'rust/licenses'), { recursive: true });
  if (sysroot.includes('windows-gnu')) {
    const compilerNotices = process.env.DOXVELT_COMPILER_NOTICES ?? path.join(root, '.tools/gnu/w64devkit/COPYING.MinGW-w64-runtime.txt');
    if (!(await stat(compilerNotices)).isFile()) throw new Error('Supply DOXVELT_COMPILER_NOTICES for the GNU runtime.');
    await copyFile(compilerNotices, path.join(notices, 'MinGW-w64-runtime.txt'));
    index.push('', 'Rust standard-library licenses and the GNU runtime notices are included in rust/ and MinGW-w64-runtime.txt.');
  }
  await writeFile(path.join(notices, 'README.md'), index.join('\n') + '\n');
}
