import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { NativeModelHost } from "../src/agent-runtime/native-host.ts";
import { commitManualTurn, forkBranch, inspectActorContext, projectBranch, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { requestEpisodeClosure } from "../src/core/branch-episode.ts";
import { SceneHeadingStore } from "../src/store/scene-headings.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import type { ActorTurnRuntime } from "../src/agent-runtime/contracts.ts";

for (const first of ["native", "typescript"]) {
  test(`native Stage and scene annotations preserve metadata isolation and path inheritance (${first} first)`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-stage-")); const database = path.join(root, "story.sqlite"); const headingsDatabase = path.join(root, "headings.sqlite");
    const store = await openBranchStore(database).open(); const headings = new SceneHeadingStore(headingsDatabase);
    let modelCalls = 0;
    const runtime: ActorTurnRuntime = { identity: { id: "stage-model", version: "v1", providerId: "sk-private-secret", modelId: "model" }, async *runActorTurn() { modelCalls++; throw new Error("Stage reads must not generate."); } };
    const host = new NativeModelHost({ actorConfigurations: [{ characterId: "ceo", key: "one", label: "Selected model", profile: { id: "configured", version: "v1" }, runtime }] });
    const callbacks = { "host.features": () => ({ sceneHeadingsDatabase: headingsDatabase }),
      "model.catalog": (params: Record<string, unknown>) => host.call("model.catalog", params, new AbortController().signal),
      "model.status": async () => ({ ...await host.call("model.status", {}, new AbortController().signal) as object, diagnostic: "Configured in DSH." }) };
    try {
      const base = { ownerScope: "local", simulationId: "sim", branchId: "main" };
      const started = await startBranchSimulation(store, { ...base, commandId: "start", workspacePath: path.resolve("examples/executive-interviews"), scenarioId: "executive-interviews" });
      const context = inspectActorContext(store, { ...base, actorId: "ceo" }); const archive = store.exportSimulation("local", "sim");
      const command = { ...base, commandId: "scene-first", expectedHead: started.root.id }; const title = "  Meeting — dusk  "; const body = { branchId: "main", commandId: command.commandId, expectedHead: command.expectedHead, title };
      let expected; let result;
      if (first === "native") { result = await nativeRequest("/simulations/sim/scene-headings", body, database, 200, callbacks); expected = headings.create(store, command, title); }
      else { expected = headings.create(store, command, title); result = await nativeRequest("/simulations/sim/scene-headings", body, database, 200, callbacks); }
      assert.deepEqual(result, { heading: expected }); assert.deepEqual(store.exportSimulation("local", "sim"), archive);
      assert.deepEqual(inspectActorContext(store, { ...base, actorId: "ceo" }), context);
      const stage = await nativeRequest("/simulations/sim/stage", undefined, database, 200, callbacks);
      assert.equal(stage.scenarioName, "Executive Interviews"); assert.deepEqual(stage.branch, started.branch); assert.deepEqual(stage.transcript, []);
      assert.deepEqual(stage.sceneHeadings, headings.list(store, base)); assert.deepEqual(stage.generationActorIds, ["ceo"]);
      assert.deepEqual(stage.actorConfigurations, [{ characterId: "ceo", key: "one", label: "Selected model", profile: { id: "configured", version: "v1" } }]);
      assert.ok(!stage.actors.some((actor: { id: string }) => actor.id === "supplier-risk-brief")); assert.equal(modelCalls, 0);
      const turn = commitManualTurn(store, { ...base, commandId: "turn", expectedHead: started.root.id, payload: { actorId: "ceo", text: "A private occurrence.", audience: ["cfo"], stageWhisperIds: [], knowledgePolicy: "actor-knowledge-v1" } });
      const closed = requestEpisodeClosure(store, { ...base, commandId: "close", expectedHead: turn.commit.id, payload: { label: "Meeting" } });
      assert.deepEqual(await nativeRequest("/simulations/sim/scene-headings", body, database, 200, callbacks), result);
      await nativeRequest("/simulations/sim/scene-headings", { ...body, title: "Different" }, database, 409, callbacks);
      const later = await nativeRequest("/simulations/sim/stage", undefined, database, 200, callbacks);
      assert.deepEqual(later.sceneHeadings, headings.list(store, base)); assert.deepEqual(later.episodes, [{ id: closed.job.episodeId, label: "Meeting" }]);
      const fork = forkBranch(store, { ...base, sourceBranchId: "main", expectedHead: closed.commit.id, atCommitId: turn.commit.id, commandId: "fork", branchId: "other", name: "Other" });
      await nativeRequest("/simulations/sim/scene-headings", { branchId: "other", expectedHead: fork.branch.headCommitId, commandId: "scene-other", title: "Another opening" }, database, 200, callbacks);
      assert.deepEqual((await nativeRequest("/simulations/sim/stage?branchId=other", undefined, database, 200, callbacks)).sceneHeadings, headings.list(store, { ...base, branchId: "other" }));
      assert.deepEqual((await nativeRequest("/simulations/sim/stage", undefined, database, 200, callbacks)).sceneHeadings, headings.list(store, base));
      const noFeatures = { "host.features": () => ({ sceneHeadingsDatabase: null }), "model.catalog": () => ({ generationActorIds: [], actorConfigurations: [] }) };
      const plain = await nativeRequest("/simulations/sim/stage", undefined, database, 200, noFeatures);
      assert.ok(!Object.hasOwn(plain, "sceneHeadings")); assert.deepEqual(plain.actorConfigurations, []);
      assert.deepEqual(plain.transcript, projectBranch(store, base).transcript);
      await nativeRequest("/simulations/sim/turn-draft", {}, database, 410);
      const status = await nativeRequest("/runtime", undefined, database, 200, callbacks);
      assert.equal(status.configured, true); assert.equal(status.provider, null); assert.equal(status.diagnostic, "Configured in DSH."); assert.equal(modelCalls, 0);
    } finally { host.close(); headings.close(); store.close(); await rm(root, { recursive: true, force: true }); }
  });
}
