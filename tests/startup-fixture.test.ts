import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareStartupFixture } from "../scripts/startup-fixture.ts";

test("startup fixture copies working source without runtime or Nuxt state and links installed packages", async t => {
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
  assert.equal(await readFile(path.join(root, "scripts/empty.env"), "utf8"), "");
  for (const file of ["examples/executive-interviews/models/manual.yaml", "examples/executive-interviews/models/local-openai-compatible.yaml", "scripts/probe-stage-history.mjs", "design-system/fonts/Geist/OFL.txt"]) {
    assert.equal(await readFile(path.join(root, file), "utf8"), await readFile(file, "utf8"));
  }
});

test("ZIP source fixture includes untracked source and excludes secrets, caches and symlinks", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-zip-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const launch = path.join(root, "launch");
  const included = ["package.json", "tsconfig.json", "src/new.ts", "scripts/new.js", "scripts/new.mjs", "scripts/empty.env", "examples/new/IDENTITY.md", "examples/new/models/manual.yaml", "design-system/new.woff2", "design-system/fonts/OFL.txt"];
  const excluded = [".env", ".git/config", ".doxvelt/inference.json", "src/.env.local", "scripts/.env", "scripts/private.env", "examples/new/.env", "src/inference.json", "src/runtime-config.json", "src/story.sqlite", "src/story.db-wal", "src/key.pem", "src/.nuxt/state.json", "src/.cache/state.json", "src/cache/state.json", "src/node_modules/pkg/index.js", "src/secrets/key.json", "src/dist/built.js", "node_modules/.cache/state.json"];
  for (const file of [...included, ...excluded, "node_modules/pkg/index.js"]) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), file === "scripts/empty.env" ? "" : file);
  }
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "outside.ts"), "private");
  await symlink(outside, path.join(source, "src/linked"), "dir");
  await symlink(path.join(outside, "outside.ts"), path.join(source, "src/linked.ts"));
  await prepareStartupFixture(source, launch);
  for (const file of included) assert.equal(await readFile(path.join(launch, file), "utf8"), file === "scripts/empty.env" ? "" : file);
  for (const file of [...excluded, "src/linked/outside.ts", "src/linked.ts"]) await assert.rejects(readFile(path.join(launch, file)), { code: "ENOENT" });
  assert.equal(await realpath(path.join(launch, "node_modules/pkg")), path.join(source, "node_modules/pkg"));
  await mkdir(path.join(launch, "node_modules/.cache"));
  await writeFile(path.join(launch, "node_modules/.cache/local"), "local");
  await assert.rejects(readFile(path.join(source, "node_modules/.cache/local")), { code: "ENOENT" });
});

test("startup fixture rejects a nonempty or nonregular scripts/empty.env", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-dotenv-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  for (const directory of ["src", "scripts", "examples", "design-system", "node_modules"]) await mkdir(path.join(source, directory), { recursive: true });
  for (const file of ["package.json", "tsconfig.json"]) await writeFile(path.join(source, file), "{}");
  const dotenv = path.join(source, "scripts/empty.env");
  await writeFile(dotenv, "PRIVATE_KEY=SECRET_SENTINEL");
  await assert.rejects(prepareStartupFixture(source, path.join(root, "nonempty")), /scripts\/empty.env must be a regular empty file/);
  await assert.rejects(readFile(path.join(root, "nonempty/scripts/empty.env")), { code: "ENOENT" });
  await rm(dotenv);
  const outside = path.join(root, "outside.env");
  await writeFile(outside, "");
  await symlink(outside, dotenv);
  await assert.rejects(prepareStartupFixture(source, path.join(root, "symlink")), /scripts\/empty.env must be a regular empty file/);
  await assert.rejects(readFile(path.join(root, "symlink/scripts/empty.env")), { code: "ENOENT" });
  await rm(dotenv);
  await mkdir(dotenv);
  await assert.rejects(prepareStartupFixture(source, path.join(root, "directory")), /scripts\/empty.env must be a regular empty file/);
});
