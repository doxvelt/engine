import type { ActorTurnRuntime } from "../agent-runtime/contracts.ts";
import { generateActorTurnDraft } from "./draft-lifecycle.ts";
import { buildAcceptedCommit, receiptFor, validateReadyDraft } from "./draft-acceptance.ts";
import { buildManualCommit } from "./branch-kernel.ts";
import { domainId, normalizeAudience, stableStringify } from "./domain-rules.ts";
import { assertRuntimeText, decodeAcceptDraftReceipt, requiredSafeIdentifier, sha256 } from "./draft-contracts.ts";
import { BranchConflictError, CommandIdentityError, DomainNotFoundError, DomainValidationError } from "./ports.ts";
import type { ActorTurnDraftRepository, SimulationRepository } from "./ports.ts";
import type { AcceptDraftReceipt, ActorTurnDraftRecord, BranchRecord, CommitRecord } from "./types.ts";

export type HistoricalSelection = {
  sourceBranchId: string; expectedHead: string; sourceCommitId: string;
  messageVersionId: string; logicalMessageId: string; actorId: string;
};
export type AlternativeRequest = HistoricalSelection & {
  ownerScope: string; simulationId: string; commandId: string;
  action: "generate" | "manual"; audience: string[] | null;
  completeWhisper?: string; manualText?: string; retryOf?: string;
};
export type OriginInput = {
  kind: "generated" | "manual" | "unavailable";
  state: "complete" | "none" | "legacy" | "unavailable";
  completeWhisper: string | null;
  recordedWhispers: { id: string; text: string }[];
  legacyCorrection: string | null;
};
export type AlternativeReceipt = {
  version: 1; request: AlternativeRequest; parentCommitId: string; contentRevisionId: string;
  completeWhisper: string | null; origin: OriginInput; generated: AcceptDraftReceipt | null;
  retrySource: { request: AlternativeRequest; promptHash: string | null; contextHash: string | null } | null;
};
export type AlternativeRecord = {
  id: string; request: AlternativeRequest; fingerprint: string;
  parentCommitId: string; contentRevisionId: string; completeWhisper: string | null; origin: OriginInput;
  status: "pending" | "failed" | "saved" | "discarded";
  failure: "generation_failed" | "validation_failed" | null;
  draft: ActorTurnDraftRecord | null; outcome: { branchId: string; commitId: string } | null;
  createdAt: string; updatedAt: string;
};
export type AlternativeCommand = {
  kind: "saved_alternative"; ownerScope: string; simulationId: string; commandId: string;
  branchId: string; sourceBranchId: string; expectedHead: string; sourceCommitId: string;
  payload: AlternativeReceipt;
};
export interface SavedAlternativeRepository extends SimulationRepository, ActorTurnDraftRepository {
  getAlternative(owner: string, simulation: string, id: string): AlternativeRecord | null;
  listAlternatives(owner: string, simulation: string): AlternativeRecord[];
  reserveAlternative(record: AlternativeRecord): { operation: AlternativeRecord; replayed: boolean };
  updateAlternativeDraft(record: AlternativeRecord, draft: ActorTurnDraftRecord): AlternativeRecord;
  settleAlternative(owner: string, simulation: string, id: string, status: "failed" | "discarded", failure?: AlternativeRecord["failure"]): AlternativeRecord;
  saveAlternative(record: AlternativeRecord): AlternativeRecord;
}
export const alternativeId = (r: Pick<AlternativeRequest, "ownerScope" | "simulationId" | "commandId">) => domainId("saved_alternative", r.ownerScope, r.simulationId, r.commandId);
export const alternativeBranchId = (r: AlternativeRequest) => domainId("alternative_branch", r.ownerScope, r.simulationId, r.commandId);
const equal = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

