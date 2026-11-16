import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = new URL("./dsh-gui-spike/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", directory), "utf8"));
assert.equal(manifest.name, "@doxvelt/dsh");
assert.equal(manifest.dsh.client.platform, "web");
for (const entry of Object.values(manifest.exports)) await readFile(new URL(entry, directory));
const patch = await readFile(new URL(manifest.dsh.bundle.patch, directory), "utf8");
assert.ok(patch.includes(manifest.name));
for (const filename of await readdir(directory)) {
  if (!/\.(mjs|js)$/.test(filename)) continue;
  const result = spawnSync(process.execPath, ["--check", fileURLToPath(new URL(filename, directory))], { encoding: "utf8" });
  assert.equal(result.status, 0, `${filename}: ${result.stderr}`);
}
console.log("DSH plugin exports, bundle patch, and JavaScript syntax verified.");
