import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compileWorkspace } from "../src/core/compiler.ts";
import { commitManualTurn, forkBranch, inspectActorContext, projectBranch, startBranchSimulationFromCompiled } from "../src/core/branch-kernel.ts";
import { closeBranchEpisode, requestEpisodeClosure, runEpisodeMemoryJob, type EpisodeClosureGenerator } from "../src/core/branch-episode.ts";
import { correctTurnBody } from "../src/core/turn-correction.ts";
import { reviseMemory } from "../src/core/memory-operations.ts";
import { openBranchStore, validateSimulationArchive } from "../src/store/branch-sqlite.ts";
import { completedArchiveAsSchemaV4 } from "./archive-test-helpers.ts";

const generator: EpisodeClosureGenerator = {
  writeMemory({ label, turns }) { return label + ":MEMORY:" + turns.map(turn => turn.text).join(" "); },
  writeLongTermMemory({ memory }) { return memory.text; },
  extractBeliefs({ memory }) { return [{ strength: 1, propositionText: memory.text }]; },
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "doxvelt-body-corrections-"));
  const store = await openBranchStore(path.join(root, "story.sqlite")).open();
  const compiled = await compileWorkspace(path.resolve("examples/executive-interviews"));
  compiled.beliefs = [];
  compiled.accessLinks = [];
  const base = { ownerScope: "owner", simulationId: "sim", branchId: "main" };
  const started = startBranchSimulationFromCompiled(store, { ...base, compiled, commandId: "start", scenarioId: "executive-interviews" });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  let sequence = 0;
  function play(text: string, branchId = "main") {
    const expectedHead = store.getBranch(base.ownerScope, base.simulationId, branchId)!.headCommitId;
    return commitManualTurn(store, { ...base, branchId, expectedHead, commandId: "turn-" + ++sequence,
      payload: { actorId: "ceo", audience: [], text, knowledgePolicy: "actor-knowledge-v1" } });
  }
  async function close(label: string, branchId = "main") {
    const expectedHead = store.getBranch(base.ownerScope, base.simulationId, branchId)!.headCommitId;
    return closeBranchEpisode(store, { ...base, branchId, expectedHead, commandId: "close-" + ++sequence,
      payload: { label } }, generator);
  }
  function correct(messageVersionId: string, text: string) {
    const expectedHead = store.getBranch(base.ownerScope, base.simulationId, "main")!.headCommitId;
    return correctTurnBody(store, { ownerScope: base.ownerScope, simulationId: base.simulationId,
      sourceBranchId: "main", expectedHead, commandId: "correction-" + ++sequence, payload: { messageVersionId, text } });
  }
  return { root, store, base, started, play, close, correct };
}

