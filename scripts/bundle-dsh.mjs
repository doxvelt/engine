import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [output, metadata] = process.argv.slice(2);
if (!output || !metadata) throw new Error('Usage: bun scripts/bundle-dsh.mjs <host.mjs> <metadata.json>');
const result = await Bun.build({
  entrypoints: ['scripts/dsh-gui-spike/package-host.mjs'],
  target: 'node', format: 'esm', packages: 'bundle', env: 'disable',
  outdir: path.dirname(output), naming: path.basename(output), metafile: true,
  plugins: [{ name: 'dsh-static-package-metadata', setup(build) {
    build.onLoad({ filter: /[\\/]@deepseek-ai[\\/]dsh-llm[\\/]lib[\\/]index\.js$/ }, async ({ path: filename }) => {
      const contents = await readFile(filename, 'utf8');
      const expression = 'createRequire(import.meta.url)("../package.json")';
      if (!contents.includes(expression)) throw new Error('Review DSH package metadata loading before updating the release dependency.');
      const manifest = JSON.parse(await readFile(path.resolve(path.dirname(filename), '../package.json'), 'utf8'));
      // Preserve the dependency's own identity without a runtime path back into node_modules.
      return { contents: contents.replace(expression, JSON.stringify({ version: manifest.version })), loader: 'js' };
    });
  } }],
});
if (!result.success) throw new AggregateError(result.logs, 'DSH host bundling failed.');
if (!result.metafile) throw new Error('This Bun version cannot emit the dependency metadata required for release notices.');
await writeFile(metadata, typeof result.metafile === 'string' ? result.metafile : JSON.stringify(result.metafile));
console.log(`Bundled production DSH host: ${output}`);
