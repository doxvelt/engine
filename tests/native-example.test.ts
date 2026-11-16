import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { playLastCrossing } from "../src/application/example.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { startBranchSimulation } from "../src/core/branch-kernel.ts";

for (const first of ["native", "typescript"]) {
  test(`native example setup resumes its pinned run and retains only the winning allocation (${first} first)`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-example-")); const database = path.join(root, "runtime.sqlite"); const store = await openBranchStore(database).open();
    try {
      let expected; let result;
      if (first === "native") { const entries = await Promise.all([nativeRequest("/examples/last-crossing/play", {}, database), nativeRequest("/examples/last-crossing/play", {}, database)]); assert.deepEqual(entries[0], entries[1]); result = entries[0]; expected = await playLastCrossing(store, root); }
      else { expected = await playLastCrossing(store, root); result = await nativeRequest("/examples/last-crossing/play", {}, database); }
      assert.deepEqual(result, expected); assert.equal(result.simulationId, "example-last-crossing");
      const before = store.exportSimulation("local", result.simulationId);
      await writeFile(path.join(result.workspacePath, "worlds/river-town.md"), "A later source edit cannot change this pinned example.");
      assert.deepEqual(await nativeRequest("/examples/last-crossing/play", {}, database), result);
      assert.deepEqual(store.exportSimulation("local", result.simulationId), before);
      assert.equal((await readdir(root)).filter(name => name.startsWith("last-crossing-")).length, 1);
      await nativeRequest("/examples/last-crossing/play", { workspacePath: path.join(root, "forbidden") }, database, 400);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
}
test("native example setup rejects a conflicting saved identity before allocating source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-example-conflict-")); const database = path.join(root, "runtime.sqlite"); const store = await openBranchStore(database).open();
  try {
    await startBranchSimulation(store, { ownerScope: "local", simulationId: "example-last-crossing", branchId: "main", commandId: "different", scenarioId: "executive-interviews", workspacePath: path.resolve("examples/executive-interviews") });
    await nativeRequest("/examples/last-crossing/play", {}, database, 409);
    assert.ok(!(await readdir(root)).some(name => name.startsWith("last-crossing-")));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
