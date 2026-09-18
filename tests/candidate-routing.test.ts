import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileWorkspace } from "../src/core/compiler.ts";
import { commitRuntimeEffects, inspectActorContext, projectBranch, startBranchSimulationFromCompiled } from "../src/core/branch-kernel.ts";
import { acceptActorTurnDraft, discardActorTurnDraft, generateActorTurnDraft } from "../src/core/draft-lifecycle.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { decodeActorTurnDraftRecord, sha256 } from "../src/core/draft-contracts.ts";
import { finalDraftAudience, projectRoutingContext, ROUTING_POLICY } from "../src/core/candidate-routing.ts";
import { fingerprintCommand, stableStringify } from "../src/core/domain-rules.ts";
import { validateReadyDraft } from "../src/core/draft-acceptance.ts";
import type { GenerateActorTurnDraftCommand } from "../src/core/ports.ts";
import type { ActorTurnDraftRecord } from "../src/core/types.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";
import type { RunActorTurnRequest } from "../src/agent-runtime/contracts.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-routing-"));
  const db = path.join(root, "store.sqlite");
  const store = await openBranchStore(db).open();
  const compiled = await compileWorkspace(path.resolve("examples/executive-interviews"));
  compiled.beliefs = [];
  compiled.accessLinks = [];
  for (const asset of [...compiled.worlds, ...compiled.scenarios]) asset.body = "A meeting.";
  const surface = compiled.surfaces[0]!;
  compiled.surfaces = [
    { ...surface, entity: "cfo", text: "CFO-SURFACE-SENTINEL" },
    { ...surface, entity: "coo", text: "HIDDEN-COO-SURFACE-SENTINEL" },
  ];
  for (const actor of compiled.entities) if (actor.id === "coo") actor.visibility = "hidden";
  const started = startBranchSimulationFromCompiled(store, { ownerScope: "owner", simulationId: "sim", branchId: "main",
    commandId: "start", scenarioId: "executive-interviews", compiled });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const head = started.root.id;
  const query = { ownerScope: "owner", simulationId: "sim", branchId: "main" };
  function command(id: string, initial: string[] | null = null): GenerateActorTurnDraftCommand {
    return { ...query, expectedHead: head, commandId: id, payload: {
      actorId: "ceo", audience: initial || [], stageWhisperIds: [],
      runtimeProfile: { id: "character", version: "v1" }, promptPolicy: { id: ROUTING_POLICY, version: "v1" },
      outputSchema: { id: "audience-proposal", digest: "v1" }, skillDigests: [],
      routing: { version: 1, initialAudience: initial, correction: "", correctedAudience: null, preservedText: null, sourceDraftId: null },
    } };
  }
  return { store, db, root, head, query, command };
}

function runtime(audience: string[], text = "A performance.") {
  return new DeterministicFakeRuntime([{ type: "completed", text: JSON.stringify({ text, audience }), stopReason: "stop" }]);
}
function correction(source: ActorTurnDraftRecord, id: string, audience: string[], preservedText: string | null): GenerateActorTurnDraftCommand {
  return { ownerScope: source.ownerScope, simulationId: source.simulationId, branchId: source.branchId,
    expectedHead: source.basisHeadCommitId, commandId: id, payload: {
      actorId: source.actorId, audience, stageWhisperIds: source.stageWhispers.map(item => item.id),
      runtimeProfile: source.runtimeProfile, promptPolicy: source.promptPolicy, outputSchema: source.outputSchema,
      skillDigests: source.skillDigests, routing: { version: 1, initialAudience: source.routing!.initialAudience,
        sourceDraftId: source.id, correctedAudience: audience, correction: "Use only these recipients.", preservedText },
    } };
}