test("closed-episode body correction preserves later turns and withholds stale closure derivatives only on the revised path", async t => {
  const f = await fixture(t);
  f.play("Unchanged beginning.");
  const earlier = await f.close("EARLIER");
  const target = f.play("ORIGINAL-WORDING");
  const sourceMessage = target.commit.events.find(event => event.type === "message_accepted")!;
  if (sourceMessage.type !== "message_accepted") throw new Error("Missing message");
  await f.close("STALE-TARGET");
  const targetMemory = projectBranch(f.store, f.base).memoryOperations.find(operation => operation.memoryKind === "long_term" &&
    operation.type !== "retracted" && operation.content.includes("STALE-TARGET"))!;
  const revision = reviseMemory(f.store, { ...f.base,
    expectedHead: f.store.getBranch("owner", "sim", "main")!.headCommitId, commandId: "review-memory",
    payload: { actorId: "ceo", memoryId: targetMemory.memoryId, revisesOperationId: targetMemory.id, content: "STALE-REVIEWED-MEMORY" } });
  f.play("Sequel dialogue remains.");
  const later = await f.close("STALE-SEQUEL");
  f.play("Unclosed continuation remains.");
  const original = projectBranch(f.store, f.base);
  const sourceArchive = f.store.exportSimulation("owner", "sim");
  const saved = f.correct(sourceMessage.message.id, "CORRECTED-WORDING");
  const query = { ...f.base, branchId: saved.branch.id };
  const revised = projectBranch(f.store, query);
  assert.deepEqual(revised.transcript.map(turn => turn.text),
    ["Unchanged beginning.", "CORRECTED-WORDING", "Sequel dialogue remains.", "Unclosed continuation remains."]);
  assert.equal(revised.episodeClosures.length, original.episodeClosures.length);
  assert.deepEqual(revised.episodeClosures[0], original.episodeClosures[0]);
  for (const closure of revised.episodeClosures.slice(1)) {
    assert.deepEqual(closure.memories, []);
    assert.deepEqual(closure.longTermMemories, []);
    assert.deepEqual(closure.extractedBeliefs, []);
    assert.deepEqual(closure.memoryOperations, []);
  }
  assert.ok(revised.episodeMemories.length > 0);
  assert.ok(revised.episodeMemories.every(memory => memory.episodeId === earlier.closure.episode.id));
  assert.doesNotMatch(JSON.stringify([revised.memoryOperations, revised.longTermMemories, revised.beliefs]),
    /STALE-TARGET|STALE-SEQUEL|STALE-REVIEWED-MEMORY|ORIGINAL-WORDING/);
  assert.doesNotMatch(inspectActorContext(f.store, { ...query, actorId: "ceo" }).promptPreview,
    /STALE-TARGET|STALE-SEQUEL|STALE-REVIEWED-MEMORY|ORIGINAL-WORDING/);
  assert.deepEqual(projectBranch(f.store, f.base), original);
  assert.ok(f.store.getCommit("owner", "sim", revision.commit.id));

  // A descendant that branches before the correction event inherits the same revised source.
  const fork = forkBranch(f.store, { ownerScope: "owner", simulationId: "sim", sourceBranchId: query.branchId,
    expectedHead: saved.commit.id, atCommitId: later.commit.id, branchId: "descendant", commandId: "fork-revised" });
  assert.equal(projectBranch(f.store, { ...query, branchId: fork.branch.id }).transcript[1]!.text, "CORRECTED-WORDING");
  assert.doesNotMatch(JSON.stringify(projectBranch(f.store, { ...query, branchId: fork.branch.id }).longTermMemories), /STALE/);

  // A later deliberate closure can form fresh memory from the corrected path.
  const fresh = await f.close("FRESH", query.branchId);
  const current = projectBranch(f.store, query);
  assert.ok(current.longTermMemories.some(memory => memory.episodeId === fresh.closure.episode.id));
  assert.doesNotMatch(JSON.stringify(current.longTermMemories), /STALE/);
  const archive = f.store.exportSimulation("owner", "sim");
  validateSimulationArchive(archive);
  const imported = await openBranchStore(path.join(f.root, "import.sqlite")).open();
  try {
    imported.importSimulation(archive);
    assert.deepEqual(projectBranch(imported, query), current);
    assert.deepEqual(projectBranch(imported, f.base), original);
  } finally { imported.close(); }
  const legacy = completedArchiveAsSchemaV4(sourceArchive);
  validateSimulationArchive(legacy);
  const importedLegacy = await openBranchStore(path.join(f.root, "legacy.sqlite")).open();
  try {
    importedLegacy.importSimulation(legacy);
    const legacyCorrection = correctTurnBody(importedLegacy, { ownerScope: "owner", simulationId: "sim", sourceBranchId: "main",
      expectedHead: original.head.id, commandId: saved.commit.commandId!, payload: { messageVersionId: sourceMessage.message.id, text: "CORRECTED-WORDING" } });
    assert.deepEqual(projectBranch(importedLegacy, { ...query, branchId: legacyCorrection.branch.id }).longTermMemories, revised.longTermMemories);
    assert.deepEqual(projectBranch(importedLegacy, f.base).longTermMemories, original.longTermMemories);
    await closeBranchEpisode(importedLegacy, { ...query, branchId: legacyCorrection.branch.id, expectedHead: legacyCorrection.commit.id,
      commandId: "close-legacy-fresh", payload: { label: "LEGACY-FRESH" } }, generator);
    validateSimulationArchive(importedLegacy.exportSimulation("owner", "sim"));
  } finally { importedLegacy.close(); }
});

test("correcting an open episode keeps previously closed memory eligible", async t => {
  const f = await fixture(t);
  f.play("Earlier experience.");
  await f.close("EARLIER");
  const target = f.play("Original open turn.");
  const message = target.commit.events.find(event => event.type === "message_accepted")!;
  if (message.type !== "message_accepted") throw new Error("Missing message");
  const original = projectBranch(f.store, f.base);
  const saved = f.correct(message.message.id, "Corrected open turn.");
  const revised = projectBranch(f.store, { ...f.base, branchId: saved.branch.id });
  assert.deepEqual(revised.longTermMemories, original.longTermMemories);
  assert.deepEqual(revised.episodeClosures, original.episodeClosures);
  assert.equal(revised.transcript.at(-1)!.text, "Corrected open turn.");
});

test("a closure job completing after correction cannot restore stale memory on the revised path", async t => {
  const f = await fixture(t);
  const turn = f.play("ORIGINAL-WORDING");
  const message = turn.commit.events.find(event => event.type === "message_accepted")!;
  if (message.type !== "message_accepted") throw new Error("Missing message");
  const pending = requestEpisodeClosure(f.store, { ...f.base, expectedHead: turn.commit.id,
    commandId: "pending", payload: { label: "STALE" } });
  const corrected = f.correct(message.message.id, "CORRECTED-WORDING");
  await runEpisodeMemoryJob(f.store, { ownerScope: "owner", simulationId: "sim", jobId: pending.job.id }, generator);
  assert.match(JSON.stringify(projectBranch(f.store, f.base).longTermMemories), /ORIGINAL-WORDING/);
  const revised = projectBranch(f.store, { ...f.base, branchId: corrected.branch.id });
  assert.deepEqual(revised.longTermMemories, []);
  assert.deepEqual(revised.memoryOperations, []);
  assert.deepEqual(revised.episodeClosures[0]!.memories, []);
  validateSimulationArchive(f.store.exportSimulation("owner", "sim"));
});