export function validateAlternativeRequest(value: unknown): AlternativeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainValidationError("Invalid historical request.");
  const r = value as AlternativeRequest;
  const keys = ["ownerScope", "simulationId", "commandId", "sourceBranchId", "expectedHead", "sourceCommitId", "messageVersionId", "logicalMessageId", "actorId", "action", "audience", "completeWhisper", "manualText", "retryOf"];
  if (Object.keys(r).some(k => !keys.includes(k))) throw new DomainValidationError("Unknown historical request field.");
  for (const key of keys.slice(0, 9) as (keyof AlternativeRequest)[]) requiredSafeIdentifier(r[key], key);
  if (!["generate", "manual"].includes(r.action)) throw new DomainValidationError("Invalid historical action.");
  if (r.audience !== null && (!Array.isArray(r.audience) || r.audience.some(id => typeof id !== "string") || new Set(r.audience).size !== r.audience.length))
    throw new DomainValidationError("Invalid historical audience.");
  for (const id of r.audience || []) requiredSafeIdentifier(id, "audience");
  if (r.completeWhisper !== undefined && (typeof r.completeWhisper !== "string" || r.completeWhisper.length > 100_000)) throw new DomainValidationError("Invalid complete whisper.");
  if (r.retryOf !== undefined) requiredSafeIdentifier(r.retryOf, "retryOf");
  if (r.action === "manual") {
    assertRuntimeText(r.manualText, "Manual performance");
    if (!r.audience || r.completeWhisper !== undefined || r.retryOf !== undefined) throw new DomainValidationError("Manual editing requires concrete audience and performance only.");
  } else if (r.manualText !== undefined) throw new DomainValidationError("Generation cannot supply manual text.");
  return structuredClone(r);
}

export function resolveHistoricalSelection(repository: Pick<SimulationRepository, "getBranch" | "listAncestors">, r: AlternativeRequest | (HistoricalSelection & { ownerScope: string; simulationId: string }), guard = true) {
  const branch = repository.getBranch(r.ownerScope, r.simulationId, r.sourceBranchId);
  if (!branch) throw new DomainNotFoundError("Historical source not found.");
  if (guard && branch.headCommitId !== r.expectedHead) throw new BranchConflictError(r.expectedHead, branch.headCommitId);
  const path = repository.listAncestors(r.ownerScope, r.simulationId, branch.headCommitId);
  if (!path.some(c => c.id === r.expectedHead)) throw new DomainValidationError("Historical guard is not on source path.");
  const selected = repository.listAncestors(r.ownerScope, r.simulationId, r.expectedHead).find(c => c.id === r.sourceCommitId);
  const messages = selected?.events.filter(e => e.type === "message_accepted") || [];
  if (!selected?.parentCommitId || selected.kind !== "turn" || messages.length !== 1 || messages[0]?.type !== "message_accepted") throw new DomainValidationError("Selection must be an accepted turn on the source path.");
  const message = messages[0].message;
  if (message.id !== r.messageVersionId || message.logicalMessageId !== r.logicalMessageId || message.actorId !== r.actorId)
    throw new DomainValidationError("Historical selection identity mismatch.");
  return { selected, message, parentCommitId: selected.parentCommitId };
}
export function assertSupportedHistoricalEffects(commit: CommitRecord) {
  if (commit.events.some(e => !["message_accepted", "first_impression_formed", "stage_whisper_consumed"].includes(e.type)))
    throw new DomainValidationError("Historical replacement of explicit world/access/audience changes is unsupported pending policy.");
}