test("generated correction sends immediate UNACCEPTED source performance to the actual runtime", async t => {
  const f = await fixture(t);
  const sourceText = "SOURCE-PERFORMANCE-27: Ask @coo about the missing report.";
  const original = (await generateActorTurnDraft(f.store, runtime(["ceo", "cfo"], sourceText), f.command("source", ["cfo"]))).draft;
  const before = f.store.exportSimulation("owner", "sim");
  const command = correction(original, "relative-correction", ["cfo"], null);
  command.payload.routing!.correction = "Make that less accusatory.";
  const requests: RunActorTurnRequest[] = [];
  const correctedText = "IMMEDIATE-SOURCE-27: Could we review the report together?";
  const capture = new DeterministicFakeRuntime([
    { type: "completed", text: JSON.stringify({ text: correctedText, audience: ["ceo", "cfo"] }) },
  ], request => { requests.push(request); });
  const revised = (await generateActorTurnDraft(f.store, capture, command)).draft;
  assert.equal(revised.status, "ready");
  const request = requests[0]!;
  assert.ok(request.prompt.includes(sourceText), "actual runtime prompt must include source performance marker");
  assert.ok(request.prompt.includes(command.payload.routing!.correction));
  assert.match(request.prompt, /UNACCEPTED/);
  assert.ok(request.prompt.includes(JSON.stringify(original.artifact!.proposedAudience)));
  assert.deepEqual((request.context as { correctionSource: unknown }).correctionSource, {
    draftId: original.id, actorId: original.actorId, basisHeadCommitId: original.basisHeadCommitId,
    text: sourceText, audience: original.artifact!.proposedAudience,
  });
  assert.deepEqual(revised.routing!.availableRecipientIds, original.routing!.availableRecipientIds);
  assert.equal(revised.routing!.availableRecipientIds.includes("coo"), false);
  assert.doesNotMatch(request.prompt, /HIDDEN-COO-SURFACE-SENTINEL|CFO-SURFACE-SENTINEL/);
  assert.deepEqual((request.context as { subjective: unknown }).subjective, (original.context as { subjective: unknown }).subjective);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(request.prompt, revised.prompt);
  assert.equal(request.promptHash, sha256(request.prompt));
  assert.equal(request.contextHash, sha256(stableStringify(request.context)));
  assert.deepEqual(revised.routing!.source!.artifact, original.artifact);
  assert.deepEqual(f.store.getActorTurnDraft("owner", "sim", original.id), original);
  assert.deepEqual((await generateActorTurnDraft(f.store, capture, command)).draft, revised);
  assert.equal(capture.calls, 1);

  // A saved pre-fix routed correction keeps its old projection and hashes.
  const legacy = structuredClone(revised);
  const oldProjection = projectRoutingContext(f.store, command, []);
  Object.assign(legacy, { context: oldProjection.context, contextHash: oldProjection.contextHash,
    prompt: oldProjection.prompt, promptHash: oldProjection.promptHash });
  const acceptance = { ...f.query, draftId: revised.id, commandId: "validate" };
  assert.doesNotThrow(() => validateReadyDraft(f.store, acceptance, legacy));
  const tampered = structuredClone(revised);
  (tampered.context as { correctionSource: { text: string } }).correctionSource.text = "Forged source";
  assert.throws(() => validateReadyDraft(f.store, acceptance, tampered), /context hash/);

  const chainedCommand = correction(revised, "chained", ["cfo"], null);
  chainedCommand.payload.routing!.correction = "Make that shorter.";
  const chained = (await generateActorTurnDraft(f.store, capture, chainedCommand)).draft;
  assert.equal(chained.status, "ready");
  assert.ok(requests[1]!.prompt.includes(correctedText));
  assert.equal(requests[1]!.prompt.includes(sourceText), false);
  assert.equal(chained.routing!.source!.draftId, revised.id);
  assert.equal(chained.routing!.originalDraftId, original.id);
  assert.deepEqual(f.store.exportSimulation("owner", "sim"), before);
  acceptActorTurnDraft(f.store, { ...f.query, draftId: chained.id, commandId: "accept-chain" });
  const projection = projectBranch(f.store, f.query);
  assert.equal(projection.transcript.length, 1);
  assert.deepEqual(projection.perceptions.map(item => item.actorId), ["ceo", "cfo"]);
  assert.equal(JSON.stringify(projection).includes(sourceText), false);
  validateSimulationArchive(f.store.exportSimulation("owner", "sim"));
});

