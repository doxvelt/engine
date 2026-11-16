import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, mkdir, symlink, chmod, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolveStartup, setupInference } from "../src/local-api/startup.ts";
import { spawn } from "node:child_process";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "inference.json");
  return { root, file, args: ["--runtime-config", file] };
}
const config = { baseUrl: "http://localhost:1234/v1", modelId: "opaque:model:Q4", apiKey: "TEST_SECRET_SENTINEL", contextWindow: 8192, maxTokens: 512 };

test("ordinary first launch creates a complete private manual profile and preserves it and stories on restart", async t => {
  const { root } = await fixture(t);
  const file = path.join(root, ".doxvelt/inference.json");
  const providerFetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider request"); });
  assert.equal(resolveStartup([], {}, root).runtime, undefined);
  const bytes = await readFile(file, "utf8");
  assert.deepEqual(JSON.parse(bytes), { baseUrl: "", modelId: "", contextWindow: 16384, maxTokens: 1024, apiKey: "" });
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  }
  const story = path.join(root, ".doxvelt/runtime.sqlite");
  await writeFile(story, "saved story sentinel");
  assert.equal(resolveStartup([], {}, root).runtime, undefined);
  assert.equal(await readFile(file, "utf8"), bytes);
  assert.equal(await readFile(story, "utf8"), "saved story sentinel");
  await writeFile(file, JSON.stringify(config));
  assert.deepEqual(resolveStartup([], {}, root).runtime, config);
  assert.equal(await readFile(file, "utf8"), JSON.stringify(config));
  assert.equal(providerFetch.mock.callCount(), 0, "startup must not contact a provider, even after configuration");
});

test("blank and legacy profiles are manual; partial, malformed and unsafe profiles remain errors without replacement", async t => {
  const { root } = await fixture(t);
  const dir = path.join(root, ".doxvelt");
  const file = path.join(dir, "inference.json");
  await mkdir(dir);
  for (const profile of [{}, { baseUrl: "", modelId: "", apiKey: "", contextWindow: 16384, maxTokens: 1024 }]) {
    const bytes = JSON.stringify(profile);
    await writeFile(file, bytes, { mode: 0o600 });
    assert.equal(resolveStartup([], {}, root).runtime, undefined);
    assert.equal(await readFile(file, "utf8"), bytes);
  }
  for (const bytes of ['{broken', JSON.stringify({ baseUrl: config.baseUrl, modelId: "" }), JSON.stringify({ baseUrl: "", modelId: config.modelId }), JSON.stringify({ baseUrl: "", modelId: "", contextWindow: 1, maxTokens: 2 }), JSON.stringify({ ...config, baseUrl: "http://user:secret@localhost" })]) {
    await writeFile(file, bytes);
    assert.throws(() => resolveStartup([], {}, root));
    assert.equal(await readFile(file, "utf8"), bytes);
  }
  await rm(file);
  await t.test("dangling configuration symlinks remain errors", async t => {
    try { await symlink(path.join(root, "missing-target"), file); }
    catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Windows file symlinks require Developer Mode or symlink privileges."); return;
      }
      throw error;
    }
    assert.throws(() => resolveStartup([], {}, root));
    await assert.rejects(readFile(path.join(root, "missing-target")));
  });
});

test("concurrent implicit launches reuse the exclusively created profile", async t => {
  const { root } = await fixture(t);
  const source = `import { resolveStartup } from ${JSON.stringify(new URL("../src/local-api/startup.ts", import.meta.url).href)}; resolveStartup([], {}, process.argv[1]);`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, root], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal(JSON.parse(await readFile(path.join(root, ".doxvelt/inference.json"), "utf8")).baseUrl, "");
  assert.equal(resolveStartup([], {}, root).runtime, undefined);
});

test("missing default config is manual; explicit missing and present malformed config fail safely", async t => {
  const { root, file, args } = await fixture(t);
  assert.throws(() => resolveStartup(args, {}, root), /Cannot read runtime configuration/);
  await assert.rejects(readFile(file));
  await assert.rejects(readFile(path.join(root, ".doxvelt/inference.json")));
  assert.equal(resolveStartup([], {}, root).runtime, undefined);
  for (const value of ['{"TEST_SECRET_SENTINEL":', JSON.stringify({ ...config, maxTokens: "TEST_SECRET_SENTINEL" }), JSON.stringify({ ...config, apiKey: 3 }), JSON.stringify({ extra: "TEST_SECRET_SENTINEL" })]) {
    await writeFile(file, value, { mode: 0o600 });
    assert.throws(() => resolveStartup(args, {}, root), error => {
      assert.doesNotMatch(String(error), /TEST_SECRET_SENTINEL/);
      return true;
    });
  }
});

test("CLI nonsecrets override file; environment key overrides file including empty keyless override", async t => {
  const { file, args } = await fixture(t);
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const resolved = resolveStartup([...args, "--runtime-model", "other:exact", "--runtime-max-tokens", "64"], { DOXVELT_RUNTIME_API_KEY: "env-sentinel" });
  assert.deepEqual(resolved.runtime, { ...config, modelId: "other:exact", maxTokens: 64, apiKey: "env-sentinel" });
  assert.equal(resolveStartup(args, { DOXVELT_RUNTIME_API_KEY: "" }).runtime?.apiKey, "");
  assert.equal(resolveStartup(args, {}).runtime?.apiKey, config.apiKey);
});

