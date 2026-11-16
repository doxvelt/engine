import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("production plugin imports from a detached folder without source or node_modules", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "doxvelt-bundle-"));
  try {
    const host = path.join(directory, "host.mjs");
    const metadata = path.join(directory, "metadata.json");
    const built = spawnSync("bun", ["scripts/bundle-dsh.mjs", host, metadata], { encoding: "utf8", windowsHide: true });
    assert.equal(built.status, 0, built.stderr || built.error?.message);
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(host).href)}); if (typeof m.apply !== 'function' || !m.inject.includes('llm')) process.exit(1);`], {
      cwd: directory, encoding: "utf8", windowsHide: true, env: { ...process.env, NODE_PATH: "" },
    });
    assert.equal(imported.status, 0, imported.stderr || imported.error?.message);
    const modules = Object.keys(JSON.parse(await readFile(metadata, "utf8")).inputs);
    assert.ok(!modules.some(name => /src\/store\/|src\/core\/(?!types|output-contracts)/.test(name)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
