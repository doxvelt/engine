import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { compileWorkspace } from "../src/core/compiler.ts";
import { startBranchSimulationFromCompiled, commitManualTurn, projectBranch, stageWhisper, commitRuntimeEffects } from "../src/core/branch-kernel.ts";
import { acceptActorTurnDraft, generateActorTurnDraft } from "../src/core/draft-lifecycle.ts";
import { closeBranchEpisode } from "../src/core/branch-episode.ts";
import { createSavedAlternative, discoverSavedAlternatives, originatingInput, type AlternativeRequest } from "../src/core/saved-alternatives.ts";
import { openBranchStore, validateSimulationArchive } from "../src/store/branch-sqlite.ts";
import { fingerprintCommand } from "../src/core/domain-rules.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";
import type { ActorTurnRuntime, RunActorTurnRequest } from "../src/agent-runtime/contracts.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "saved-alternatives-"));
  const db = path.join(root, "db.sqlite");
  const store = await openBranchStore(db).open();
  const compiled = await compileWorkspace(path.resolve("examples/executive-interviews"));
  compiled.beliefs = []; compiled.accessLinks = [];
  for (const asset of [...compiled.worlds, ...compiled.scenarios]) asset.body = "A meeting.";
  const started = startBranchSimulationFromCompiled(store, { ownerScope: "owner", simulationId: "sim", branchId: "main", commandId: "start", scenarioId: "executive-interviews", compiled });
  t.after(async () => { store.close(); await rm(root, { force: true, recursive: true }); });
  const base = { ownerScope: "owner", simulationId: "sim", branchId: "main" };
  const original = commitManualTurn(store, { ...base, expectedHead: started.root.id, commandId: "original",
    payload: { actorId: "ceo", text: "OLD-SELECTED-PROSE", audience: ["ceo", "cfo"], stageWhisper: "OLD-WHISPER-ELEPHANT" } });
  const message = original.commit.events.find(e => e.type === "message_accepted")!;
  if (message.type !== "message_accepted") throw new Error("Missing message");
  const request: AlternativeRequest = { ownerScope: "owner", simulationId: "sim", sourceBranchId: "main", expectedHead: original.commit.id,
    sourceCommitId: original.commit.id, messageVersionId: message.message.id, logicalMessageId: message.message.logicalMessageId,
    actorId: "ceo", commandId: "alternative", action: "generate", audience: ["ceo"], completeWhisper: "NEW-DIRECTION" };
  return { root, db, store, started, original, request, base };
}
const runtime = (text = "NEW-PROSE", audience = ["ceo"]) => new DeterministicFakeRuntime([{ type: "completed", text: JSON.stringify({ text, audience }), stopReason: "stop" }]);