/** Exact recorded input only; operational draft rows are deliberately irrelevant. */
export function originatingInput(repository: Pick<SimulationRepository, "getBranch" | "listAncestors" | "exportSimulation">, r: HistoricalSelection & { ownerScope: string; simulationId: string }): OriginInput {
  const { selected, message } = resolveHistoricalSelection(repository, r, false);
  const archive = repository.exportSimulation(r.ownerScope, r.simulationId);
  const command = archive.commandResults.find(c => c.commandId === selected.commandId)?.canonicalInput;
  const snapshots = selected.events.flatMap(e => e.type === "stage_whisper_consumed" ? [{ id: e.whisperId, text: e.text }] : []);
  if (command?.kind === "saved_alternative") {
    const receipt = command.payload;
    return { kind: receipt.generated ? "generated" : "manual", state: receipt.completeWhisper === null ? "none" : "complete",
      completeWhisper: receipt.completeWhisper, recordedWhispers: snapshots, legacyCorrection: null };
  }
  if (command?.kind === "accept_draft") {
    const receipt = command.payload;
    if (!equal(receipt.stageWhispers, snapshots) || receipt.actorId !== message.actorId)
      return { kind: "unavailable", state: "unavailable", completeWhisper: null, recordedWhispers: [], legacyCorrection: null };
    const routing = receipt.routing;
    const complete = routing?.version === 2 || routing?.version === 3 ? routing.completeWhisper!
      : routing?.sourceDraftId || snapshots.length > 1 ? null : snapshots[0]?.text ?? "";
    return { kind: "generated", state: complete === null ? "legacy" : snapshots.length || complete ? "complete" : "none",
      completeWhisper: complete, recordedWhispers: snapshots, legacyCorrection: routing?.version === 1 ? routing.correction : null };
  }
  if (message.provenance.mode === "manual" && command && ["turn", "edit", "regenerate"].includes(command.kind))
    return { kind: "manual", state: snapshots.length > 1 ? "legacy" : snapshots.length ? "complete" : "none",
      completeWhisper: snapshots.length === 1 ? snapshots[0]!.text : null, recordedWhispers: snapshots, legacyCorrection: null };
  return { kind: "unavailable", state: "unavailable", completeWhisper: null, recordedWhispers: [], legacyCorrection: null };
}

/** A projection-only repository view supplies the immutable parent to existing draft validation.
 * Writes are redirected to the durable historical operation; no temporary playable branch exists. */
