import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileWorkspace } from "../src/core/compiler.ts";
import { commitManualTurn, stageWhisper, startBranchSimulationFromCompiled } from "../src/core/branch-kernel.ts";
import { acceptActorTurnDraft, discardActorTurnDraft, generateActorTurnDraft } from "../src/core/draft-lifecycle.ts";
import { receiptFor } from "../src/core/draft-acceptance.ts";
import { alternativeId, createSavedAlternative, originatingInput, type AlternativeRecord, type AlternativeRequest } from "../src/core/saved-alternatives.ts";
import { domainId, fingerprintCommand, recordCommand, stableStringify } from "../src/core/domain-rules.ts";
import { sha256 } from "../src/core/draft-contracts.ts";
import { CommandIdentityError, type GenerateActorTurnDraftCommand } from "../src/core/ports.ts";
import { openBranchStore, validateSimulationArchive } from "../src/store/branch-sqlite.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";
import type { ActorTurnRuntime } from "../src/agent-runtime/contracts.ts";

const scope = { ownerScope: "owner", simulationId: "sim" };
const runtime = () => new DeterministicFakeRuntime([{ type: "completed", text: JSON.stringify({ text: "Replacement", audience: ["ceo"] }), stopReason: "stop" }]);
const ordinaryRuntime = () => new DeterministicFakeRuntime([{ type: "completed", text: "Continuation", stopReason: "stop" }]);
const generationId = (request: AlternativeRequest) => domainId("alternative_generation", alternativeId(request));

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "alternative-identities-"));
  const db = path.join(root, "original.sqlite");
  const store = await openBranchStore(db).open();
  t.after(async () => { store.close(); await rm(root, { force: true, recursive: true }); });
  const compiled = await compileWorkspace(path.resolve("examples/executive-interviews"));
  const started = startBranchSimulationFromCompiled(store, { ...scope, branchId: "main", commandId: "start", scenarioId: "executive-interviews", compiled });
  const original = commitManualTurn(store, { ...scope, branchId: "main", commandId: "original", expectedHead: started.root.id,
    payload: { actorId: "ceo", text: "Original", audience: ["ceo"], knowledgePolicy: "actor-knowledge-v1" } });
  const event = original.commit.events[0]!;
  assert.equal(event.type, "message_accepted");
  if (event.type !== "message_accepted") throw new Error("Missing message");
  const request: AlternativeRequest = { ...scope, commandId: "historical", sourceBranchId: "main", expectedHead: original.commit.id,
    sourceCommitId: original.commit.id, messageVersionId: event.message.id, logicalMessageId: event.message.logicalMessageId,
    actorId: "ceo", action: "generate", audience: ["ceo"], completeWhisper: "Replacement input" };
  const command = (commandId: string, head = original.commit.id): GenerateActorTurnDraftCommand => ({ ...scope,
    branchId: "main", expectedHead: head, commandId, payload: { actorId: "ceo", audience: ["ceo"], stageWhisperIds: [],
      runtimeProfile: { id: "test", version: "v1" }, promptPolicy: { id: "default", version: "v1" },
      outputSchema: { id: "screenplay", digest: "schema-v1" }, skillDigests: [] } });
  const imported = async () => {
    const archive = store.exportSimulation(scope.ownerScope, scope.simulationId);
    validateSimulationArchive(archive);
    const target = await openBranchStore(path.join(root, "import.sqlite")).open();
    t.after(() => target.close()); target.importSimulation(archive); return target;
  };
  return { store, db, request, command, imported, parent: started.root.id };
}

for (const identity of ["request", "generation"] as const) {
  for (const prior of ["canonical whisper", "draft generation", "draft discard", "imported accepted generation"] as const) {
    test(`historical ${identity} identity conflicts with preexisting ${prior} before provider`, async t => {
      const f = await fixture(t);
      const id = identity === "request" ? f.request.commandId : generationId(f.request);
      let store = f.store;
      let replay: () => unknown | Promise<unknown>;
      if (prior === "canonical whisper") {
        const input = { ...scope, branchId: "main", expectedHead: f.request.expectedHead, commandId: id, targetActorId: "ceo", text: "Prior direction" };
        const whisper = stageWhisper(store, input);
        replay = () => assert.deepEqual(stageWhisper(store, input), whisper);
      } else {
        const fake = ordinaryRuntime();
        const command = f.command(prior === "draft discard" ? "prior-generation" : id);
        const result = await generateActorTurnDraft(store, fake, command);
        if (prior === "draft generation") {
          replay = async () => { assert.equal((await generateActorTurnDraft(store, fake, command)).replayed, true); assert.equal(fake.calls, 1); };
        } else if (prior === "draft discard") {
          const input = { ...scope, draftId: result.draft.id, commandId: id };
          discardActorTurnDraft(store, input);
          replay = () => assert.equal(discardActorTurnDraft(store, input).replayed, true);
        } else {
          const input = { ...scope, draftId: result.draft.id, commandId: "prior-accept" };
          const accepted = acceptActorTurnDraft(store, input);
          f.request.expectedHead = accepted.commit.id;
          store = await f.imported();
          assert.equal(store.getActorTurnDraft(scope.ownerScope, scope.simulationId, result.draft.id), null);
          replay = () => assert.equal(acceptActorTurnDraft(store, input).replayed, true);
        }
      }
      const before = store.exportSimulation(scope.ownerScope, scope.simulationId);
      const fake = runtime();
      await assert.rejects(createSavedAlternative(store, fake, f.request), CommandIdentityError);
      assert.equal(fake.calls, 0);
      assert.deepEqual(store.exportSimulation(scope.ownerScope, scope.simulationId), before);
      assert.equal(store.getAlternative(scope.ownerScope, scope.simulationId, alternativeId(f.request)), null);
      await replay();
      validateSimulationArchive(store.exportSimulation(scope.ownerScope, scope.simulationId));
    });
  }
}