test("historical first-turn generation saves atomically, subtracts input, preserves continuations and portable replay", async t => {
  const f = await fixture(t);
  const later = commitManualTurn(f.store, { ...f.base, expectedHead: f.original.commit.id, commandId: "later", payload: { actorId: "cfo", text: "LATER-UNRELATED", audience: ["ceo"] } });
  stageWhisper(f.store, { ...f.base, expectedHead: later.commit.id, commandId: "later-whisper", targetActorId: "ceo", text: "UNRELATED-PENDING" });
  const request = { ...f.request, expectedHead: later.commit.id };
  const requests: RunActorTurnRequest[] = [];
  const fake = new DeterministicFakeRuntime([{ type: "completed", text: JSON.stringify({ text: "NEW-PROSE", audience: ["ceo"] }), stopReason: "stop" }], r => requests.push(r));
  const saved = await createSavedAlternative(f.store, fake, request);
  assert.equal(saved.operation.status, "saved");
  assert.equal(requests.length, 1);
  const captured = JSON.stringify(requests[0]);
  for (const forbidden of ["OLD-SELECTED-PROSE", "OLD-WHISPER-ELEPHANT", "LATER-UNRELATED", "UNRELATED-PENDING", "Observed presence"])
    assert.ok(!captured.includes(forbidden), forbidden);
  assert.ok(captured.includes("NEW-DIRECTION"));
  assert.equal(requests[0]!.basisHeadCommitId, f.started.root.id);
  const branch = saved.operation.outcome!.branchId;
  const projection = projectBranch(f.store, { ...f.base, branchId: branch });
  assert.deepEqual(projection.transcript.map(x => x.text), ["NEW-PROSE"]);
  assert.equal(projection.firstImpressions.length, 0);
  assert.equal(f.store.getBranch("owner", "sim", "main")!.headCommitId, later.commit.id);
  const continuation = commitManualTurn(f.store, { ...f.base, branchId: branch, expectedHead: saved.operation.outcome!.commitId,
    commandId: "continuation", payload: { actorId: "ceo", text: "ALTERNATIVE-CONTINUATION", audience: ["ceo"], knowledgePolicy: "actor-knowledge-v1" } });
  const second = await createSavedAlternative(f.store, runtime("SECOND"), { ...request, commandId: "second", completeWhisper: "" });
  assert.equal(second.operation.status, "saved");
  const found = discoverSavedAlternatives(f.store, request);
  assert.equal(found.paths.length, 3);
  assert.equal(found.paths.find(p => p.branchId === branch)!.headCommitId, continuation.commit.id);
  commitManualTurn(f.store, { ...f.base, expectedHead: later.commit.id, commandId: "source-advance-before-replay",
    payload: { actorId: "ceo", text: "Main continued independently", audience: ["ceo"] } });
  const exported = f.store.exportSimulation("owner", "sim");
  validateSimulationArchive(exported);
  const imported = await openBranchStore(path.join(f.root, "import.sqlite")).open();
  t.after(() => imported.close()); imported.importSimulation(exported);
  const replay = await createSavedAlternative(imported, fake, request);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.operation.outcome, saved.operation.outcome);
  assert.equal(requests.length, 1);
  const alt = projection.transcript[0]!;
  const origin = originatingInput(imported, { ...request, sourceBranchId: branch, expectedHead: continuation.commit.id,
    sourceCommitId: alt.commitId!, messageVersionId: alt.messageVersionId! });
  assert.equal(origin.completeWhisper, "NEW-DIRECTION");
  await assert.rejects(createSavedAlternative(imported, fake, { ...request, completeWhisper: "changed" }), /identity/i);
});

test("selection, owner, effects, stale heads, request conflicts, manual attribution and rollback", async t => {
  const f = await fixture(t);
  for (const patch of [{ actorId: "cfo" }, { messageVersionId: "forged" }, { sourceCommitId: f.started.root.id }, { logicalMessageId: "forged" }, { ownerScope: "other" }])
    await assert.rejects(createSavedAlternative(f.store, runtime(), { ...f.request, ...patch }));
  assert.equal(f.store.listAlternatives("owner", "sim").length, 0);
  const db = new DatabaseSync(f.db);
  db.exec("CREATE TRIGGER fail_alternative BEFORE INSERT ON branches WHEN NEW.name = 'regenerate' BEGIN SELECT RAISE(ABORT, 'rollback probe'); END");
  const failed = await createSavedAlternative(f.store, runtime(), f.request);
  assert.equal(failed.operation.status, "failed");
  assert.equal(f.store.exportSimulation("owner", "sim").branches.length, 1);
  assert.equal(f.store.exportSimulation("owner", "sim").commits.length, 2);
  db.exec("DROP TRIGGER fail_alternative"); db.close();
  const retry = await createSavedAlternative(f.store, runtime(), { ...f.request, commandId: "retry", retryOf: failed.operation.id });
  assert.equal(retry.operation.status, "saved");
  const { completeWhisper: _whisper, ...manualRequest } = f.request;
  const manual = await createSavedAlternative(f.store, undefined, { ...manualRequest, commandId: "manual", action: "manual", manualText: "MANUAL" });
  assert.equal(manual.operation.status, "saved");
  const turn = f.store.getCommit("owner", "sim", manual.operation.outcome!.commitId)!;
  assert.deepEqual(turn.events[0]!.type === "message_accepted" && turn.events[0]!.message.provenance, { mode: "manual", operation: "edit" });
  assert.equal(turn.events.length, 1);
  validateSimulationArchive(f.store.exportSimulation("owner", "sim"));
  const effectful = commitManualTurn(f.store, { ...f.base, expectedHead: f.original.commit.id, commandId: "effectful", payload: { actorId: "ceo", text: "effect", audience: ["ceo"], audienceChanges: [{ actorId: "cfo", action: "deactivate" }] } });
  const message = effectful.commit.events.find(e => e.type === "message_accepted")!;
  assert.equal(message.type, "message_accepted");
  if (message.type !== "message_accepted") return;
  await assert.rejects(createSavedAlternative(f.store, runtime(), { ...f.request, commandId: "effect-replace", expectedHead: effectful.commit.id,
    sourceCommitId: effectful.commit.id, messageVersionId: message.message.id, logicalMessageId: message.message.logicalMessageId }), /unsupported/);
  await assert.rejects(createSavedAlternative(f.store, runtime(), { ...f.request, commandId: "stale" }), /head conflict/);
});

