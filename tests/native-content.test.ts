import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeApiExecutable } from "../src/local-api/native-server.ts";
import { compileWorkspace } from "../src/core/compiler.ts";
import { startBranchSimulation } from "../src/core/branch-kernel.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

/** A native request with no TypeScript application callback or HTTP server. */
async function nativeCompile(workspacePath: string) {
  return nativeRequest("/source/compile", { workspacePath });
}
async function nativeRequest(target: string, body: Record<string, unknown>, database?: string) {
  const child = spawn(nativeApiExecutable(), ["--stdio"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  try {
    child.stdin.write(JSON.stringify({ id: 1, method: "request", params: { method: "POST", target, database,
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) } }) + "\n");
    const [line] = await once(lines, "line", { signal: AbortSignal.timeout(10_000) });
    const reply = JSON.parse(line);
    assert.equal(reply.callId, undefined, "This operation must run natively without a TypeScript application callback");
    assert.equal(reply.result.status, 200, JSON.stringify(reply));
    return reply.result.body;
  } finally { child.stdin.end(); await exit; lines.close(); }
}

for (const workspace of ["examples/last-crossing", "examples/executive-interviews"]) {
  test(`native compiler exactly matches the existing compiled source contract: ${workspace}`, async () => {
    assert.deepEqual(await nativeCompile(workspace), await compileWorkspace(workspace));
  });
}

test("native compiler preserves malformed-metadata, mention and membership-cycle diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-native-content-"));
  try {
    for (const directory of ["models", "entities/jade", "entities/mafia", "connections"]) await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, "entities/jade/IDENTITY.md"), '---\r\nid: jade\r\nkind: invalid\r\nname: "Jade"\r\n---\r\n@jade suspects @stranger is nearby. :+1\r\nUntagged source remains prose.');
    await writeFile(path.join(root, "entities/mafia/IDENTITY.md"), '---\nid: mafia\nkind: affiliation\n---\n@mafia appears quiet. :surface:in_person :+3');
    await writeFile(path.join(root, "connections/jade-mafia.md"), '---\nentities: [jade, mafia]\n---\n@jade has access to @mafia. :access:member\n@mafia has access to @jade. :access:member');
    await writeFile(path.join(root, "models/invalid.yaml"), '---\nid: broken\nprovider: openai-compatible\nbase_url: invalid\n---');
    assert.deepEqual(await nativeCompile(root), await compileWorkspace(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const first of ["native", "typescript"]) {
  test(`native simulation storage and immutable command replay interoperate with the existing database: ${first} first`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-native-start-"));
    const database = path.join(root, "runtime.sqlite");
    const body = { simulationId: "native-story", commandId: "start", branchId: "main", scenarioId: "last-crossing", workspacePath: path.resolve("examples/last-crossing") };
    try {
      const oldStart = async () => {
        const store = await openBranchStore(database).open();
        try { return await startBranchSimulation(store, { ...body, ownerScope: "local" }); }
        finally { store.close(); }
      };
      let expected: Awaited<ReturnType<typeof oldStart>>;
      let result: any;
      if (first === "native") { result = await nativeRequest("/simulations/start", body, database); expected = await oldStart(); }
      else { expected = await oldStart(); result = await nativeRequest("/simulations/start", body, database); }
      assert.deepEqual(result, { ...expected, actors: expected.compiled.entities.filter(actor => actor.kind !== "artifact"),
        models: expected.compiled.models, diagnostics: expected.compiled.diagnostics });
      assert.deepEqual(await nativeRequest("/simulations/start", body, database), result);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
