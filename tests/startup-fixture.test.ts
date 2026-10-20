import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareStartupFixture } from "../scripts/startup-fixture.ts";

test("startup fixture copies tracked working source without runtime or Nuxt state and links installed packages", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-fresh-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareStartupFixture(process.cwd(), root);
  assert.equal(await readFile(path.join(root, "src/local-api/startup.ts"), "utf8"), await readFile("src/local-api/startup.ts", "utf8"));
  assert.equal(await readFile(path.join(root, "package.json"), "utf8"), await readFile("package.json", "utf8"));
  for (const file of [".doxvelt", ".nuxt", ".output", "src/local-ui/.nuxt", "src/local-ui/.output", "node_modules/.cache", "node_modules/.vite"]) {
    await assert.rejects(readdir(path.join(root, file)), { code: "ENOENT" });
  }
  assert.equal(await realpath(path.join(root, "node_modules/nuxt")), await realpath("node_modules/nuxt"));
  assert.notEqual(await realpath(path.join(root, "node_modules")), await realpath("node_modules"), "cache writes must stay in the isolated node_modules directory");
  await readFile(path.join(root, "examples/last-crossing/entities/mara/IDENTITY.md"));
  await readFile(path.join(root, "design-system/tokens.css"));
});