test("pending restart discovery, exact replay never reruns, discard defeats late provider, source advance prevents save", async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const slow: ActorTurnRuntime = { identity: { id: "deterministic", version: "v1" }, async *runActorTurn(_request: RunActorTurnRequest) {
    calls++; await gate; yield { type: "completed", text: JSON.stringify({ text: "late", audience: ["ceo"] }), stopReason: "stop" };
  } };
  const pending = createSavedAlternative(f.store, slow, f.request);
  const second = await openBranchStore(f.db).open(); t.after(() => second.close());
  const discovered = second.listAlternatives("owner", "sim");
  assert.equal(discovered[0]!.status, "pending");
  assert.equal((await createSavedAlternative(second, slow, f.request)).replayed, true);
  assert.equal(calls, 1);
  second.settleAlternative("owner", "sim", discovered[0]!.id, "discarded");
  release(); assert.equal((await pending).operation.status, "discarded");
  assert.equal(f.store.exportSimulation("owner", "sim").branches.length, 1);
  let proceed!: () => void;
  const gate2 = new Promise<void>(resolve => { proceed = resolve; });
  const advancing: ActorTurnRuntime = { identity: slow.identity, async *runActorTurn() {
    await gate2; yield { type: "completed", text: JSON.stringify({ text: "late2", audience: ["ceo"] }), stopReason: "stop" };
  } };
  const next = createSavedAlternative(f.store, advancing, { ...f.request, commandId: "advance" });
  commitRuntimeEffects(second, { ...f.base, commandId: "world-advance", expectedHead: f.original.commit.id, payload: { audienceChanges: [{ actorId: "cfo", action: "deactivate" }] } });
  proceed(); assert.equal((await next).operation.status, "failed");
  assert.equal(f.store.exportSimulation("owner", "sim").branches.length, 1);
});

test("archive rejects forged selection, input, provenance and replacement event metadata", async t => {
  const f = await fixture(t);
  assert.equal((await createSavedAlternative(f.store, runtime(), f.request)).operation.status, "saved");
  const archive = f.store.exportSimulation("owner", "sim");
  for (const change of [
    (p: any) => { p.request.messageVersionId = "forged"; },
    (p: any) => { p.origin.completeWhisper = "forged"; },
    (p: any) => { p.completeWhisper = "forged"; },
    (p: any) => { p.generated.routing.version = 2; },
    (p: any) => { p.parentCommitId = f.original.commit.id; },
    (p: any) => { p.generated.generatedArtifact.provenance.runtimeProfile.id = "forged"; },
  ]) {
    const forged = structuredClone(archive);
    const row = forged.commandResults.find(c => c.canonicalInput.kind === "saved_alternative")!;
    if (row.canonicalInput.kind !== "saved_alternative") throw new Error("missing");
    change(row.canonicalInput.payload); row.fingerprint = fingerprintCommand(row.canonicalInput);
    assert.throws(() => validateSimulationArchive(forged));
  }
});

