import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { commitManualTurn, forkBranch, inspectActorContext, projectBranch, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { closeBranchEpisode, type EpisodeClosureGenerator } from "../src/core/branch-episode.ts";
import { correctTurnBody } from "../src/core/turn-correction.ts";
import { reviseMemory, retractMemory } from "../src/core/memory-operations.ts";
import { openBranchStore, type SqliteSimulationRepository } from "../src/store/branch-sqlite.ts";

const generator: EpisodeClosureGenerator = {
  writeMemory: ({ label, turns }) => label + ": " + turns.map(turn => turn.text).join(" "),
  writeLongTermMemory: ({ memory }) => memory.text,
  extractBeliefs: ({ memory }) => [{ strength: 1, propositionText: memory.text }],
};
async function check(database: string, store: SqliteSimulationRepository, branchId: string, head?: string) {
  const p = projectBranch(store, { ownerScope: "local", simulationId: "sim", branchId, ...(head ? { head } : {}) });
  const expected = {
    transcript: { branch: p.branch, transcript: p.transcript },
    audience: { branch: p.branch, audienceMembers: p.audience, activeAudience: p.audience.filter(a => a.status === "active").map(a => a.actorId) },
    access: { branch: p.branch, effectiveAccessLinks: p.accessLinks },
    beliefs: { branch: p.branch, beliefs: p.beliefs },
    memories: { branch: p.branch, memories: p.episodeMemories, longTermMemories: p.longTermMemories, operations: p.memoryOperations, perceptions: p.perceptions },
    branches: { branch: p.branch, branches: store.exportSimulation("local", "sim").branches },
  };
  for (const [kind, value] of Object.entries(expected)) {
    assert.deepEqual(await nativeRequest(`/simulations/sim/${kind}?branchId=${branchId}${head ? "&head=" + head : ""}`, undefined, database), value, `${kind} at ${branchId}/${head ?? "head"}`);
  }
  for (const actorId of ["ceo", "cfo", "student-team", "supplier-risk-brief"]) {
    const whispers = store.listPendingStageWhispers("local", "sim", branchId, p.branch.headCommitId, actorId);
    assert.deepEqual(await nativeRequest(`/simulations/sim/context/${actorId}?branchId=${branchId}${head ? "&head=" + head : ""}`, undefined, database),
      inspectActorContext(store, { ownerScope: "local", simulationId: "sim", branchId, actorId, stageWhispers: whispers, ...(head ? { head } : {}) }));
  }
}

for (const scoped of [false, true]) {
  test(`native branch projections preserve memory lineage, corrections and immutable perceptions (${scoped ? "scoped" : "legacy"})`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-replay-"));
    const database = path.join(root, "runtime.sqlite");
    const store = await openBranchStore(database).open();
    try {
      const base = { ownerScope: "local", simulationId: "sim", branchId: "main" };
      const started = await startBranchSimulation(store, { ...base, commandId: "start", workspacePath: path.resolve("examples/executive-interviews") });
      let sequence = 0;
      const play = (text: string) => commitManualTurn(store, { ...base, expectedHead: store.getBranch("local", "sim", "main")!.headCommitId,
        commandId: "turn-" + ++sequence, payload: { actorId: "ceo", text, audience: ["cfo", "student-team"],
          ...(scoped ? { audienceSyntax: "scoped-v1" as const, knowledgePolicy: "actor-knowledge-v1" as const } : {}),
          audienceChanges: [{ actorId: "cfo", action: "add" }, { actorId: "ceo", action: "add" }],
          accessChanges: [{ action: "revoke", member: "cfo", container: "ceo" }], stageWhisper: "Direction stays private." } });
      const close = (label: string) => closeBranchEpisode(store, { ...base, expectedHead: store.getBranch("local", "sim", "main")!.headCommitId,
        commandId: "closure-" + ++sequence, payload: { label } }, generator);
      await check(database, store, "main");
      const first = play(scoped ? "#CFO(private) Public opening." : "Opening.");
      await close("Earlier");
      const target = play(scoped ? "#CFO(original private) Public middle." : "Original middle.");
      await close("Affected");
      const memory = projectBranch(store, base).memoryOperations.findLast(m => m.memoryKind === "long_term")!;
      const review = { ...base, expectedHead: store.getBranch("local", "sim", "main")!.headCommitId, commandId: "review",
        payload: { actorId: memory.actorId, memoryId: memory.memoryId, revisesOperationId: memory.id, content: "Reviewed memory." } };
      const nativeReview = await nativeRequest("/simulations/sim/memories/revise", { ...review, ownerScope: undefined, payload: undefined, ...review.payload }, database);
      const reviewed = reviseMemory(store, review);
      assert.deepEqual(nativeReview, { ...reviewed, replayed: false });
      const retraction = { ...base, expectedHead: reviewed.commit.id, commandId: "retract",
        payload: { actorId: memory.actorId, memoryId: memory.memoryId, retractsOperationId: reviewed.commit.events.find(e => e.type === "memory_operation")!.operation.id } };
      const nativeRetraction = await nativeRequest("/simulations/sim/memories/retract", { ...retraction, ownerScope: undefined, payload: undefined, ...retraction.payload }, database);
      assert.deepEqual(nativeRetraction, { ...retractMemory(store, retraction), replayed: false });
      play("Continuation.");
      const last = await close("Later");
      await check(database, store, "main");
      await check(database, store, "main", first.commit.id);
      const version = target.commit.events.find(e => e.type === "message_accepted")!.message.id;
      const correction = { ownerScope: "local", simulationId: "sim", sourceBranchId: "main", expectedHead: last.commit.id,
        commandId: "correct", payload: { messageVersionId: version, text: scoped ? "#CFO(corrected private) Public middle." : "Corrected middle." } };
      const nativeCorrection = await nativeRequest("/simulations/sim/correct-turn-body", { sourceBranchId: "main", expectedHead: last.commit.id, commandId: "correct", ...correction.payload }, database);
      const corrected = correctTurnBody(store, correction);
      assert.deepEqual(nativeCorrection, { ...corrected, replayed: false });
      await check(database, store, corrected.branch.id);
      const nativeFork = await nativeRequest("/simulations/sim/fork", { branchId: corrected.branch.id, expectedHead: corrected.commit.id, commandId: "fork", newBranchId: "inherited", atCommitId: last.commit.id }, database);
      const forked = forkBranch(store, { ownerScope: "local", simulationId: "sim", sourceBranchId: corrected.branch.id, expectedHead: corrected.commit.id,
        commandId: "fork", branchId: "inherited", atCommitId: last.commit.id, name: null });
      assert.deepEqual(nativeFork, { ...forked, replayed: false });
      await check(database, store, "inherited");
      await nativeRequest(`/simulations/sim/transcript?branchId=inherited&head=${corrected.commit.id}`, undefined, database, 400);
      await nativeRequest("/simulations/absent/transcript", undefined, database, 404);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
}
