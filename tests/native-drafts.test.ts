import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";
import { startBranchSimulation } from "../src/core/branch-kernel.ts";
import { discardActorTurnDraft, generateActorTurnDraft } from "../src/core/draft-lifecycle.ts";
import { stageDraft } from "../src/local-api/stage-contracts.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import type { GenerateActorTurnDraftCommand } from "../src/core/ports.ts";

for (const version of [1, 2, 3] as const) {
  test(`native candidate recovery validates routed ancestry and interoperates on discard (v${version})`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-draft-"));
    const database = path.join(root, "story.sqlite");
    const store = await openBranchStore(database).open();
    try {
      const base = { ownerScope: "local", simulationId: "sim", branchId: "main" };
      const started = await startBranchSimulation(store, { ...base, commandId: "start", workspacePath: path.resolve("examples/last-crossing") });
      const command: GenerateActorTurnDraftCommand = { ...base, expectedHead: started.root.id, commandId: "generate", payload: {
        actorId: "corin", audience: ["mara"], stageWhisperIds: [], runtimeProfile: { id: "character", version: "v1" },
        promptPolicy: { id: version === 3 ? "actor-knowledge-v1" : "audience-proposal-v1", version: "v1" },
        outputSchema: { id: "audience-proposal", digest: "v1" }, skillDigests: [],
        routing: { version, initialAudience: ["mara"], correctedAudience: null, preservedText: null, sourceDraftId: null, correction: "",
          ...(version === 1 ? {} : { completeWhisper: "Speak to Mara." }) },
      } };
      const runtime = (audience: string[]) => new DeterministicFakeRuntime([{ type: "completed", text: JSON.stringify({ text: "Words.", audience }), stopReason: "stop" }]);
      const first = await generateActorTurnDraft(store, runtime(["corin", "mara"]), command);
      assert.equal(first.draft.status, "ready");
      const revised = await generateActorTurnDraft(store, runtime(["corin", "nell"]), { ...command, commandId: "revise", payload: { ...command.payload, audience: ["nell"],
        routing: { ...command.payload.routing!, sourceDraftId: first.draft.id, correctedAudience: ["nell"],
          correction: version === 1 ? "Use only Nell." : "", ...(version === 1 ? {} : { completeWhisper: "Speak only to Nell." }) } } });
      assert.equal(revised.draft.status, "ready");
      for (const draft of [first.draft, revised.draft]) {
        assert.deepEqual(await nativeRequest(`/simulations/sim/drafts/${draft.id}`, undefined, database), stageDraft(draft));
      }
      assert.deepEqual(await nativeRequest("/simulations/sim/drafts?branchId=main", undefined, database),
        { drafts: store.listRecoverableActorTurnDrafts("local", "sim", "main").map(stageDraft) });
      const body = { commandId: "discard" };
      const native = await nativeRequest(`/simulations/sim/drafts/${revised.draft.id}/discard`, body, database);
      const old = discardActorTurnDraft(store, { ownerScope: "local", simulationId: "sim", draftId: revised.draft.id, commandId: "discard" });
      assert.deepEqual(native, { draft: stageDraft(old.draft), replayed: false });
      assert.deepEqual(await nativeRequest(`/simulations/sim/drafts/${revised.draft.id}/discard`, body, database), { ...native, replayed: true });
      assert.deepEqual(await nativeRequest("/simulations/sim/drafts?branchId=main", undefined, database), { drafts: [stageDraft(first.draft)] });
      assert.equal(store.getBranch("local", "sim", "main")!.headCommitId, started.root.id);
      assert.equal("context" in native.draft, false); assert.equal("prompt" in native.draft, false);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
}
