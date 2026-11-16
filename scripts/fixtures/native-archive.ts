/** Temporary migration oracle. Native tests keep the portable accepted history. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileWorkspace } from "../../src/core/compiler.ts";
import { startBranchSimulationFromCompiled, commitManualTurn, commitRuntimeEffects, stageWhisper, forkBranch, editAcceptedMessage, regenerateAcceptedResponse } from "../../src/core/branch-kernel.ts";
import { requestEpisodeClosure, runEpisodeMemoryJob } from "../../src/core/branch-episode.ts";
import { reviseMemory, retractMemory } from "../../src/core/memory-operations.ts";
import { correctTurnBody } from "../../src/core/turn-correction.ts";
import { generateActorTurnDraft, acceptActorTurnDraft } from "../../src/core/draft-lifecycle.ts";
import { createSavedAlternative } from "../../src/core/saved-alternatives.ts";
import { validateSimulationArchive } from "../../src/core/archive-verifier.ts";
import { openBranchStore } from "../../src/store/branch-sqlite.ts";
import { DeterministicFakeRuntime } from "../../tests/helpers/deterministic-fake-runtime.ts";
import { fingerprintCommand, stableStringify } from "../../src/core/domain-rules.ts";
import { createHash } from "node:crypto";

const root = await mkdtemp(path.join(tmpdir(), "doxvelt-archive-oracle-"));
const store = await openBranchStore(path.join(root, "story.sqlite")).open();
try {
  const compiled = await compileWorkspace(path.resolve("examples/executive-interviews"));
  compiled.sourceRoot = "";
  // Keep this proof about history/provenance rather than duplicating the full
  // compiler specimen in every immutable start receipt.
  compiled.models = []; compiled.formats = []; compiled.connections = [];
  compiled.mentions = []; compiled.taggedLines = []; compiled.diagnostics = [];
  compiled.entities = compiled.entities.filter(e => ["ceo", "cfo"].includes(e.id));
  compiled.accessLinks = compiled.accessLinks.filter(l => ["ceo", "cfo"].includes(l.member) && ["ceo", "cfo"].includes(l.container));
  compiled.beliefs = compiled.beliefs.filter(b => b.holder === "ceo").slice(0, 1).map(b => ({ ...b, propositionText: "The plan can work.", mentions: [], sourceSpan: { file: "entities/ceo/beliefs.md", line: 1, quote: "+3 The plan can work." } }));
  compiled.surfaces = compiled.surfaces.filter(s => ["ceo", "cfo"].includes(s.entity)).map(s => ({ ...s, text: "A reserved person.", sourceSpan: { file: `entities/${s.entity}/surface.md`, line: 1, quote: "A reserved person." } }));
  for (const asset of [...compiled.worlds, ...compiled.scenarios]) { asset.body = "A meeting."; asset.metadata = {}; }
  const base = { ownerScope: "owner", simulationId: "archive", branchId: "main" };
  const started = startBranchSimulationFromCompiled(store, { ...base, commandId: "start", compiled });
  const whisper = stageWhisper(store, { ...base, commandId: "direction", expectedHead: started.root.id, targetActorId: "ceo", text: "Be precise." });
  const original = commitManualTurn(store, { ...base, commandId: "original", expectedHead: started.root.id,
    payload: { actorId: "ceo", audience: ["cfo"], text: "A private claim.", stageWhisperIds: [whisper.id] } });
  const effect = commitRuntimeEffects(store, { ...base, commandId: "access", expectedHead: original.commit.id,
    payload: { accessChanges: [{ action: "revoke", member: "cfo", container: "ceo" }], audienceChanges: [{ actorId: "cfo", action: "add" }] } });
  const scoped = commitManualTurn(store, { ...base, commandId: "scoped", expectedHead: effect.commit.id,
    payload: { actorId: "ceo", audience: ["ceo"], text: "Shared #cfo(secret)", audienceSyntax: "scoped-v1", knowledgePolicy: "actor-knowledge-v1" } });
  const closure = requestEpisodeClosure(store, { ...base, commandId: "closure", expectedHead: scoped.commit.id, payload: { label: "Meeting" } });
  const memory = await runEpisodeMemoryJob(store, { ...base, jobId: closure.job.id }, {
    writeMemory: ({ actor }) => `I remember the meeting as @${actor.id}.`,
    writeLongTermMemory: ({ actor }) => `My longer recollection as @${actor.id}.`,
    extractBeliefs: ({ actor }) => [{ strength: -1, propositionText: `@${actor.id} doubts the claim.` }],
  });
  const episode = memory.operations.find(op => op.type === "asserted")!;
  const revision = reviseMemory(store, { ...base, commandId: "revise", expectedHead: closure.commit.id,
    payload: { actorId: episode.actorId, memoryId: episode.memoryId, revisesOperationId: episode.id, content: "A revised recollection." } });
  const revisionEvent = revision.commit.events[0]!;
  const retract = retractMemory(store, { ...base, commandId: "retract", expectedHead: revision.commit.id,
    payload: { actorId: episode.actorId, memoryId: episode.memoryId, retractsOperationId: revisionEvent.type === "memory_operation" ? revisionEvent.operation.id : "" } });
  const memoryArchive = store.exportSimulation(base.ownerScope, base.simulationId);
  validateSimulationArchive(memoryArchive);
  forkBranch(store, { ...base, commandId: "fork", sourceBranchId: "main", expectedHead: retract.commit.id, atCommitId: original.commit.id, branchId: "forked", name: "Fork" });
  const replacement = { ownerScope: base.ownerScope, simulationId: base.simulationId, sourceBranchId: "main", sourceCommitId: original.commit.id, expectedHead: retract.commit.id,
    payload: { actorId: "ceo", audience: ["cfo"], text: "An alternative wording." } };
  editAcceptedMessage(store, { ...replacement, commandId: "edit", branchId: "edited" });
  regenerateAcceptedResponse(store, { ...replacement, commandId: "regenerate", branchId: "regenerated" });
  const generated = await generateActorTurnDraft(store, new DeterministicFakeRuntime([{ type: "completed", text: "Generated reply.", stopReason: "stop" }]),
    { ...base, commandId: "generation", expectedHead: retract.commit.id, payload: { actorId: "cfo", audience: ["ceo"], stageWhisperIds: [],
      runtimeProfile: { id: "local-character", version: "v1" }, promptPolicy: { id: "default", version: "v1" }, outputSchema: { id: "screenplay", digest: "v1" }, skillDigests: [] } });
  const accepted = acceptActorTurnDraft(store, { ...base, commandId: "accept", draftId: generated.draft.id, finalText: "  Edited generated reply.  " });
  const originalMessage = original.commit.events.find(e => e.type === "message_accepted")!;
  if (originalMessage.type !== "message_accepted") throw new Error("Missing original message");
  const historical = { ownerScope: base.ownerScope, simulationId: base.simulationId, sourceBranchId: "main", expectedHead: accepted.commit.id, sourceCommitId: original.commit.id,
    messageVersionId: originalMessage.message.id, logicalMessageId: originalMessage.message.logicalMessageId, actorId: "ceo", audience: ["ceo"] };
  for (const action of ["manual", "generate"] as const) {
    const result = await createSavedAlternative(store, action === "generate" ? new DeterministicFakeRuntime([{ type: "completed", text: JSON.stringify({ text: "A new beginning.", audience: ["ceo"] }), stopReason: "stop" }]) : undefined,
      { ...historical, commandId: `historical-${action}`, action, ...(action === "manual" ? { manualText: "A manual beginning." } : { completeWhisper: "Change the opening." }) });
    if (result.operation.status !== "saved") throw new Error(`Historical ${action} failed`);
  }
  correctTurnBody(store, { ownerScope: base.ownerScope, simulationId: base.simulationId, sourceBranchId: "main", expectedHead: accepted.commit.id,
    commandId: "correct", payload: { messageVersionId: originalMessage.message.id, text: "A corrected private claim." } });
  const complete = store.exportSimulation(base.ownerScope, base.simulationId);
  validateSimulationArchive(complete);
  const hash = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");
  const legacy = structuredClone(memoryArchive); legacy.schemaVersion = 4;
  const checkpoint = legacy.commits.find(c => c.kind === "episode_closure")!;
  const checkpointEvent = checkpoint.events.find(e => e.type === "episode_closed")!;
  if (checkpointEvent.type === "episode_closed") checkpointEvent.closure = structuredClone(legacy.memoryJobs![0]!.result!);
  const checkpointCommand = legacy.commandResults.find(c => c.commandId === checkpoint.commandId)!;
  if (checkpointCommand.result.kind === "commit") checkpointCommand.result.commit = structuredClone(checkpoint);
  delete legacy.memoryJobs; delete legacy.memoryJobTransitions; delete legacy.detachedMemoryOperations;
  const converted = structuredClone(legacy); validateSimulationArchive(converted);
  const mutations: { name: string; valid: boolean; changes: { path: (string | number)[]; value?: unknown; remove?: true }[] }[] = [];
  const diff = (before: any, after: any, current: (string | number)[] = []): typeof mutations[number]["changes"] => {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    if (before && after && typeof before === "object" && typeof after === "object" && Array.isArray(before) === Array.isArray(after) && (!Array.isArray(before) || before.length === after.length)) {
      return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => {
        const next = [...current, Array.isArray(before) ? Number(key) : key];
        return !Object.hasOwn(after, key) ? [{ path: next, remove: true as const }] : diff(before[key], after[key], next);
      });
    }
    return [{ path: current, value: after }];
  };
  const test = (name: string, mutate: (a: any) => void) => {
    const changed = structuredClone(complete); mutate(changed);
    let valid = true; try { validateSimulationArchive(structuredClone(changed)); } catch { valid = false; }
    mutations.push({ name, valid, changes: diff(complete, changed) });
  };
  const command = (a: any, id: string) => a.commandResults.find((c: any) => c.commandId === id);
  const sync = (a: any, id: string) => { command(a, id).result.commit = structuredClone(a.commits.find((c: any) => c.commandId === id)); };
  const rehash = (a: any, id: string) => { const c = command(a, id); c.fingerprint = fingerprintCommand(c.canonicalInput); };
  const syncJob = (a: any) => {
    const job = a.memoryJobs[0]; job.resultFingerprint = hash(job.result); a.detachedMemoryOperations = structuredClone(job.result.memoryOperations);
    const terminal = a.memoryJobTransitions.find((t: any) => t.status === "completed"); terminal.result = structuredClone(job.result); terminal.resultFingerprint = job.resultFingerprint;
  };
  for (const [name, mutate] of [
    ["missing parent", (a: any) => { a.commits[1].parentCommitId = "missing"; }],
    ["commit cycle", (a: any) => { a.commits[1].parentCommitId = a.commits[1].id; }],
    ["duplicate commit", (a: any) => { a.commits.push(structuredClone(a.commits[0])); }],
    ["duplicate branch", (a: any) => { a.branches.push(structuredClone(a.branches[0])); }],
    ["branch origin cycle", (a: any) => { const b = a.branches.find((b: any) => b.id === "forked"); b.origin.sourceBranchId = b.id; }],
    ["missing branch name", (a: any) => { delete a.branches[0].name; }],
    ["content digest", (a: any) => { a.contentRevision.digest = "0".repeat(64); }],
    ["metadata number", (a: any) => { a.contentRevision.compiled.worlds[0].metadata.number = 7; }],
    ["fingerprint", (a: any) => { command(a, "original").fingerprint = "0".repeat(64); }],
    ["duplicate receipt", (a: any) => { a.commandResults.push(structuredClone(command(a, "original"))); }],
    ["unknown canonical field", (a: any) => { command(a, "original").canonicalInput.extra = true; rehash(a, "original"); }],
    ["manual wording", (a: any) => { a.commits.find((c: any) => c.commandId === "original").events[0].message.text = "Forged."; sync(a, "original"); }],
    ["scope projection text", (a: any) => { a.commits.find((c: any) => c.commandId === "scoped").events[0].message.performance.projections[0].text = "Leaked."; sync(a, "scoped"); }],
    ["scope duplicate projection", (a: any) => { const p = a.commits.find((c: any) => c.commandId === "scoped").events[0].message.performance; p.projections.push(structuredClone(p.projections[0])); sync(a, "scoped"); }],
    ["wrong generated artifact digest", (a: any) => { command(a, "accept").canonicalInput.payload.generatedArtifact.digest = "0".repeat(64); rehash(a, "accept"); }],
    ["recorded context claim", (a: any) => { command(a, "accept").canonicalInput.payload.contextHash = "a".repeat(64); rehash(a, "accept"); }],
    ["recorded prompt claim", (a: any) => { command(a, "accept").canonicalInput.payload.promptHash = "b".repeat(64); rehash(a, "accept"); }],
    ["arbitrary ledger timestamp", (a: any) => { command(a, "accept").createdAt = "old clock"; }],
    ["generation command reused", (a: any) => { command(a, "accept").canonicalInput.payload.generationCommandId = "original"; rehash(a, "accept"); }],
    ["historical parent", (a: any) => { command(a, "historical-manual").canonicalInput.payload.parentCommitId = "missing"; rehash(a, "historical-manual"); }],
    ["historical origin", (a: any) => { command(a, "historical-generate").canonicalInput.payload.origin.completeWhisper = "Invented."; rehash(a, "historical-generate"); }],
    ["historical complete direction", (a: any) => { command(a, "historical-generate").canonicalInput.payload.completeWhisper = "Invented."; rehash(a, "historical-generate"); }],
    ["correction body", (a: any) => { a.commits.find((c: any) => c.commandId === "correct").events[0].text = "Forged."; sync(a, "correct"); }],
    ["job missing label", (a: any) => { delete a.memoryJobs[0].label; }],
    ["job invented current state", (a: any) => { a.memoryJobs[0].attemptCount++; }],
    ["job wrong fingerprint", (a: any) => { a.memoryJobs[0].resultFingerprint = "0".repeat(64); }],
    ["job missing transition", (a: any) => { a.memoryJobTransitions.shift(); }],
    ["job missing transition error", (a: any) => { delete a.memoryJobTransitions[0].error; }],
    ["job transitions reversed", (a: any) => { a.memoryJobTransitions.reverse(); }],
    ["detached missing assertion", (a: any) => { a.memoryJobs[0].result.memoryOperations.shift(); syncJob(a); }],
    ["memory incomplete provenance", (a: any) => { a.memoryJobs[0].result.memoryOperations[0].sourcePerceptionIds = []; syncJob(a); }],
    ["memory wrong holder", (a: any) => { a.memoryJobs[0].result.memories[0].actorId = "cfo"; syncJob(a); }],
    ["retained belief strength", (a: any) => { a.memoryJobs[0].result.retainedBeliefs[0].strength = -3; syncJob(a); }],
    ["duplicate detached memory", (a: any) => { a.detachedMemoryOperations.push(structuredClone(a.detachedMemoryOperations[0])); }],
    ["revised memory target", (a: any) => { a.commits.find((c: any) => c.commandId === "revise").events[0].operation.revisesOperationId = "missing"; sync(a, "revise"); }],
    ["retracted memory owner", (a: any) => { a.commits.find((c: any) => c.commandId === "retract").events[0].operation.actorId = "cfo"; sync(a, "retract"); }],
  ] as const) test(name, mutate);
  await writeFile("api/tests/fixtures/archives.json", JSON.stringify({ memory: memoryArchive, complete, legacyConversionHash: hash(converted) }, null, 2) + "\n");
  await writeFile("api/tests/fixtures/archive-mutations.json", JSON.stringify(mutations, null, 2) + "\n");
} finally { store.close(); await rm(root, { recursive: true, force: true }); }