test("nested earlier/later alternatives, descendant closures and suspended continuation drafts remain independent", async t => {
  const f = await fixture(t);
  const second = commitManualTurn(f.store, { ...f.base, expectedHead: f.original.commit.id, commandId: "second-turn", payload: { actorId: "ceo", text: "SECOND-TURN", audience: ["ceo"], knowledgePolicy: "actor-knowledge-v1" } });
  const closed = await closeBranchEpisode(f.store, { ...f.base, expectedHead: second.commit.id, commandId: "close", payload: {} });
  const request = { ...f.request, expectedHead: closed.commit.id };
  const waiting = (await generateActorTurnDraft(f.store, runtime("WAITING"), { ...f.base, expectedHead: closed.commit.id, commandId: "waiting", payload: {
    actorId: "ceo", audience: ["ceo"], stageWhisperIds: [], runtimeProfile: { id: "test", version: "v1" },
    promptPolicy: { id: "actor-knowledge-v1", version: "v1" }, outputSchema: { id: "audience-proposal", digest: "v1" }, skillDigests: [],
    routing: { version: 3, completeWhisper: "WAITING-WHISPER", initialAudience: ["ceo"], correctedAudience: null, correction: "", sourceDraftId: null, preservedText: null },
  } })).draft;
  const secondMessage = second.commit.events.find(e => e.type === "message_accepted")!;
  if (secondMessage.type !== "message_accepted") throw new Error("missing");
  const laterAlternative = await createSavedAlternative(f.store, runtime("SECOND-REPLACED"), { ...request, commandId: "later-alt",
    sourceCommitId: second.commit.id, messageVersionId: secondMessage.message.id, logicalMessageId: secondMessage.message.logicalMessageId });
  assert.equal(laterAlternative.operation.status, "saved");
  const earlier = await createSavedAlternative(f.store, runtime("FIRST-REPLACED"), { ...request, commandId: "earlier-alt",
    sourceBranchId: laterAlternative.operation.outcome!.branchId, expectedHead: laterAlternative.operation.outcome!.commitId });
  assert.equal(earlier.operation.status, "saved");
  const earlierProjection = projectBranch(f.store, { ...f.base, branchId: earlier.operation.outcome!.branchId });
  assert.deepEqual(earlierProjection.transcript.map(x => x.text), ["FIRST-REPLACED"]);
  assert.equal(earlierProjection.episodeMemories.length, 0);
  const laterProjection = projectBranch(f.store, { ...f.base, branchId: laterAlternative.operation.outcome!.branchId });
  assert.deepEqual(laterProjection.transcript.map(x => x.text), ["OLD-SELECTED-PROSE", "SECOND-REPLACED"]);
  assert.equal(laterProjection.episodeMemories.length, 0);
  assert.ok(laterProjection.firstImpressions.length > 0, "legitimate ancestor observations retained");
  const paths = discoverSavedAlternatives(f.store, request).paths;
  assert.equal(paths.length, 3, "earlier branching turn discovers later fork continuing original version");
  assert.deepEqual(f.store.getActorTurnDraft("owner", "sim", waiting.id), waiting);
  assert.equal(acceptActorTurnDraft(f.store, { ownerScope: "owner", simulationId: "sim", draftId: waiting.id, commandId: "accept-waiting" }).commit.parentCommitId, closed.commit.id);
  validateSimulationArchive(f.store.exportSimulation("owner", "sim"));
});