export function historicalDraftRepository(repository: SavedAlternativeRepository, record: AlternativeRecord): SavedAlternativeRepository {
  const r = record.request;
  const current = () => repository.getAlternative(r.ownerScope, r.simulationId, record.id)!;
  const overrides: Partial<SavedAlternativeRepository> = {
    getBranch(owner, simulation, branch) {
      const actual = repository.getBranch(owner, simulation, branch);
      return actual && owner === r.ownerScope && simulation === r.simulationId && branch === r.sourceBranchId
        ? { ...actual, headCommitId: record.parentCommitId } : actual;
    },
    getActorTurnDraft(owner, simulation, id) {
      const draft = current().draft;
      return owner === r.ownerScope && simulation === r.simulationId && draft?.id === id ? draft : null;
    },
    reserveActorTurnDraft({ draft }) {
      const before = current();
      if (before.draft) return { draft: before.draft, replayed: true };
      const saved = repository.updateAlternativeDraft(record, draft);
      if (!saved.draft) throw new DomainValidationError("Historical operation is terminal.");
      return { draft: saved.draft, replayed: false };
    },
    completeActorTurnDraft(_owner, _simulation, _id, artifact) {
      const before = current();
      const draft = { ...before.draft!, artifact, failure: null, status: "ready" as const, updatedAt: new Date().toISOString() };
      return repository.updateAlternativeDraft(record, draft).draft!;
    },
    failActorTurnDraft(_owner, _simulation, _id, failure) {
      const before = current();
      const draft = { ...before.draft!, artifact: null, failure, status: "failed" as const, updatedAt: new Date().toISOString() };
      return repository.updateAlternativeDraft(record, draft).draft!;
    },
    listPendingStageWhispers() { return []; },
  };
  return new Proxy(repository, { get(target, key) {
    const value = key in overrides ? overrides[key as keyof typeof overrides] : Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

export async function createSavedAlternative(repository: SavedAlternativeRepository, runtime: ActorTurnRuntime | undefined, input: AlternativeRequest) {
  const request = validateAlternativeRequest(input);
  const id = alternativeId(request), fingerprint = sha256(stableStringify(request));
  const existing = repository.getAlternative(request.ownerScope, request.simulationId, id);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new CommandIdentityError(request.commandId);
    return { operation: existing, replayed: true };
  }
  const selection = resolveHistoricalSelection(repository, request);
  assertSupportedHistoricalEffects(selection.selected);
  const simulation = repository.getSimulation(request.ownerScope, request.simulationId)!;
  const origin = originatingInput(repository, request);
  const completeWhisper = request.action === "manual" ? null : request.completeWhisper ?? origin.completeWhisper;
  if (request.action === "generate" && completeWhisper === null) throw new DomainValidationError("Origin requires an explicit complete replacement whisper (empty is permitted).");
  if (request.retryOf) {
    const source = repository.getAlternative(request.ownerScope, request.simulationId, request.retryOf);
    if (!source || source.request.action !== "generate" || !["failed", "discarded"].includes(source.status)) throw new DomainValidationError("Retry requires failed or discarded historical work.");
    const { commandId: _a, retryOf: _b, ...old } = source.request;
    const { commandId: _c, retryOf: _d, ...next } = request;
    if (!equal(old, next) || completeWhisper !== source.completeWhisper) throw new DomainValidationError("Retry must repeat the frozen historical request.");
  }
  if (request.action === "generate" && !runtime) throw new DomainValidationError("No actor-turn runtime configured.");
  const createdAt = new Date().toISOString();
  const reserved = repository.reserveAlternative({ id, request, fingerprint, parentCommitId: selection.parentCommitId,
    contentRevisionId: simulation.contentRevisionId, completeWhisper, origin, status: "pending", failure: null,
    draft: null, outcome: null, createdAt, updatedAt: createdAt });
  if (reserved.replayed) return reserved;
  try {
    if (request.action === "generate") {
      const view = historicalDraftRepository(repository, reserved.operation);
      const generationCommandId = domainId("alternative_generation", id);
      await generateActorTurnDraft(view, runtime!, {
        ownerScope: request.ownerScope, simulationId: request.simulationId, branchId: request.sourceBranchId,
        expectedHead: selection.parentCommitId, commandId: generationCommandId,
        payload: { actorId: request.actorId, audience: normalizeAudience(request.actorId, request.audience ?? []),
          stageWhisperIds: [], runtimeProfile: { id: "local-character", version: "v1" },
          promptPolicy: { id: "actor-knowledge-v1", version: "v1" }, outputSchema: { id: "audience-proposal", digest: "v1" }, skillDigests: [],
          routing: { version: 4, completeWhisper: completeWhisper!, initialAudience: null, correctedAudience: request.audience,
            correction: "", preservedText: null, sourceDraftId: null } },
      });
      const completed = repository.getAlternative(request.ownerScope, request.simulationId, id)!;
      if (completed.status !== "pending") return { operation: completed, replayed: false };
      if (completed.draft?.status !== "ready" || completed.draft.artifact?.provenance.stopReason === "length") return { operation: repository.settleAlternative(request.ownerScope, request.simulationId, id, "failed", "generation_failed"), replayed: false };
    }
    return { operation: repository.saveAlternative(repository.getAlternative(request.ownerScope, request.simulationId, id)!), replayed: false };
  } catch {
    return { operation: repository.settleAlternative(request.ownerScope, request.simulationId, id, "failed", "validation_failed"), replayed: false };
  }
}

export function buildAlternativeCommit(repository: SavedAlternativeRepository, operation: AlternativeRecord): { command: AlternativeCommand; commit: CommitRecord } {
  const r = operation.request;
  const selected = resolveHistoricalSelection(repository, r);
  assertSupportedHistoricalEffects(selected.selected);
  if (selected.parentCommitId !== operation.parentCommitId) throw new DomainValidationError("Historical parent mismatch.");
  const view = historicalDraftRepository(repository, operation);
  let generated: AcceptDraftReceipt | null = null;
  let commit: CommitRecord;
  if (r.action === "generate") {
    const draft = operation.draft;
    if (!draft || draft.branchId !== r.sourceBranchId || draft.basisHeadCommitId !== operation.parentCommitId ||
        draft.ownerScope !== r.ownerScope || draft.simulationId !== r.simulationId || draft.actorId !== r.actorId)
      throw new DomainValidationError("Historical candidate basis mismatch.");
    const validated = validateReadyDraft(view, { ownerScope: r.ownerScope, simulationId: r.simulationId, draftId: operation.draft!.id, commandId: r.commandId }, operation.draft!);
    generated = receiptFor(validated.draft, validated.acceptedText);
    commit = buildAcceptedCommit(view, validated.draft, generated, r.commandId, operation.createdAt);
    const event = commit.events[0]!;
    if (event.type !== "message_accepted") throw new DomainValidationError("Missing replacement message.");
    event.message.logicalMessageId = r.logicalMessageId;
    event.message.provenance.operation = "regenerate";
    commit.events.push({ type: "stage_whisper_consumed", whisperId: domainId("alternative_input", operation.id), targetActorId: r.actorId, text: operation.completeWhisper! });
  } else {
    commit = buildManualCommit(repository, { ownerScope: r.ownerScope, simulationId: r.simulationId, branchId: r.sourceBranchId,
      expectedHead: operation.parentCommitId, commandId: r.commandId,
      payload: { actorId: r.actorId, text: r.manualText!, audience: r.audience!, stageWhisperIds: [], knowledgePolicy: "actor-knowledge-v1" } },
    { logicalMessageId: r.logicalMessageId, operation: "edit" });
    commit.createdAt = operation.createdAt;
  }
  const retry = r.retryOf ? repository.getAlternative(r.ownerScope, r.simulationId, r.retryOf) : null;
  const command: AlternativeCommand = { kind: "saved_alternative", ownerScope: r.ownerScope, simulationId: r.simulationId,
    commandId: r.commandId, branchId: alternativeBranchId(r), sourceBranchId: r.sourceBranchId,
    expectedHead: r.expectedHead, sourceCommitId: r.sourceCommitId,
    payload: { version: 1, request: r, parentCommitId: operation.parentCommitId, contentRevisionId: operation.contentRevisionId,
      completeWhisper: operation.completeWhisper, origin: operation.origin, generated,
      retrySource: retry ? { request: retry.request, promptHash: retry.draft?.promptHash ?? null, contextHash: retry.draft?.contextHash ?? null } : null } };
  decodeAlternativeCommand(command);
  if (!equal(operation.origin, originatingInput(repository, r))) throw new DomainValidationError("Historical origin changed.");
  return { command, commit };
}

export function alternativeFromReceipt(command: AlternativeCommand, branch: BranchRecord, commit: CommitRecord): AlternativeRecord {
  const p = command.payload;
  return { id: alternativeId(p.request), request: p.request, fingerprint: sha256(stableStringify(p.request)), parentCommitId: p.parentCommitId,
    contentRevisionId: p.contentRevisionId, completeWhisper: p.completeWhisper, origin: p.origin, status: "saved", failure: null,
    draft: null, outcome: { branchId: branch.id, commitId: commit.id }, createdAt: commit.createdAt, updatedAt: commit.createdAt };
}

export function decodeAlternativeCommand(value: unknown): AlternativeCommand {
  const c = value as AlternativeCommand;
  const exact = (v: unknown, keys: string[]) => {
    if (!v || typeof v !== "object" || Array.isArray(v) || !equal(Object.keys(v).sort(), keys.sort())) throw new DomainValidationError("Invalid saved alternative receipt fields.");
  };
  exact(c, ["kind", "ownerScope", "simulationId", "commandId", "branchId", "sourceBranchId", "expectedHead", "sourceCommitId", "payload"]);
  exact(c.payload, ["version", "request", "parentCommitId", "contentRevisionId", "completeWhisper", "origin", "generated", "retrySource"]);
  const p = c.payload, r = validateAlternativeRequest(p.request);
  exact(p.origin, ["kind", "state", "completeWhisper", "recordedWhispers", "legacyCorrection"]);
  if (c.kind !== "saved_alternative" || p.version !== 1 || c.ownerScope !== r.ownerScope || c.simulationId !== r.simulationId || c.commandId !== r.commandId ||
    c.branchId !== alternativeBranchId(r) || c.sourceBranchId !== r.sourceBranchId || c.sourceCommitId !== r.sourceCommitId || c.expectedHead !== r.expectedHead)
    throw new DomainValidationError("Historical receipt identity mismatch.");
  if (r.retryOf) {
    exact(p.retrySource, ["request", "promptHash", "contextHash"]);
    const source = validateAlternativeRequest(p.retrySource!.request);
    const { commandId: _a, retryOf: _b, ...before } = source;
    const { commandId: _c, retryOf: _d, ...after } = r;
    if (alternativeId(source) !== r.retryOf || source.commandId === r.commandId || !equal(before, after) ||
        p.retrySource!.promptHash !== null && p.retrySource!.promptHash !== p.generated?.promptHash ||
        p.retrySource!.contextHash !== null && p.retrySource!.contextHash !== p.generated?.contextHash)
      throw new DomainValidationError("Historical retry receipt mismatch.");
  } else if (p.retrySource !== null) throw new DomainValidationError("Unexpected historical retry provenance.");
  requiredSafeIdentifier(p.parentCommitId, "parent"); requiredSafeIdentifier(p.contentRevisionId, "content revision");
  if (r.action === "generate") {
    decodeAcceptDraftReceipt(p.generated);
    if (typeof p.completeWhisper !== "string" || p.generated?.routing?.version !== 4 || p.generated.routing.completeWhisper !== p.completeWhisper ||
      p.generated.routing.source !== null || p.generated.routing.sourceDraftId !== null || p.generated.routing.preservedText !== null ||
      p.generated.stageWhispers.length || p.generated.actorId !== r.actorId || p.generated.contentRevisionId !== p.contentRevisionId ||
      p.generated.generatedArtifact.provenance.stopReason === "length" ||
      p.generated.accepted.textSource !== "generated_verbatim" || !equal(p.generated.routing.correctedAudience, r.audience) ||
      p.generated.generationCommandId !== domainId("alternative_generation", alternativeId(r)) ||
      p.generated.draftId !== domainId("actor_turn_draft", r.ownerScope, r.simulationId, p.generated.generationCommandId))
      throw new DomainValidationError("Historical generated receipt mismatch.");
  } else if (p.generated !== null || p.completeWhisper !== null) throw new DomainValidationError("Manual edit cannot claim generation.");
  return c;
}

/** Discovery follows actual paths, including later forks of either continuation. */
export function discoverSavedAlternatives(repository: SavedAlternativeRepository, selection: HistoricalSelection & { ownerScope: string; simulationId: string }) {
  const { parentCommitId } = resolveHistoricalSelection(repository, selection, false);
  const archive = repository.exportSimulation(selection.ownerScope, selection.simulationId);
  const operations = repository.listAlternatives(selection.ownerScope, selection.simulationId)
    .filter(op => op.parentCommitId === parentCommitId && op.request.logicalMessageId === selection.logicalMessageId);
  const paths = archive.branches.flatMap(branch => {
    const replacement = repository.listAncestors(selection.ownerScope, selection.simulationId, branch.headCommitId)
      .find(c => c.parentCommitId === parentCommitId && c.events.some(e => e.type === "message_accepted" && e.message.logicalMessageId === selection.logicalMessageId));
    const message = replacement?.events.find(e => e.type === "message_accepted");
    return replacement && message?.type === "message_accepted" ? [{ branchId: branch.id, headCommitId: branch.headCommitId,
      commitId: replacement.id, messageVersionId: message.message.id, logicalMessageId: message.message.logicalMessageId,
      actorId: message.message.actorId, text: message.message.text, audience: message.message.audience }] : [];
  });
  return { parentCommitId, operations, paths };
}
