import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";
import { commitManualTurn, stageWhisper, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { createSavedAlternative, type AlternativeRequest } from "../src/core/saved-alternatives.ts";
import { stageAlternativeDetail } from "../src/local-api/stage-contracts.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import type { RunActorTurnRequest } from "../src/agent-runtime/contracts.ts";

for (const first of ["native", "typescript"]) for (const action of ["manual", "generate"] as const) {
  test(`native historical ${action} shares frozen input, receipts and recovery (${first} first)`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-history-generation-")); const database = path.join(root, "story.sqlite");
    const store = await openBranchStore(database).open();
    try {
      const base = { ownerScope: "local", simulationId: "sim", branchId: "main" };
      const started = await startBranchSimulation(store, { ...base, commandId: "start", workspacePath: path.resolve("examples/executive-interviews") });
      const original = commitManualTurn(store, { ...base, expectedHead: started.root.id, commandId: "original", payload: { actorId: "ceo", audience: ["ceo"], text: "SELECTED-OLD-WORDING", stageWhisper: "OLD-INPUT-TO-SUBTRACT" } });
      const later = commitManualTurn(store, { ...base, expectedHead: original.commit.id, commandId: "later", payload: { actorId: "cfo", audience: ["ceo"], text: "LATER-UNRELATED" } });
      stageWhisper(store, { ...base, expectedHead: later.commit.id, commandId: "pending", targetActorId: "ceo", text: "UNRELATED-PENDING-DIRECTION" });
      const message = original.commit.events.find(e => e.type === "message_accepted")!;
      if (message.type !== "message_accepted") throw new Error("Missing original message");
      const profile = { id: "selected-configuration", version: "v7" };
      const body = { sourceBranchId: "main", expectedHead: later.commit.id, sourceCommitId: original.commit.id, messageVersionId: message.message.id, logicalMessageId: message.message.logicalMessageId,
        actorId: "ceo", commandId: "alternative", action, audience: ["ceo"], ...(action === "manual" ? { manualText: "A manual replacement." } : { completeWhisper: "NEW-COMPLETE-DIRECTION", actorConfiguration: "chosen" }) };
      const { actorConfiguration: _configuration, ...domainBody } = body as typeof body & { actorConfiguration?: string };
      const request: AlternativeRequest = { ...domainBody, ownerScope: "local", simulationId: "sim", ...(action === "generate" ? { actorProfile: profile } : {}) };
      const wording = JSON.stringify({ text: "A generated replacement.", audience: ["ceo"] });
      // Nonempty frozen recall has a native library proof; this transport proof
      // uses an unavailable memory service, without any JS recall callback.
      const recall: [] = [];
      const expectedRequests: RunActorTurnRequest[] = []; const actualRequests: RunActorTurnRequest[] = [];
      const runtime = new DeterministicFakeRuntime([{ type: "completed", text: wording, stopReason: "stop" }], r => expectedRequests.push(r));
      const mirror = await openBranchStore(path.join(root, "oracle.sqlite")).open();
      try {
        mirror.importSimulation(store.exportSimulation("local", "sim"));
        const oracle = await createSavedAlternative(mirror, runtime, request, { recall: async () => recall });
        assert.equal(oracle.operation.status, "saved");
        let cursor = 0; let recalls = 0;
        const callbacks = action === "manual" ? {} : {
          "model.describe": (params: Record<string, unknown>) => { assert.equal(params.actorId, "ceo"); return { configured: true, profile, defaultProfile: false, memoryEnabled: true }; },
          "host.features": () => { recalls++; return { episodeMemory: null }; },
          "model.open": (params: Record<string, unknown>) => { actualRequests.push(params.request as RunActorTurnRequest); cursor = 0; return { streamId: "model", identity: { id: "deterministic-fake", version: "1", providerId: null, modelId: null } }; },
          "model.next": () => cursor++ === 0 ? { done: false, event: { type: "completed", text: wording, stopReason: "stop" } } : { done: true },
          "model.close": () => ({}),
        };
        let expected; let result;
        if (first === "native") { result = await nativeRequest("/simulations/sim/alternatives", body, database, 200, callbacks); expected = await createSavedAlternative(store, runtime, request); }
        else { expected = await createSavedAlternative(store, runtime, request, { recall: async () => recall }); result = await nativeRequest("/simulations/sim/alternatives", body, database, 200, callbacks); }
        assert.deepEqual(result, { operation: stageAlternativeDetail(expected.operation, store), replayed: first === "typescript" });
        assert.equal(result.operation.status, "saved");
        assert.equal(store.getBranch("local", "sim", "main")!.headCommitId, later.commit.id);
        const archive = store.exportSimulation("local", "sim"); validateSimulationArchive(archive);
        const receipt = archive.commandResults.find(c => c.commandId === "alternative")!;
        assert.deepEqual(receipt.canonicalInput, mirror.exportSimulation("local", "sim").commandResults.find(c => c.commandId === "alternative")!.canonicalInput);
        if (action === "generate" && first === "native") {
          assert.deepEqual(actualRequests[0], expectedRequests[0]);
          for (const excluded of ["SELECTED-OLD-WORDING", "OLD-INPUT-TO-SUBTRACT", "LATER-UNRELATED", "UNRELATED-PENDING-DIRECTION"]) assert.ok(!actualRequests[0]!.prompt.includes(excluded), excluded);
          assert.equal(recalls, 1);
        }
        const replay = await nativeRequest("/simulations/sim/alternatives", body, database, 200, callbacks);
        assert.deepEqual(replay, { ...result, replayed: true }); assert.equal(actualRequests.length, first === "native" && action === "generate" ? 1 : 0);
        await nativeRequest("/simulations/sim/alternatives", { ...body, commandId: "stale", expectedHead: started.root.id }, database, 409, callbacks);
        const importedDatabase = path.join(root, "imported.sqlite"); const imported = await openBranchStore(importedDatabase).open();
        try { imported.importSimulation(archive); }
        finally { imported.close(); }
        const recovered = await nativeRequest("/simulations/sim/alternatives", body, importedDatabase, 200, callbacks);
        assert.equal(recovered.replayed, true); assert.deepEqual(recovered.operation.outcome, result.operation.outcome);
        assert.equal(actualRequests.length, first === "native" && action === "generate" ? 1 : 0);
      } finally { mirror.close(); }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
}
