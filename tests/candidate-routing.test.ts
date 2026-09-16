import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileWorkspace } from "../src/core/compiler.ts";
import { commitRuntimeEffects, inspectActorContext, projectBranch, startBranchSimulationFromCompiled } from "../src/core/branch-kernel.ts";
import { acceptActorTurnDraft, discardActorTurnDraft, generateActorTurnDraft } from "../src/core/draft-lifecycle.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { decodeActorTurnDraftRecord } from "../src/core/draft-contracts.ts";
import { finalDraftAudience, ROUTING_POLICY } from "../src/core/candidate-routing.ts";
import { fingerprintCommand } from "../src/core/domain-rules.ts";
import type { GenerateActorTurnDraftCommand } from "../src/core/ports.ts";
import type { ActorTurnDraftRecord } from "../src/core/types.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";

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
