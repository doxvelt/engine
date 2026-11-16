import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalApiServer } from "../src/local-api/server.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import type { ActorTurnRuntime } from "../src/agent-runtime/contracts.ts";
import { EpisodeMemory } from "../src/memory/episodes.ts";

test("native generation abort settles a cancellable candidate without consuming direction or committing a turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-abort-")); const database = path.join(root, "story.sqlite");
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const runtime: ActorTurnRuntime = { identity: { id: "abort-test", version: "v1" }, async *runActorTurn(_request, signal) {
    yield { type: "usage", usage: { inputTokens: 2 } };
    started();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("Private provider abort")), { once: true }));
  } };
  const memory = new EpisodeMemory({directory:path.join(root,"memory"),executable:"unused",modelKey:"unused",reflect:async()=>{throw new Error("No reflection expected");}});
  const server = createLocalApiServer({ dbPath: database, actorTurnRuntime: runtime, episodeMemory: memory });
  const request = (target: string, body: unknown) => new Promise<{ status: number; body: any }>(resolve => {
    const incoming = new IncomingMessage(new Socket()); incoming.method = "POST"; incoming.url = target; incoming.headers = { "content-type": "application/json" };
    incoming.push(JSON.stringify(body)); incoming.push(null);
    const response = new ServerResponse(incoming);
    response.end = ((text: string) => { resolve({ status: response.statusCode, body: JSON.parse(text) }); return response; }) as typeof response.end;
    server.emit("request", incoming, response);
  });
  try {
    const start = await request("/simulations/start", { simulationId: "sim", branchId: "main", commandId: "start", workspacePath: path.resolve("examples/last-crossing") });
    assert.equal(start.status, 200); const head = start.body.root.id as string;
    const whisper = await request("/simulations/sim/whispers", { branchId: "main", expectedHead: head, commandId: "whisper", targetActorId: "corin", text: "Private direction." });
    const generation = request("/simulations/sim/drafts", { branchId: "main", expectedHead: head, commandId: "generate", actorId: "corin", audience: ["mara"],
      stageWhisperIds: [whisper.body.id], draftingPolicy: "actor-knowledge-v1", completeWhisper: "Speak to Mara." });
    await running; server.closeAllConnections();
    assert.equal((await generation).status, 503);
    const store = await openBranchStore(database).open();
    try {
      let draft = store.listRecoverableActorTurnDrafts("local", "sim", "main")[0]!;
      for (let i = 0; i < 150 && draft.status === "generating"; i++) {
        await new Promise(resolve => setTimeout(resolve, 10)); draft = store.getActorTurnDraft("local", "sim", draft.id)!;
      }
      assert.equal(draft.status, "failed"); assert.equal(draft.failure!.code, "runtime_failure");
      assert.equal(draft.failure!.provenance.stopReason, "aborted"); assert.equal(draft.failure!.provenance.usage.inputTokens, 2);
      assert.equal(store.getBranch("local", "sim", "main")!.headCommitId, head);
      assert.deepEqual(store.listPendingStageWhispers("local", "sim", "main", head, "corin").map(w => w.id), [whisper.body.id]);
      assert.equal(store.listAncestors("local", "sim", head).length, 1);
    } finally { store.close(); }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); memory.close(); await rm(root, { recursive: true, force: true }); }
});

for (const phase of ["provider"]) {
  test(`native historical cancellation during ${phase} preserves the source path and allows a frozen retry`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-history-abort-")); const database = path.join(root, "story.sqlite");
    let started!: () => void; const running = new Promise<void>(resolve => { started = resolve; }); let retrying = false;
    const runtime: ActorTurnRuntime = { identity: { id: "history-abort-test", version: "v1" }, async *runActorTurn(_request, signal) {
      if (retrying) { yield { type: "completed", text: JSON.stringify({ text: "Retried replacement.", audience: ["corin"] }), stopReason: "stop" }; return; }
      yield { type: "usage", usage: { inputTokens: 2 } }; started();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("PRIVATE PROVIDER ABORT")), { once: true }));
    } };
    const server = createLocalApiServer({ dbPath: database, actorTurnRuntime: runtime });
    const request = (target: string, body: unknown) => new Promise<{ status: number; body: any }>(resolve => {
      const incoming = new IncomingMessage(new Socket()); incoming.method = "POST"; incoming.url = target; incoming.headers = { "content-type": "application/json" };
      incoming.push(JSON.stringify(body)); incoming.push(null); const response = new ServerResponse(incoming);
      response.end = ((text: string) => { resolve({ status: response.statusCode, body: JSON.parse(text) }); return response; }) as typeof response.end;
      server.emit("request", incoming, response);
    });
    try {
      const start = await request("/simulations/start", { simulationId: "sim", branchId: "main", commandId: "start", workspacePath: path.resolve("examples/last-crossing") });
      assert.equal(start.status, 200);
      const performed = await request("/simulations/sim/turns", { branchId: "main", expectedHead: start.body.root.id, commandId: "turn", actorId: "corin", manualText: "Original occurrence.", audience: ["corin"], stageWhisperIds: [], knowledgePolicy: "actor-knowledge-v1" });
      assert.equal(performed.status, 200); const head = performed.body.commit.id;
      const whisper = await request("/simulations/sim/whispers", { branchId: "main", expectedHead: head, commandId: "pending", targetActorId: "corin", text: "Unrelated pending direction." });
      const reader = await openBranchStore(database).open(); let before;
      try { before = reader.exportSimulation("local", "sim"); } finally { reader.close(); }
      const generation = request("/simulations/sim/alternatives", { sourceBranchId: "main", expectedHead: head, sourceCommitId: head, messageVersionId: performed.body.turn.messageVersionId,
        logicalMessageId: performed.body.turn.logicalMessageId, actorId: "corin", commandId: "alternative", action: "generate", audience: ["corin"], completeWhisper: "Replace this turn only." });
      await running; server.closeAllConnections(); assert.equal((await generation).status, 503);
      const store = await openBranchStore(database).open(); let operation;
      try {
        for (let i = 0; i < 150; i++) {
          operation = store.listAlternatives("local", "sim")[0];
          if (operation?.status === "failed") break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(operation!.status, "failed"); assert.equal(operation!.failure, phase === "provider" ? "generation_failed" : "validation_failed");
        if (phase === "provider") {
          assert.equal(operation!.draft!.failure!.provenance.stopReason, "aborted");
          assert.equal(operation!.draft!.failure!.provenance.usage.inputTokens, 2);
        } else assert.equal(operation!.draft, null);
        assert.deepEqual(store.exportSimulation("local", "sim"), before);
        assert.deepEqual(store.listPendingStageWhispers("local", "sim", "main", head, "corin").map(w => w.id), [whisper.body.id]);
      } finally { store.close(); }
      retrying = true;
      const retried = await request(`/simulations/sim/alternatives/${operation!.id}/retry`, { commandId: "retry" });
      assert.equal(retried.status, 200); assert.equal(retried.body.operation.status, "saved");
      const reopened = await openBranchStore(database).open();
      try {
        assert.equal(reopened.getBranch("local", "sim", "main")!.headCommitId, head);
        if (phase === "provider") {
          const saved = reopened.getAlternative("local", "sim", retried.body.operation.id)!;
          assert.equal(saved.draft!.promptHash, operation!.draft!.promptHash); assert.equal(saved.draft!.contextHash, operation!.draft!.contextHash);
        }
      } finally { reopened.close(); }
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); }
  });
}
