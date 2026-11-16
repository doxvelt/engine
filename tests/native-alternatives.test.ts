import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";
import { commitManualTurn, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { createSavedAlternative, discoverSavedAlternatives, originatingInput, type AlternativeRequest } from "../src/core/saved-alternatives.ts";
import { stageAlternative, stageAlternativeDetail } from "../src/local-api/stage-contracts.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

test("native historical discovery, originating input, detail and discard survive receipt-only import without domain callbacks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-alternatives-")); const database = path.join(root, "story.sqlite");
  const store = await openBranchStore(database).open();
  try {
    const base = { ownerScope: "local", simulationId: "sim", branchId: "main" };
    const started = await startBranchSimulation(store, { ...base, commandId: "start", workspacePath: path.resolve("examples/last-crossing") });
    const original = commitManualTurn(store, { ...base, expectedHead: started.root.id, commandId: "turn", payload: { actorId: "corin", audience: ["mara"], text: "Original wording.", stageWhisper: "Original direction." } });
    const message = original.commit.events.find(e => e.type === "message_accepted")!;
    if (message.type !== "message_accepted") throw new Error("Missing original message");
    const selection = { sourceBranchId: "main", expectedHead: original.commit.id, sourceCommitId: original.commit.id, messageVersionId: message.message.id, logicalMessageId: message.message.logicalMessageId, actorId: "corin" };
    const request: AlternativeRequest = { ...selection, ownerScope: "local", simulationId: "sim", commandId: "generated", action: "generate", audience: ["corin"], completeWhisper: "New direction." };
    const generated = await createSavedAlternative(store, new DeterministicFakeRuntime([{ type: "completed", text: JSON.stringify({ text: "New wording.", audience: ["corin"] }), stopReason: "stop" }]), request);
    assert.equal(generated.operation.status, "saved");
    const { completeWhisper: _direction, ...manualRequest } = request;
    const manual = await createSavedAlternative(store, undefined, { ...manualRequest, commandId: "manual", action: "manual", manualText: "Manual wording." });
    assert.equal(manual.operation.status, "saved");
    const failed = await createSavedAlternative(store, new DeterministicFakeRuntime([{ type: "failed", message: "PRIVATE FAILURE" }]), { ...request, commandId: "failed" });
    assert.equal(failed.operation.status, "failed");
    const archive = store.exportSimulation("local", "sim");
    const route = "/simulations/sim/alternatives";
    assert.deepEqual(await nativeRequest(route + "/origin", selection, database), originatingInput(store, request));
    assert.deepEqual(await nativeRequest(route, undefined, database), { operations: store.listAlternatives("local", "sim").map(stageAlternative) });
    const expected = discoverSavedAlternatives(store, request);
    const search = new URLSearchParams(selection);
    assert.deepEqual(await nativeRequest(route + "?" + search, undefined, database), { ...expected, operations: expected.operations.map(stageAlternative) });
    for (const operation of [generated.operation, manual.operation, failed.operation])
      assert.deepEqual(await nativeRequest(route + "/" + operation.id, undefined, database), stageAlternativeDetail(operation, store));
    await nativeRequest(route + "/" + failed.operation.id + "/discard", { extra: true }, database, 400);
    const discarded = await nativeRequest(route + "/" + failed.operation.id + "/discard", {}, database);
    assert.equal(discarded.status, "discarded");
    assert.deepEqual(discarded, stageAlternativeDetail(store.getAlternative("local", "sim", failed.operation.id)!, store));
    assert.deepEqual(await nativeRequest(route + "/" + failed.operation.id + "/discard", {}, database), discarded);
    assert.deepEqual(store.exportSimulation("local", "sim"), archive);
    await nativeRequest(route + "/origin", { ...selection, sourceBranchId: "missing" }, database, 404);
    await nativeRequest(route + "/origin", { ...selection, actorId: "mara" }, database, 400);
    await nativeRequest(route + "/missing", undefined, database, 404);
    const importedDatabase = path.join(root, "imported.sqlite"); const imported = await openBranchStore(importedDatabase).open();
    try {
      imported.importSimulation(archive);
      assert.deepEqual(await nativeRequest(route, undefined, importedDatabase), { operations: imported.listAlternatives("local", "sim").map(stageAlternative) });
      assert.deepEqual(await nativeRequest(route + "/" + generated.operation.id, undefined, importedDatabase), stageAlternativeDetail(imported.getAlternative("local", "sim", generated.operation.id)!, imported));
    } finally { imported.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
