import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const run = promisify(execFile);

test("actual API entry rejects malformed explicit configuration without logging its contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-config-cli-"));
  try {
    const file = path.join(root, "config.json");
    await writeFile(file, '{"TEST_SECRET_SENTINEL":', { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { ...process.env, DOXVELT_RUNTIME_API_KEY: "TEST_SECRET_SENTINEL" };
    delete env.NODE_TEST_CONTEXT;
    await assert.rejects(run(process.execPath, ["src/local-api/index.ts", "--runtime-config", file], { timeout: 3000, env }), (error: unknown) => {
      const result = error as { code: unknown; stderr: string; stdout: string };
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Invalid runtime configuration JSON/);
      assert.doesNotMatch(result.stderr + result.stdout, /TEST_SECRET_SENTINEL/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