test("correction source validation rejects mismatches before runtime dispatch", async t => {
  const f = await fixture(t);
  const source = (await generateActorTurnDraft(f.store, runtime(["ceo"]), f.command("source"))).draft;
  const noCall = runtime(["ceo"]);
  const mutations: ((command: GenerateActorTurnDraftCommand) => void)[] = [
    command => { command.payload.routing!.sourceDraftId = "missing"; },
    command => { command.payload.actorId = "cfo"; },
    command => { command.payload.routing!.initialAudience = ["cfo"]; },
    command => { command.expectedHead = "wrong-basis"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const command = correction(source, `invalid-${index}`, ["ceo"], null);
    mutate(command);
    assert.throws(() => generateActorTurnDraft(f.store, noCall, command));
  }
  const failed = (await generateActorTurnDraft(f.store, runtime(["coo"]), f.command("failed-source"))).draft;
  assert.equal(failed.status, "failed");
  assert.throws(() => generateActorTurnDraft(f.store, noCall, correction(failed, "invalid-status", ["ceo"], null)), /ready routed source/);
  const whisper = f.store.createStageWhisper({ ...f.query, expectedHead: f.head, commandId: "extra-whisper",
    targetActorId: "ceo", text: "Additional direction." });
  const changedWhispers = correction(source, "changed-whispers", ["ceo"], null);
  changedWhispers.payload.stageWhisperIds = [whisper.id];
  assert.throws(() => generateActorTurnDraft(f.store, noCall, changedWhispers), /source actor, basis/);
  const advanced = commitRuntimeEffects(f.store, { ...f.query, expectedHead: f.head, commandId: "advance",
    payload: { audienceChanges: [{ actorId: "ceo", action: "add" }] } });
  const changedBasis = correction(source, "changed-basis", ["ceo"], null);
  changedBasis.expectedHead = advanced.commit.id;
  assert.throws(() => generateActorTurnDraft(f.store, noCall, changedBasis), /source actor, basis/);
  assert.equal(noCall.calls, 0);
  assert.equal(projectBranch(f.store, f.query).transcript.length, 0);
});

test("tentative and proposed delivery never grant surfaces; legacy context retains its interpretation", async t => {
  const f = await fixture(t);
  for (const initial of [null, ["cfo"], ["coo"]]) {
    const result = await generateActorTurnDraft(f.store, runtime(["ceo", ...(initial || [])]), f.command(`g-${initial?.[0] || "none"}`, initial));
    assert.equal(result.draft.status, "ready");
    assert.doesNotMatch(result.draft.prompt, /CFO-SURFACE-SENTINEL|HIDDEN-COO-SURFACE-SENTINEL/);
    assert.deepEqual((result.draft.context as { subjective: { surfaces: unknown[] } }).subjective.surfaces, []);
  }
  assert.match(inspectActorContext(f.store, { ...f.query, actorId: "ceo", audience: ["coo"] }).promptPreview, /HIDDEN-COO-SURFACE-SENTINEL/);
  assert.equal(projectBranch(f.store, f.query).transcript.length, 0);
  const invalid = await generateActorTurnDraft(f.store, runtime(["coo"]), f.command("unavailable"));
  assert.equal(invalid.draft.status, "failed");
  const legacy = f.command("legacy", ["coo"]);
  delete legacy.payload.routing;
  legacy.payload.promptPolicy = { id: "default", version: "v1" };
  legacy.payload.outputSchema = { id: "screenplay", digest: "schema-v1" };
  const old = await generateActorTurnDraft(f.store, new DeterministicFakeRuntime([{ type: "completed", text: "Legacy text" }]), legacy);
  assert.match(old.draft.prompt, /HIDDEN-COO-SURFACE-SENTINEL/);
  acceptActorTurnDraft(f.store, { ownerScope: "owner", simulationId: "sim", draftId: old.draft.id, commandId: "accept-legacy" });
  validateSimulationArchive(f.store.exportSimulation("owner", "sim"));
});

test("only explicit branch presence supplies observation, including after deactivation", async t => {
  const f = await fixture(t);
  const presence = commitRuntimeEffects(f.store, { ...f.query, expectedHead: f.head, commandId: "presence",
    payload: { audienceChanges: [{ actorId: "ceo", action: "add" }, { actorId: "cfo", action: "add" }] } });
  const command = f.command("present", ["coo"]);
  command.expectedHead = presence.commit.id;
  const result = await generateActorTurnDraft(f.store, runtime(["ceo"]), command);
  assert.match(result.draft.prompt, /CFO-SURFACE-SENTINEL/);
  assert.doesNotMatch(result.draft.prompt, /HIDDEN-COO-SURFACE-SENTINEL/);
  const gone = commitRuntimeEffects(f.store, { ...f.query, expectedHead: presence.commit.id, commandId: "gone",
    payload: { audienceChanges: [{ actorId: "ceo", action: "deactivate" }] } });
  command.commandId = "absent";
  command.expectedHead = gone.commit.id;
  const absent = await generateActorTurnDraft(f.store, runtime(["ceo"]), command);
  assert.doesNotMatch(absent.draft.prompt, /CFO-SURFACE-SENTINEL/);
});

test("whisper identity references are private intent, not automatic recipients or knowledge", async t => {
  const f = await fixture(t);
  const whisper = f.store.createStageWhisper({ ...f.query, expectedHead: f.head, commandId: "whisper", targetActorId: "ceo",
    text: "Tell @cfo about @coo, privately." });
  const command = f.command("directed");
  command.payload.stageWhisperIds = [whisper.id];
  const result = await generateActorTurnDraft(f.store, runtime(["ceo", "cfo"]), command);
  assert.equal(result.draft.status, "ready");
  assert.deepEqual(finalDraftAudience(result.draft), ["ceo", "cfo"]);
  assert.ok(result.draft.routing!.availableRecipientIds.includes("coo"));
  assert.doesNotMatch(result.draft.prompt, /HIDDEN-COO-SURFACE-SENTINEL/);
  assert.deepEqual(projectBranch(f.store, f.query).perceptions, []);
  const accepted = acceptActorTurnDraft(f.store, { ownerScope: "owner", simulationId: "sim", draftId: result.draft.id, commandId: "accept" });
  assert.equal(accepted.commit.events.filter(e => e.type === "stage_whisper_consumed").length, 1);
  assert.deepEqual(projectBranch(f.store, f.query).perceptions.map(p => p.actorId), ["ceo", "cfo"]);
  assert.equal(projectBranch(f.store, f.query).firstImpressions.some(i => i.entityId === "coo"), false);
});

test("director correction creates an exact preserved candidate, replays and survives archive without drafts", async t => {
  const f = await fixture(t);
  const original = (await generateActorTurnDraft(f.store, runtime(["ceo", "cfo"]), f.command("original", ["cfo"]))).draft;
  const noCall = runtime([]);
  const request = correction(original, "corrected", ["coo"], "My edited wording.\nKeep this line.");
  const before = f.store.exportSimulation("owner", "sim");
  const revised = await generateActorTurnDraft(f.store, noCall, request);
  assert.equal(revised.draft.status, "ready");
  assert.notEqual(revised.draft.id, original.id);
  assert.equal(noCall.calls, 0);
  assert.equal(revised.draft.artifact!.text, request.payload.routing!.preservedText);
  assert.equal(revised.draft.artifact!.provenance.adapter.id, "director-preserved");
  assert.deepEqual(revised.draft.routing!.source!.artifact, original.artifact);
  assert.equal(revised.draft.routing!.originalDraftId, original.id);
  assert.doesNotMatch(revised.draft.prompt, /HIDDEN-COO-SURFACE-SENTINEL/);
  assert.deepEqual(f.store.exportSimulation("owner", "sim"), before);
  assert.equal((await generateActorTurnDraft(f.store, noCall, request)).replayed, true);
  const changed = structuredClone(request);
  changed.payload.routing!.preservedText = "Different text";
  assert.throws(() => generateActorTurnDraft(f.store, noCall, changed), /different|identity|command/i);
  const accept = { ownerScope: "owner", simulationId: "sim", draftId: revised.draft.id, commandId: "accept" };
  acceptActorTurnDraft(f.store, accept);
  assert.equal(acceptActorTurnDraft(f.store, accept).replayed, true);
  const archive = f.store.exportSimulation("owner", "sim");
  validateSimulationArchive(archive);
  assert.equal("drafts" in archive, false);
  const imported = await openBranchStore(path.join(f.root, "import.sqlite")).open();
  try {
    imported.importSimulation(archive);
    assert.equal(imported.getActorTurnDraft("owner", "sim", revised.draft.id), null);
    assert.equal(acceptActorTurnDraft(imported, accept).replayed, true);
  } finally { imported.close(); }
  assert.throws(() => acceptActorTurnDraft(f.store, { ...accept, draftId: original.id, commandId: "stale" }), /head/i);
  assert.deepEqual(projectBranch(f.store, f.query).perceptions.map(p => p.actorId), ["ceo", "coo"]);
  for (const mutate of [
    (draft: ActorTurnDraftRecord) => { draft.artifact!.proposedAudience = ["ceo", "cfo"]; },
    (draft: ActorTurnDraftRecord) => { draft.routing!.source!.actorId = "cfo"; },
    (draft: ActorTurnDraftRecord) => { draft.artifact!.provenance.adapter.id = "pi"; },
  ]) {
    const forged = structuredClone(revised.draft); mutate(forged);
    assert.throws(() => decodeActorTurnDraftRecord(forged));
  }
  const selfOriginal = structuredClone(revised.draft);
  selfOriginal.routing!.originalDraftId = selfOriginal.id;
  selfOriginal.routing!.originalGenerationCommandId = selfOriginal.generationCommandId;
  assert.throws(() => decodeActorTurnDraftRecord(selfOriginal), /original routing ancestor/);
  const selfArchive = structuredClone(archive);
  const selfRecord = selfArchive.commandResults.find(item => item.canonicalInput.kind === "accept_draft")!;
  if (selfRecord.canonicalInput.kind !== "accept_draft") throw new Error("Missing receipt");
  const receipt = selfRecord.canonicalInput.payload;
  receipt.routing!.originalDraftId = receipt.draftId;
  receipt.routing!.originalGenerationCommandId = receipt.generationCommandId;
  selfRecord.fingerprint = fingerprintCommand(selfRecord.canonicalInput);
  assert.throws(() => validateSimulationArchive(selfArchive), /input structure mismatch/);
  const forgedArchive = structuredClone(archive);
  const recorded = forgedArchive.commandResults.find(item => item.canonicalInput.kind === "accept_draft")!;
  if (recorded.canonicalInput.kind !== "accept_draft") throw new Error("Missing receipt");
  recorded.canonicalInput.payload.routing!.correctedAudience = ["cfo"];
  recorded.fingerprint = fingerprintCommand(recorded.canonicalInput);
  assert.throws(() => validateSimulationArchive(forgedArchive));
});

test("contradictory corrections, unknown IDs, actor changes and tool attempts fail closed", async t => {
  const f = await fixture(t);
  const original = (await generateActorTurnDraft(f.store, runtime(["ceo", "cfo"]), f.command("original", ["cfo"]))).draft;
  const command = correction(original, "contradiction", ["coo"], null);
  const wrong = await generateActorTurnDraft(f.store, runtime(["ceo", "cfo"]), command);
  assert.equal(wrong.draft.status, "failed");
  command.commandId = "retry-correction";
  const right = await generateActorTurnDraft(f.store, runtime(["ceo", "coo"]), command);
  assert.equal(right.draft.status, "ready");
  assert.equal(right.draft.routing!.correctedAudience?.[0], "coo");
  const actorChange = correction(original, "actor-change", ["cfo"], null);
  actorChange.payload.actorId = "cfo";
  assert.throws(() => generateActorTurnDraft(f.store, runtime([]), actorChange), /source actor/);
  assert.throws(() => generateActorTurnDraft(f.store, runtime([]), f.command("unknown", ["missing"])), /not found/);
  const tool = await generateActorTurnDraft(f.store, new DeterministicFakeRuntime([{ type: "tool_requested", name: "route" }]), f.command("tool"));
  assert.equal(tool.draft.status, "failed");
  discardActorTurnDraft(f.store, { ownerScope: "owner", simulationId: "sim", draftId: right.draft.id, commandId: "discard" });
  assert.throws(() => acceptActorTurnDraft(f.store, { ownerScope: "owner", simulationId: "sim", draftId: right.draft.id, commandId: "rejected" }), /not ready/);
  assert.equal(projectBranch(f.store, f.query).transcript.length, 0);
});

test("a discarded in-flight routed candidate cannot publish a late proposal", async t => {
  const f = await fixture(t);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const waiting = { identity: { id: "delayed", version: "v1" }, async *runActorTurn() {
    enter(); await released;
    yield { type: "completed" as const, text: JSON.stringify({ text: "Late wording", audience: ["ceo"] }) };
  } };
  const generating = generateActorTurnDraft(f.store, waiting, f.command("delayed"));
  await entered;
  const second = await openBranchStore(f.db).open();
  try {
    const pending = second.listRecoverableActorTurnDrafts("owner", "sim", "main")[0]!;
    assert.equal(pending.status, "generating");
    discardActorTurnDraft(second, { ownerScope: "owner", simulationId: "sim", draftId: pending.id, commandId: "discard-pending" });
    release();
    assert.equal((await generating).draft.status, "discarded");
    assert.equal(projectBranch(second, f.query).perceptions.length, 0);
  } finally { release(); second.close(); }
});

test("corrected acceptance has one terminal winner across connections and rejects source tampering", async t => {
  const f = await fixture(t);
  const original = (await generateActorTurnDraft(f.store, runtime(["ceo"]), f.command("original"))).draft;
  const corrected = (await generateActorTurnDraft(f.store, runtime([]), correction(original, "preserved", ["cfo"], "Exact wording"))).draft;
  const forged = structuredClone(corrected);
  forged.routing!.source!.promptHash = "a".repeat(64);
  // Acceptance revalidates the live source, even if the source claim is well shaped.
  const { validateReadyDraft } = await import("../src/core/draft-acceptance.ts");
  const request = { ownerScope: "owner", simulationId: "sim", draftId: corrected.id, commandId: "accept" };
  assert.throws(() => validateReadyDraft(f.store, request, forged), /Source candidate/);
  const other = await openBranchStore(f.db).open();
  try {
    const accepted = acceptActorTurnDraft(other, request);
    assert.equal(acceptActorTurnDraft(f.store, request).commit.id, accepted.commit.id);
    assert.throws(() => discardActorTurnDraft(f.store, { ...request, commandId: "losing-discard" }), /cannot be discarded/);
    assert.throws(() => acceptActorTurnDraft(f.store, { ...request, commandId: "losing-accept" }), /not ready/);
    assert.equal(projectBranch(f.store, f.query).transcript.length, 1);
  } finally { other.close(); }
});

test("plain public names provide draft-local labels without routing or revealing hidden names", async t => {
  const f = await fixture(t);
  const revision = f.store.getContentRevision("owner", f.store.getSimulation("owner", "sim")!.contentRevisionId)!;
  const named = revision.compiled.entities.find(actor => actor.id === "cfo")!;
  const hidden = revision.compiled.entities.find(actor => actor.id === "coo")!;
  const whisper = f.store.createStageWhisper({ ...f.query, expectedHead: f.head, commandId: "named", targetActorId: "ceo",
    text: `Think about ${named.name} and @coo. Do not address either person.` });
  const command = f.command("named-reference");
  command.payload.stageWhisperIds = [whisper.id];
  const candidate = (await generateActorTurnDraft(f.store, runtime(["ceo"]), command)).draft;
  assert.equal(candidate.status, "ready");
  assert.deepEqual(finalDraftAudience(candidate), ["ceo"]);
  const context = candidate.context as { routingDirection: { references: { id: string; label: string }[] } };
  assert.deepEqual(context.routingDirection.references.find(item => item.id === "cfo"), { id: "cfo", label: named.name });
  assert.deepEqual(context.routingDirection.references.find(item => item.id === "coo"), { id: "coo", label: hidden.id });
  assert.equal(projectBranch(f.store, f.query).perceptions.length, 0);
});

test("retained belief provenance alone permits a recipient after presence loss; unseen identities fail", async t => {
  const f = await fixture(t);
  const original = (await generateActorTurnDraft(f.store, runtime(["ceo", "cfo"]), f.command("meet", ["cfo"]))).draft;
  const accepted = acceptActorTurnDraft(f.store, { ownerScope: "owner", simulationId: "sim", draftId: original.id, commandId: "accept-meeting" });
  const command = f.command("remembered");
  command.expectedHead = accepted.commit.id;
  const next = (await generateActorTurnDraft(f.store, runtime(["ceo", "cfo"]), command)).draft;
  assert.match(next.prompt, /first impression of @cfo/);
  assert.deepEqual((next.context as { subjective: { surfaces: unknown[] } }).subjective.surfaces, []);
  assert.equal(next.status, "ready");
  assert.ok(next.routing!.availableRecipientIds.includes("cfo"));
  assert.equal(next.routing!.availableRecipientIds.includes("coo"), false);
  command.commandId = "unseen";
  const unseen = (await generateActorTurnDraft(f.store, runtime(["ceo", "coo"]), command)).draft;
  assert.equal(unseen.status, "failed");
});

test("complete whisper replacement deletes elephant and implicit identities across repeated generations", async t => {
  const f = await fixture(t);
  const whisper = f.store.createStageWhisper({ ...f.query, expectedHead: f.head, commandId: "elephant-whisper",
    targetActorId: "ceo", text: "Describe an elephant to @coo." });
  const first = f.command("elephant");
  first.payload.stageWhisperIds = [whisper.id];
  const original = (await generateActorTurnDraft(f.store, runtime(["ceo"], "ELEPHANT-PERFORMANCE @coo"), first)).draft;
  const before = f.store.exportSimulation("owner", "sim");
  const requests: RunActorTurnRequest[] = [];
  const capture = new DeterministicFakeRuntime([{ type: "completed", text: JSON.stringify({ text: "Fresh reply.", audience: ["ceo"] }) }], request => requests.push(request));
  let source = original;
  for (const [index, text] of ["Describe a quiet room to @cfo.", "Describe a quiet room.", ""].entries()) {
    const command = correction(source, `complete-${index}`, [], null);
    Object.assign(command.payload.routing!, { version: 2, correction: "", correctedAudience: null, completeWhisper: text });
    const candidate = (await generateActorTurnDraft(f.store, capture, command)).draft;
    assert.equal(candidate.status, "ready");
    const request = requests.at(-1)!;
    assert.equal((request.context as { routingDirection: { completeWhisper: string } }).routingDirection.completeWhisper, text);
    if (text) assert.ok(request.prompt.includes(text));
    assert.doesNotMatch(JSON.stringify(request.context), /elephant|ELEPHANT|@coo|Fresh reply/);
    assert.doesNotMatch(request.prompt, /elephant|ELEPHANT|@coo|Fresh reply|UNACCEPTED/);
    assert.equal(candidate.routing!.availableRecipientIds.includes("coo"), false);
    assert.equal(candidate.routing!.availableRecipientIds.includes("cfo"), index === 0);
    const subjective = (request.context as { subjective: Record<string, unknown> }).subjective;
    const originalSubjective = (original.context as { subjective: Record<string, unknown> }).subjective;
    for (const key of Object.keys(subjective).filter(key => key !== "stageWhispers")) assert.deepEqual(subjective[key], originalSubjective[key]);
    assert.deepEqual(candidate.routing!.source!.artifact, source.artifact);
    assert.deepEqual(f.store.getActorTurnDraft("owner", "sim", original.id), original);
    assert.equal((await generateActorTurnDraft(f.store, capture, command)).replayed, true);
    const retry = structuredClone(command); retry.commandId += "-retry";
    const retried = (await generateActorTurnDraft(f.store, capture, retry)).draft;
    assert.equal(retried.promptHash, candidate.promptHash);
    assert.equal(retried.contextHash, candidate.contextHash);
    assert.doesNotThrow(() => validateReadyDraft(f.store, { ...f.query, draftId: candidate.id, commandId: "validate" }, candidate));
    source = candidate;
  }
  assert.deepEqual(f.store.exportSimulation("owner", "sim"), before);
  const accept = { ...f.query, draftId: source.id, commandId: "accept-complete" };
  acceptActorTurnDraft(f.store, accept);
  const archive = f.store.exportSimulation("owner", "sim");
  validateSimulationArchive(archive);
  const imported = await openBranchStore(path.join(f.root, "complete-import.sqlite")).open();
  try { imported.importSimulation(archive); assert.equal(acceptActorTurnDraft(imported, accept).replayed, true); }
  finally { imported.close(); }
});

test("retry preserves the captured pre-source-material legacy interpretation", async t => {
  const f = await fixture(t);
  const original = (await generateActorTurnDraft(f.store, runtime(["ceo"]), f.command("original-legacy"))).draft;
  const command = correction(original, "old-correction", [], null);
  const modern = (await generateActorTurnDraft(f.store, runtime(["ceo"]), command)).draft;
  const oldProjection = projectRoutingContext(f.store, command, []);
  const legacy = { ...modern, context: oldProjection.context, contextHash: oldProjection.contextHash,
    prompt: oldProjection.prompt, promptHash: oldProjection.promptHash };
  // Emulate a read of an existing pre-source-material record, without rewriting it.
  const get = f.store.getActorTurnDraft.bind(f.store);
  f.store.getActorTurnDraft = (owner, simulation, id) => id === legacy.id ? legacy : get(owner, simulation, id);
  const retry = structuredClone(command); retry.commandId = "retry-old-correction";
  const options = Object.assign({}, { retryDraftId: legacy.id });
  const retried = (await generateActorTurnDraft(f.store, runtime(["ceo"]), retry, options)).draft;
  assert.equal(retried.promptHash, legacy.promptHash);
  assert.equal(retried.contextHash, legacy.contextHash);
  assert.doesNotMatch(retried.prompt, /UNACCEPTED/);
});

test("complete whisper audience overrides remove obsolete explicit references and reject contradictory proposals", async t => {
  const f = await fixture(t);
  const original = (await generateActorTurnDraft(f.store, runtime(["ceo"]), f.command("initial-explicit", ["coo"]))).draft;
  const command = correction(original, "replace-explicit", [], null);
  Object.assign(command.payload.routing!, { version: 2, correction: "", completeWhisper: "Consider the room." });
  const replacement = (await generateActorTurnDraft(f.store, runtime(["ceo"]), command)).draft;
  assert.equal(replacement.status, "ready");
  assert.deepEqual(replacement.routing!.availableRecipientIds, ["ceo"]);
  assert.doesNotMatch(replacement.prompt, /coo/);
  const contradict = structuredClone(command); contradict.commandId = "contradict-v2";
  contradict.payload.audience = ["cfo"];
  contradict.payload.routing!.correctedAudience = ["cfo"];
  const failed = (await generateActorTurnDraft(f.store, runtime(["ceo"]), contradict)).draft;
  assert.equal(failed.status, "failed");
  const retry = structuredClone(contradict); retry.commandId = "retry-v2-failed";
  const ready = (await generateActorTurnDraft(f.store, runtime(["ceo", "cfo"]), retry, { retryDraftId: failed.id })).draft;
  assert.equal(ready.status, "ready");
  assert.equal(ready.contextHash, failed.contextHash);
  assert.equal(ready.promptHash, failed.promptHash);
  const invalidPreserve = structuredClone(command); invalidPreserve.commandId = "false-preserve";
  invalidPreserve.payload.routing!.preservedText = "Unchanged performance.";
  assert.throws(() => generateActorTurnDraft(f.store, runtime([]), invalidPreserve), /whisper/i);
});