test("strict flags and bounded config validation never echo raw values", async t => {
  const { file, args } = await fixture(t);
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  for (const flags of [["--unknown", "TEST_SECRET_SENTINEL"], ["--api-key", "TEST_SECRET_SENTINEL"], ["--port", "nan"], ["--port"], ["--runtime-model", ""], ["--port", "123", "--port", "456"], ["--runtime-max-tokens", "9999999"]]) {
    assert.throws(() => resolveStartup([...args, ...flags], {}), error => {
      assert.doesNotMatch(String(error), /TEST_SECRET_SENTINEL/);
      return true;
    });
  }
  await writeFile(file, JSON.stringify({ ...config, baseUrl: "http://user:TEST_SECRET_SENTINEL@localhost" }));
  assert.throws(() => resolveStartup(args, {}), /baseUrl/);
});

test("setup is exclusive and private; permissive files rejected on POSIX", async t => {
  const { root } = await fixture(t);
  setupInference(root);
  const file = path.join(root, ".doxvelt/inference.json");
  const original = await readFile(file, "utf8");
  assert.throws(() => setupInference(root), /already exists/);
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal(resolveStartup([], {}, root).runtime, undefined);
  if (process.platform !== "win32") {
    await chmod(file, 0o644);
    assert.throws(() => resolveStartup([], {}, root), /permissions/);
    assert.equal(await readFile(file, "utf8"), original);
  }
});

test("explicit IPv6 host overrides remain usable for direct API and joint startup", async t => {
  const { root } = await fixture(t);
  assert.equal(resolveStartup(["--host", "::1"], {}, root).host, "::1");
  assert.equal(resolveStartup(["--host", "::"], {}, root).host, "::");
});

test("provider diagnostics classify failure without retaining provider body or secrets", async () => {
  const { safeRuntimeDiagnostic } = await import("../src/agent-runtime/local-openai-compatible.ts");
  for (const detail of ["401 TEST_SECRET_SENTINEL", "403 TEST_SECRET_SENTINEL", "Connection error TEST_SECRET_SENTINEL", "503 TEST_SECRET_SENTINEL", "arbitrary TEST_SECRET_SENTINEL"]) {
    const message = safeRuntimeDiagnostic(detail);
    assert.doesNotMatch(message, /TEST_SECRET_SENTINEL/);
    assert.match(message, /Check/);
    if (/40[13]/.test(detail)) assert.match(message, /authentication failed/);
    if (/Connection|503/.test(detail)) assert.match(message, /unavailable/);
  }
});

// Builtin mocking stays inside this test file's isolated Node test process.
test("unsupported hard-link publication falls back only for implicit missing defaults", async t => {
  const { root } = await fixture(t);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const link = t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("SECRET path"), { code: "EPERM" }); });
  syncBuiltinESMExports();
  t.after(() => { link.mock.restore(); syncBuiltinESMExports(); });
  for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]) {
    link.mock.mockImplementation(() => { throw Object.assign(new Error("SECRET path"), { code }); });
    assert.equal(resolveStartup([], {}, root).runtime, undefined);
    assert.deepEqual(await readdir(path.join(root, ".doxvelt")), []);
    assert.deepEqual(resolveStartup(["--runtime-base-url", config.baseUrl, "--runtime-model", config.modelId], { DOXVELT_RUNTIME_API_KEY: "override" }, root).runtime,
      { baseUrl: config.baseUrl, modelId: config.modelId, apiKey: "override" });
    assert.throws(() => setupInference(root), /Cannot publish runtime configuration/);
    assert.deepEqual(await readdir(path.join(root, ".doxvelt")), []);
    assert.throws(() => resolveStartup(["--runtime-config", path.join(root, ".doxvelt/inference.json")], {}, root), /Cannot read/);
  }
  assert.equal(warnings.length, 10);
  for (const warning of warnings) {
    assert.match(warning, /Automatic configuration could not be created.*manual play remains available/);
    assert.match(warning, /docs\/LOCAL_REFERENCE.md/);
    assert.ok(!warning.includes(root));
    assert.doesNotMatch(warning, /SECRET/);
  }
  link.mock.mockImplementation(() => { throw Object.assign(new Error("SECRET"), { code: "EIO" }); });
  assert.throws(() => resolveStartup([], {}, root), /Cannot publish/);
  assert.equal(warnings.length, 10);
  const mkdir = t.mock.method(fs, "mkdirSync", () => { throw Object.assign(new Error("SECRET"), { code: "EPERM" }); });
  syncBuiltinESMExports();
  assert.throws(() => resolveStartup([], {}, root), /Cannot create/);
  assert.equal(warnings.length, 10);
  mkdir.mock.restore();
  link.mock.restore();
  const write = t.mock.method(fs, "writeFileSync", () => { throw Object.assign(new Error("SECRET"), { code: "EPERM" }); });
  syncBuiltinESMExports();
  assert.throws(() => resolveStartup([], {}, root), /Cannot create/);
  assert.deepEqual(await readdir(path.join(root, ".doxvelt")), []);
  assert.equal(warnings.length, 10);
  write.mock.restore();
  syncBuiltinESMExports();
});
