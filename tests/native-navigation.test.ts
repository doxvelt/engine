import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { forkBranch, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

for (const first of ["native", "typescript"]) {
  test(`native resume metadata preserves CAS, exact replay and portable-history isolation (${first} first)`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-navigation-"));
    const database = path.join(root, "story.sqlite"); const store = await openBranchStore(database).open();
    try {
      const base = { ownerScope: "local", simulationId: "saved / run", branchId: "saved / branch" };
      const started = await startBranchSimulation(store, { ...base, commandId: "start", workspacePath: path.resolve("examples/last-crossing") });
      forkBranch(store, { ...base, commandId: "fork", sourceBranchId: base.branchId, expectedHead: started.root.id, atCommitId: started.root.id, branchId: "other" });
      const archive = store.exportSimulation(base.ownerScope, base.simulationId);
      const route = `/simulations/${encodeURIComponent(base.simulationId)}/navigation`;
      assert.deepEqual(await nativeRequest(route + `?branchId=${encodeURIComponent(base.branchId)}`, undefined, database), { version: null });
      const command = { ...base, operationId: "nav-α-😀", expectedVersion: null };
      const body = { branchId: base.branchId, operationId: command.operationId, expectedVersion: null };
      let expected; let result;
      if (first === "native") { result = await nativeRequest(route, body, database); expected = store.recordSimulationOpened(command); }
      else { expected = store.recordSimulationOpened(command); result = await nativeRequest(route, body, database); }
      assert.deepEqual(result, expected);
      assert.deepEqual(await nativeRequest(route, body, database), expected);
      await nativeRequest(route, { ...body, branchId: "other" }, database, 409);
      const second = await nativeRequest(route, { ...body, operationId: "nav-two", expectedVersion: command.operationId }, database);
      assert.ok(second.openedAt > expected.openedAt);
      await nativeRequest(route, { ...body, operationId: "stale" }, database, 400);
      assert.equal(store.getNavigationVersion("local"), "nav-two");
      for (const token of [".", "..", "bad/token", "bad\\token", "bad token", "bad\uFEFFtoken", "x".repeat(201)])
        await nativeRequest(route, { ...body, operationId: token, expectedVersion: "nav-two" }, database, 400);
      const db = new DatabaseSync(database);
      try { db.prepare("UPDATE application_navigation_version SET opened_at=? WHERE owner_scope='local'").run("2100-01-01T00:00:00.000Z"); }
      finally { db.close(); }
      const future = await nativeRequest(route, { ...body, operationId: "nav-future", expectedVersion: "nav-two" }, database);
      assert.equal(future.openedAt, "2100-01-01T00:00:00.001Z");
      assert.deepEqual(await nativeRequest(route + `?branchId=${encodeURIComponent(base.branchId)}`, undefined, database), { version: "nav-future" });
      assert.equal((await nativeRequest("/simulations", undefined, database)).simulations[0].openedAt, future.openedAt);
      assert.deepEqual(store.exportSimulation(base.ownerScope, base.simulationId), archive);
      await nativeRequest(route + "?branchId=missing", undefined, database, 404);
      await nativeRequest(route, { ...body, operationId: "nav", extra: true }, database, 400);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
}
