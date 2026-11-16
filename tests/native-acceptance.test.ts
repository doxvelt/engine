import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";
import { startBranchSimulation, stageWhisper } from "../src/core/branch-kernel.ts";
import { acceptActorTurnDraft, generateActorTurnDraft } from "../src/core/draft-lifecycle.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

for (const first of ["native", "typescript"]) for (const edited of [false, true]) {
  test(`native acceptance shares receipts, exact wording and imported replay (${first} first, ${edited ? "edited" : "verbatim"})`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-accept-")); const database = path.join(root, "story.sqlite");
    const store = await openBranchStore(database).open();
    try {
      const base = { ownerScope: "local", simulationId: "sim", branchId: "main" };
      const started = await startBranchSimulation(store, { ...base, commandId: "start", workspacePath: path.resolve("examples/executive-interviews") });
      const whisper = stageWhisper(store, { ...base, commandId: "whisper", expectedHead: started.root.id, targetActorId: "ceo", text: "Private direction." });
      const generated = await generateActorTurnDraft(store, new DeterministicFakeRuntime([{ type: "completed", text: "  Generated wording.  ", usage: { inputTokens: 2, outputTokens: 3 } }]),
        { ...base, commandId: "generate", expectedHead: started.root.id, payload: { actorId: "ceo", audience: ["cfo"], stageWhisperIds: [whisper.id],
          runtimeProfile: { id: "character", version: "v1" }, promptPolicy: { id: "default", version: "v1" }, outputSchema: { id: "screenplay", digest: "schema-v1" }, skillDigests: ["skill-a"] } });
      const body = { commandId: "accept", ...(edited ? { finalText: " \nEdited exactly.\n " } : {}) };
      const request = { ownerScope: "local", simulationId: "sim", draftId: generated.draft.id, ...body };
      const target = `/simulations/sim/drafts/${generated.draft.id}/accept`;
      let expected: ReturnType<typeof acceptActorTurnDraft>; let result: any;
      if (first === "native") { result = await nativeRequest(target, body, database); expected = acceptActorTurnDraft(store, request); }
      else { expected = acceptActorTurnDraft(store, request); result = await nativeRequest(target, body, database); }
      assert.deepEqual(result, { branch: { id: expected.branch.id, headCommitId: expected.branch.headCommitId }, commit: { id: expected.commit.id }, replayed: first === "typescript" });
      assert.equal(expected.commit.events.find(event => event.type === "message_accepted")!.message.text, edited ? body.finalText : "  Generated wording.  ");
      const archive = store.exportSimulation("local", "sim"); validateSimulationArchive(archive);
      await nativeRequest(target, { ...body, finalText: "Different." }, database, 409);
      await nativeRequest(target, { commandId: "invalid", finalText: null }, database, 400);
      assert.deepEqual(store.exportSimulation("local", "sim"), archive);
      const importedDatabase = path.join(root, "import.sqlite"); const imported = await openBranchStore(importedDatabase).open();
      try { imported.importSimulation(archive); assert.equal(imported.getActorTurnDraft("local", "sim", generated.draft.id), null); }
      finally { imported.close(); }
      assert.deepEqual(await nativeRequest(target, body, importedDatabase), { ...result, replayed: true });
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
}