test("receipt origins survive missing drafts; legacy multiple input requires explicit replacement; deleted implicit recipients stay absent", async t => {
  const f = await fixture(t);
  const whispers = ["LEGACY-ELEPHANT", "LEGACY-SECOND"].map((text, i) => stageWhisper(f.store, { ...f.base, expectedHead: f.original.commit.id, commandId: `whisper-${i}`, targetActorId: "ceo", text }));
  const legacy = (await generateActorTurnDraft(f.store, new DeterministicFakeRuntime([{ type: "completed", text: "LEGACY-PROSE", stopReason: "stop" }]), {
    ...f.base, expectedHead: f.original.commit.id, commandId: "legacy", payload: { actorId: "ceo", audience: ["ceo"], stageWhisperIds: whispers.map(w => w.id), runtimeProfile: { id: "test", version: "v1" },
      promptPolicy: { id: "default", version: "v1" }, outputSchema: { id: "screenplay", digest: "schema-v1" }, skillDigests: [] },
  })).draft;
  const accepted = acceptActorTurnDraft(f.store, { ownerScope: "owner", simulationId: "sim", draftId: legacy.id, commandId: "legacy-accept" });
  const message = accepted.commit.events.find(e => e.type === "message_accepted")!;
  if (message.type !== "message_accepted") throw new Error("missing");
  const { completeWhisper: _input, ...original } = f.request;
  const request = { ...original, expectedHead: accepted.commit.id, sourceCommitId: accepted.commit.id, messageVersionId: message.message.id, logicalMessageId: message.message.logicalMessageId };
  const db = new DatabaseSync(f.db); db.exec("DELETE FROM actor_turn_draft_commands; DELETE FROM actor_turn_drafts;"); db.close();
  const origin = originatingInput(f.store, request);
  assert.equal(origin.state, "legacy"); assert.equal(origin.completeWhisper, null);
  assert.deepEqual(origin.recordedWhispers.map(w => w.text), ["LEGACY-ELEPHANT", "LEGACY-SECOND"]);
  await assert.rejects(createSavedAlternative(f.store, runtime(), request), /explicit complete replacement/);
  const captured: RunActorTurnRequest[] = [];
  const capture = (audience = ["ceo"]) => new DeterministicFakeRuntime([{ type: "completed", text: JSON.stringify({ text: "NEW", audience }), stopReason: "stop" }], r => captured.push(r));
  const mentioned = await createSavedAlternative(f.store, capture(), { ...request, commandId: "mention", audience: null, completeWhisper: "Mention @coo ELEPHANT-NEW" });
  assert.equal(mentioned.operation.status, "saved");
  const replacement = projectBranch(f.store, { ...f.base, branchId: mentioned.operation.outcome!.branchId }).transcript.at(-1)!;
  const empty = await createSavedAlternative(f.store, capture(), { ...request, commandId: "empty", sourceBranchId: mentioned.operation.outcome!.branchId,
    expectedHead: mentioned.operation.outcome!.commitId, sourceCommitId: replacement.commitId!, messageVersionId: replacement.messageVersionId!, completeWhisper: "", audience: null });
  assert.equal(empty.operation.status, "saved");
  assert.ok(!JSON.stringify(captured[1]).includes("ELEPHANT-NEW"));
  assert.ok(!JSON.stringify(captured[1]).includes("LEGACY-ELEPHANT"));
  assert.ok(!empty.operation.draft!.routing!.availableRecipientIds.includes("coo"));
  const explicit = await createSavedAlternative(f.store, capture(["ceo", "coo"]), { ...request, commandId: "explicit", completeWhisper: "", audience: ["coo"] });
  assert.equal(explicit.operation.status, "saved");
  assert.ok(explicit.operation.draft!.routing!.availableRecipientIds.includes("coo"));
  const contradiction = await createSavedAlternative(f.store, capture(["ceo"]), { ...request, commandId: "contradiction", completeWhisper: "", audience: ["coo"] });
  assert.equal(contradiction.operation.status, "failed");
  validateSimulationArchive(f.store.exportSimulation("owner", "sim"));
});

test("off-path/non-message selections and cross-owner reads/replays/mutations fail without provider work", async t => {
  const f = await fixture(t);
  const saved = (await createSavedAlternative(f.store, runtime(), f.request)).operation;
  const replacement = f.store.getCommit("owner", "sim", saved.outcome!.commitId)!.events[0]!;
  if (replacement.type !== "message_accepted") throw new Error("missing");
  const fake = runtime();
  await assert.rejects(createSavedAlternative(f.store, fake, { ...f.request, commandId: "offpath",
    sourceCommitId: saved.outcome!.commitId, messageVersionId: replacement.message.id }), /source path/);
  const effect = commitRuntimeEffects(f.store, { ...f.base, expectedHead: f.original.commit.id, commandId: "effects-only",
    payload: { audienceChanges: [{ actorId: "cfo", action: "deactivate" }] } });
  await assert.rejects(createSavedAlternative(f.store, fake, { ...f.request, commandId: "nonmessage", expectedHead: effect.commit.id, sourceCommitId: effect.commit.id }), /accepted turn/);
  assert.throws(() => f.store.getAlternative("other", "sim", saved.id), /not found/);
  assert.throws(() => f.store.settleAlternative("other", "sim", saved.id, "discarded"), /not found/);
  assert.throws(() => originatingInput(f.store, { ...f.request, ownerScope: "other" }), /not found/);
  await assert.rejects(createSavedAlternative(f.store, fake, { ...f.request, ownerScope: "other" }), /not found/);
  assert.equal(fake.calls, 0);
  assert.equal(f.store.getAlternative("owner", "sim", saved.id)!.status, "saved");
});