for (const state of ["pending without draft", "failed without draft", "discarded", "saved", "imported saved"] as const) {
  test(`historical request and generation identities protect ordinary acceptance and replay: ${state}`, async t => {
    const f = await fixture(t);
    let store = f.store;
    const fake = runtime();
    if (state === "pending without draft") {
      const now = new Date().toISOString();
      const operation: AlternativeRecord = { id: alternativeId(f.request), request: f.request, fingerprint: sha256(stableStringify(f.request)),
        parentCommitId: f.parent, contentRevisionId: store.getSimulation(scope.ownerScope, scope.simulationId)!.contentRevisionId,
        completeWhisper: f.request.completeWhisper!, origin: originatingInput(store, f.request), status: "pending", failure: null,
        draft: null, outcome: null, createdAt: now, updatedAt: now };
      store.reserveAlternative(operation);
      // Reopen at the crash boundary between request reservation and draft capture.
      store = await openBranchStore(f.db).open(); t.after(() => store.close());
    } else if (state === "failed without draft") {
      f.request.completeWhisper = "@missing-actor";
      const failed = await createSavedAlternative(store, fake, f.request);
      assert.equal(failed.operation.status, "failed"); assert.equal(failed.operation.draft, null);
    } else if (state === "discarded") {
      const failed = await createSavedAlternative(store, new DeterministicFakeRuntime([{ type: "failed", stopReason: "error" }]), f.request);
      store.settleAlternative(scope.ownerScope, scope.simulationId, failed.operation.id, "discarded");
    } else {
      assert.equal((await createSavedAlternative(store, fake, f.request)).operation.status, "saved");
      if (state === "imported saved") store = await f.imported();
    }
    const draft = (await generateActorTurnDraft(store, ordinaryRuntime(), f.command("continuation"))).draft;
    const before = store.exportSimulation(scope.ownerScope, scope.simulationId);
    const operationBefore = store.getAlternative(scope.ownerScope, scope.simulationId, alternativeId(f.request));
    for (const commandId of [f.request.commandId, generationId(f.request)]) {
      const input = { ...scope, draftId: draft.id, commandId };
      assert.throws(() => store.replayAcceptedActorTurnDraft(input), CommandIdentityError);
      assert.throws(() => acceptActorTurnDraft(store, input), CommandIdentityError);
      // Also exercise the write-transaction entry point, not only application preflight.
      const commandInput = recordCommand("accept_draft", { ...scope, branchId: draft.branchId, expectedHead: draft.basisHeadCommitId,
        commandId, payload: receiptFor(draft, draft.artifact!.text) });
      assert.throws(() => store.acceptActorTurnDraft({ request: input, commandInput, commandFingerprint: fingerprintCommand(commandInput),
        createdAt: new Date().toISOString() }), CommandIdentityError);
      assert.throws(() => stageWhisper(store, { ...scope, branchId: "main", expectedHead: f.request.expectedHead, commandId,
        targetActorId: "ceo", text: "Collision" }), CommandIdentityError);
      const attemptedRuntime = ordinaryRuntime();
      await assert.rejects(async () => generateActorTurnDraft(store, attemptedRuntime, f.command(commandId)), CommandIdentityError);
      assert.equal(attemptedRuntime.calls, 0);
    }
    assert.deepEqual(store.exportSimulation(scope.ownerScope, scope.simulationId), before);
    assert.deepEqual(store.getActorTurnDraft(scope.ownerScope, scope.simulationId, draft.id), draft);
    assert.deepEqual(store.getAlternative(scope.ownerScope, scope.simulationId, alternativeId(f.request)), operationBefore);
    const calls = fake.calls;
    assert.equal((await createSavedAlternative(store, fake, f.request)).replayed, true);
    assert.equal(fake.calls, calls);
    const accepted = acceptActorTurnDraft(store, { ...scope, draftId: draft.id, commandId: "ordinary-accept" });
    assert.equal(accepted.replayed, false);
    assert.equal(acceptActorTurnDraft(store, { ...scope, draftId: draft.id, commandId: "ordinary-accept" }).replayed, true);
    validateSimulationArchive(store.exportSimulation(scope.ownerScope, scope.simulationId));
  });
}

test("pending runtime reserves both identities against another historical request and ordinary acceptance", async t => {
  const f = await fixture(t);
  const ordinary = (await generateActorTurnDraft(f.store, ordinaryRuntime(), f.command("continuation"))).draft;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow: ActorTurnRuntime = { identity: { id: "slow", version: "v1" }, async *runActorTurn() {
    await gate; yield { type: "completed", text: JSON.stringify({ text: "Replacement", audience: ["ceo"] }), stopReason: "stop" };
  } };
  const pending = createSavedAlternative(f.store, slow, f.request);
  try {
    assert.equal(f.store.getAlternative(scope.ownerScope, scope.simulationId, alternativeId(f.request))!.draft!.status, "generating");
    const other = await openBranchStore(f.db).open(); t.after(() => other.close());
    const before = other.exportSimulation(scope.ownerScope, scope.simulationId);
    const fake = runtime();
    await assert.rejects(createSavedAlternative(other, fake, { ...f.request, commandId: generationId(f.request) }), CommandIdentityError);
    assert.equal(fake.calls, 0);
    assert.throws(() => acceptActorTurnDraft(other, { ...scope, draftId: ordinary.id, commandId: generationId(f.request) }), CommandIdentityError);
    assert.deepEqual(other.exportSimulation(scope.ownerScope, scope.simulationId), before);
  } finally { release(); await pending; }
  validateSimulationArchive(f.store.exportSimulation(scope.ownerScope, scope.simulationId));
});
