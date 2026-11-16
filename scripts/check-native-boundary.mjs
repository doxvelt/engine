import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root=fileURLToPath(new URL('../',import.meta.url));
const allowed=new Set(['src/core/types.ts','src/core/output-contracts.ts']);
const queue=['src/cli/index.ts','src/local-api/index.ts','scripts/dev.js','scripts/dsh-gui-spike/host.mjs','scripts/dsh-gui-spike/stage.mjs','scripts/dsh-gui-spike/client.js'].map(p=>path.join(root,p));
const seen=new Set();
while(queue.length){
  const filename=queue.pop();if(seen.has(filename))continue;seen.add(filename);
  const relative=path.relative(root,filename).replaceAll('\\','/');
  assert.ok(!relative.startsWith('src/store/')&&(!relative.startsWith('src/core/')||allowed.has(relative)),`Runtime imports the retired TypeScript engine: ${relative}`);
  const original=await readFile(filename,'utf8');
  const code=filename.endsWith('.ts')?ts.transpileModule(original,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ESNext}}).outputText:original;
  const parsed=ts.createSourceFile(filename,code,ts.ScriptTarget.ESNext,true,ts.ScriptKind.JS);
  const dependencies=[];
  function visit(node){
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))dependencies.push(node.moduleSpecifier.text);
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0]))dependencies.push(node.arguments[0].text);
    ts.forEachChild(node,visit);
  }
  visit(parsed);
  for(const dependency of dependencies)if(dependency.startsWith('.'))queue.push(path.resolve(path.dirname(filename),dependency));
}
const server=await readFile(path.join(root,'src/local-api/native-server.ts'),'utf8');
for(const callback of ['application.execute','memory.recall','archive.verify'])assert.ok(!server.includes(`"${callback}"`),`Retired domain callback is present: ${callback}`);
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
for(const dependency of Object.keys({...manifest.dependencies,...manifest.devDependencies}))assert.ok(!/nuxt|^vue$|^@vue\//i.test(dependency),`Retired UI dependency: ${dependency}`);
console.log(`Native boundary verified (${seen.size} runtime modules; no TypeScript kernel/store or Nuxt dependencies).`);
