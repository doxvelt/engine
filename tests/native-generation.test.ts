import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { acceptActorTurnDraft } from "../src/core/draft-lifecycle.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import type { RunActorTurnRequest } from "../src/agent-runtime/contracts.ts";

test("native generation, preserved revision and frozen retry use only provider callbacks and interoperate on acceptance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-generation-"));
  const database = path.join(root, "story.sqlite");
  try {
    const started = await nativeRequest("/simulations/start", { simulationId: "sim", branchId: "main", commandId: "start", workspacePath: path.resolve("examples/last-crossing") }, database);
    const requests: RunActorTurnRequest[] = [];
    let cursor = 0;
    const wording = JSON.stringify({ text: "A candidate.", audience: ["corin", "mara"] });
    const events = [{ type: "usage", usage: { inputTokens: 3 } }, { type: "text_delta", text: wording },
      { type: "completed", text: wording, usage: { outputTokens: 2, totalTokens: 5 }, stopReason: "stop" }];
    const callbacks = {
      "model.describe": () => ({ configured: true, profile: { id: "local-character", version: "v1" }, memoryEnabled: false }),
      "model.open": (params: Record<string, unknown>) => {
        requests.push(params.request as RunActorTurnRequest); cursor = 0;
        return { streamId: "stream", identity: { id: "native-test", version: "v1", providerId: "provider", modelId: "model" } };
      },
      "model.next": () => cursor < events.length ? { done: false, event: events[cursor++] } : { done: true },
      "model.close": () => ({}),
    };
    const body = { branchId: "main", expectedHead: started.root.id, commandId: "generate", actorId: "corin", audience: ["mara"], stageWhisperIds: [],
      draftingPolicy: "actor-knowledge-v1", completeWhisper: "Speak only to Mara." };
    const generated = await nativeRequest("/simulations/sim/drafts", body, database, 200, callbacks);
    assert.equal(generated.draft.status, "ready"); assert.equal(generated.draft.artifact.text, "A candidate.");
    assert.deepEqual(requests[0]!.capabilityGrant, []);
    assert.deepEqual(await nativeRequest("/simulations/sim/drafts", body, database, 200, callbacks), { ...generated, replayed: true });
    assert.equal(requests.length, 1, "Exact replay never invokes a model");
    const retry = await nativeRequest(`/simulations/sim/drafts/${generated.draft.id}/retry`, { commandId: "retry" }, database, 200, callbacks);
    assert.equal(retry.draft.status, "ready"); assert.equal(requests[1]!.contextHash, requests[0]!.contextHash); assert.equal(requests[1]!.promptHash, requests[0]!.promptHash);
    const preserved = await nativeRequest(`/simulations/sim/drafts/${generated.draft.id}/revise`, { commandId: "preserve", audience: ["mara"],
      completeWhisper: body.completeWhisper, draftingPolicy: "actor-knowledge-v1", preservedText: "Director wording." }, database, 200, callbacks);
    assert.equal(preserved.draft.artifact.text, "Director wording."); assert.equal(preserved.draft.artifact.provenance.adapter.id, "director-preserved");
    assert.equal(requests.length, 2, "Explicit preservation never invokes a model");
    const nativeAccepted = await nativeRequest(`/simulations/sim/drafts/${retry.draft.id}/accept`, { commandId: "accept" }, database);
    assert.equal(nativeAccepted.replayed, false);
    const store = await openBranchStore(database).open();
    try {
      const accepted = acceptActorTurnDraft(store, { ownerScope: "local", simulationId: "sim", draftId: retry.draft.id, commandId: "accept" });
      assert.equal(accepted.replayed, true); assert.equal(accepted.commit.id, nativeAccepted.commit.id);
      assert.equal(accepted.commit.parentCommitId, started.root.id);
      validateSimulationArchive(store.exportSimulation("local", "sim"));
    } finally { store.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const invalid of ["tool", "usage", "audience"] as const) {
  test(`native generation contains invalid ${invalid} output without committing effects`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-invalid-")); const database = path.join(root, "story.sqlite");
    try {
      const started = await nativeRequest("/simulations/start", { simulationId: "sim", branchId: "main", commandId: "start", workspacePath: path.resolve("examples/last-crossing") }, database);
      const events = invalid === "tool" ? [{ type: "tool_requested", name: "shell" }] : invalid === "usage"
        ? [{ type: "usage", usage: { inputTokens: 3 } }, { type: "completed", text: "Words.", usage: { inputTokens: 4 } }]
        : [{ type: "completed", text: JSON.stringify({ text: "Wrong recipients.", audience: ["corin", "nell"] }) }];
      let cursor = 0;
      const callbacks = { "model.describe": () => ({ configured: true, profile: { id: "local-character", version: "v1" } }),
        "model.open": () => ({ streamId: "stream", identity: { id: "native-test", version: "v1" } }),
        "model.next": () => cursor < events.length ? { done: false, event: events[cursor++] } : { done: true }, "model.close": () => ({}) };
      const result = await nativeRequest("/simulations/sim/drafts", { branchId: "main", expectedHead: started.root.id, commandId: "generate", actorId: "corin", audience: ["mara"],
        fixedAudience: true, stageWhisperIds: [], draftingPolicy: "actor-knowledge-v1", completeWhisper: "Only Mara." }, database, 200, callbacks);
      assert.equal(result.draft.status, "failed"); assert.equal(result.draft.failure.code, invalid === "audience" ? "output_contract" : "invalid_stream");
      const transcript = await nativeRequest("/simulations/sim/transcript", undefined, database);
      assert.deepEqual(transcript.transcript, []); assert.equal(transcript.branch.headCommitId, started.root.id);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