test("corrected complete origin takes latest input; additive origin needs replacement; ancestor memory survives", async t => {
  const f = await fixture(t);
  const closure = await closeBranchEpisode(f.store, { ...f.base, expectedHead: f.original.commit.id, commandId: "ancestor-memory", payload: {} });
  const make = (commandId: string, version: 1 | 3, sourceDraftId: string | null = null) => ({ ...f.base,
    expectedHead: closure.commit.id, commandId, payload: { actorId: "ceo", audience: ["ceo"], stageWhisperIds: [],
      runtimeProfile: { id: "test", version: "v1" }, promptPolicy: { id: version === 3 ? "actor-knowledge-v1" : "audience-proposal-v1", version: "v1" },
      outputSchema: { id: "audience-proposal", digest: "v1" }, skillDigests: [], routing: { version,
        ...(version === 3 ? { completeWhisper: sourceDraftId ? "LATEST-COMPLETE" : "FORMER-COMPLETE" } : {}), initialAudience: ["ceo"],
        correctedAudience: sourceDraftId ? ["ceo"] : null, correction: version === 1 && sourceDraftId ? "ADDITIVE-FEEDBACK" : "", sourceDraftId, preservedText: null } },
  });
  const source = (await generateActorTurnDraft(f.store, runtime("SOURCE-ATTEMPT"), make("source-v3", 3))).draft;
  const corrected = (await generateActorTurnDraft(f.store, runtime("CORRECTED-PROSE"), make("corrected-v3", 3, source.id))).draft;
  const accepted = acceptActorTurnDraft(f.store, { ownerScope: "owner", simulationId: "sim", draftId: corrected.id, commandId: "accepted-v3" });
  const message = accepted.commit.events[0]!;
  if (message.type !== "message_accepted") throw new Error("missing");
  const { completeWhisper: _input, ...selection } = f.request;
  const selected = { ...selection, expectedHead: accepted.commit.id, sourceCommitId: accepted.commit.id,
    messageVersionId: message.message.id, logicalMessageId: message.message.logicalMessageId };
  assert.equal(originatingInput(f.store, selected).completeWhisper, "LATEST-COMPLETE");
  const captured: RunActorTurnRequest[] = [];
  const generated = await createSavedAlternative(f.store, new DeterministicFakeRuntime([{ type: "completed", text: JSON.stringify({ text: "REPLACED", audience: ["ceo"] }), stopReason: "stop" }], r => captured.push(r)), selected);
  assert.equal(generated.operation.status, "saved");
  const actual = JSON.stringify(captured[0]);
  for (const forbidden of ["FORMER-COMPLETE", "SOURCE-ATTEMPT", "CORRECTED-PROSE"]) assert.ok(!actual.includes(forbidden));
  assert.ok(actual.includes("LATEST-COMPLETE"));
  assert.ok(projectBranch(f.store, { ...f.base, branchId: generated.operation.outcome!.branchId }).episodeMemories.length > 0);
  // Both additive candidates remain at their original immutable basis on a fork.
  const legacyBranch = f.store.createBranch({ ownerScope: "owner", simulationId: "sim", sourceBranchId: "main", expectedHead: accepted.commit.id,
    atCommitId: closure.commit.id, branchId: "legacy-origin", commandId: "legacy-fork" }).branch;
  const legacySourceCommand = { ...make("legacy-source", 1), branchId: legacyBranch.id };
  const legacySource = (await generateActorTurnDraft(f.store, runtime(), legacySourceCommand)).draft;
  const legacyCorrected = (await generateActorTurnDraft(f.store, runtime(), { ...make("legacy-corrected", 1, legacySource.id), branchId: legacyBranch.id })).draft;
  const legacyAccepted = acceptActorTurnDraft(f.store, { ownerScope: "owner", simulationId: "sim", draftId: legacyCorrected.id, commandId: "legacy-final" });
  const legacyMessage = legacyAccepted.commit.events[0]!;
  if (legacyMessage.type !== "message_accepted") throw new Error("missing");
  const legacySelection = { ...selected, commandId: "legacy-new", sourceBranchId: legacyBranch.id, expectedHead: legacyAccepted.commit.id,
    sourceCommitId: legacyAccepted.commit.id, messageVersionId: legacyMessage.message.id, logicalMessageId: legacyMessage.message.logicalMessageId };
  const legacyOrigin = originatingInput(f.store, legacySelection);
  assert.equal(legacyOrigin.completeWhisper, null); assert.equal(legacyOrigin.legacyCorrection, "ADDITIVE-FEEDBACK");
  await assert.rejects(createSavedAlternative(f.store, runtime(), legacySelection), /explicit complete replacement/);
  validateSimulationArchive(f.store.exportSimulation("owner", "sim"));
});
