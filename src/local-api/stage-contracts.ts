export { ACTOR_KNOWLEDGE_POLICY } from "../core/types.ts";
import type { ActorTurnDraftRecord, BranchRecord, TranscriptTurn } from "../core/types.ts";

export type StageActor = { id: string; name: string; kind: string };
export type StageProjection = {
  scenarioName: string;
  branch: BranchRecord;
  transcript: TranscriptTurn[];
  audience: { actorId: string; status: string }[];
  actors: StageActor[];
};
export type StageDraft = Pick<ActorTurnDraftRecord,
  "id" | "branchId" | "basisHeadCommitId" | "actorId" | "audience" |
  "status" | "artifact" | "failure" | "createdAt" | "generationCommandId"
> & {
  routingReview?: { completeWhisper?: string | null; initialAudience: string[] | null; correctedAudience: string[] | null; originalWhisper: string[]; correction: string;
    sourceDraftId: string | null; sourceAudience: string[] | null; originalDraftId: string; preserved: boolean };
};

/** Review includes explicit direction for routed candidates, never actor context or prompt. */
export function stageDraft(draft: StageDraft | ActorTurnDraftRecord): StageDraft {
  const { id, branchId, basisHeadCommitId, actorId, audience, status, artifact, failure, createdAt, generationCommandId } = draft;
  const routing = "routing" in draft ? draft.routing : undefined;
  const snapshots = "stageWhispers" in draft ? draft.stageWhispers : [];
  const routingReview = routing ? { completeWhisper: (routing.version === 2 || routing.version === 3) ? routing.completeWhisper!
    : routing.sourceDraftId !== null || snapshots.length > 1 ? null : snapshots[0]?.text ?? "", initialAudience: routing.initialAudience, correctedAudience: routing.correctedAudience,
    originalWhisper: (draft as ActorTurnDraftRecord).stageWhispers.map(item => item.text),
    correction: routing.correction, sourceDraftId: routing.sourceDraftId, sourceAudience: routing.source?.audience || null,
    originalDraftId: routing.originalDraftId, preserved: routing.preservedText !== null }
    : "routingReview" in draft ? draft.routingReview : undefined;
  return { id, branchId, basisHeadCommitId, actorId,
    audience: artifact?.proposedAudience || audience, status, artifact, failure, createdAt, generationCommandId,
    ...(routingReview ? { routingReview } : {}) };

}

export type ExampleEntry = { simulationId: string; branchId: string; workspacePath: string };

export type ReviseStageDraftBody = {
  draftingPolicy?: typeof import("../core/types.ts").ACTOR_KNOWLEDGE_POLICY;
  commandId: string;
  audience: string[] | null;
  completeWhisper: string;
  preservedText?: string;
};

export type GenerateStageDraftBody = {
  commandId: string; branchId: string; expectedHead: string; actorId: string;
  audience: string[] | null; stageWhisperIds: string[];
  draftingPolicy: typeof import("../core/types.ts").ACTOR_KNOWLEDGE_POLICY;
  completeWhisper: string;
};

export type PerformStageTurnBody = {
  commandId: string; branchId: string; expectedHead: string; actorId: string;
  audience: string[]; manualText: string; stageWhisperIds: string[];
  knowledgePolicy: typeof import("../core/types.ts").ACTOR_KNOWLEDGE_POLICY;
};

/** Historical discovery/detail expose references and safe output, never input receipts. */
export function stageAlternative(operation: import("../core/saved-alternatives.ts").AlternativeRecord) {
  const r = operation.request;
  return { id: operation.id, commandId: r.commandId, sourceBranchId: r.sourceBranchId, expectedHead: r.expectedHead,
    sourceCommitId: r.sourceCommitId, messageVersionId: r.messageVersionId, logicalMessageId: r.logicalMessageId,
    actorId: r.actorId, action: r.action, retryOf: r.retryOf ?? null, parentCommitId: operation.parentCommitId,
    status: operation.status, failure: operation.failure, outcome: operation.outcome,
    createdAt: operation.createdAt, updatedAt: operation.updatedAt };
}

export function stageAlternativeDetail(operation: import("../core/saved-alternatives.ts").AlternativeRecord,
  repository: import("../core/ports.ts").SimulationRepository) {
  const outcome = operation.outcome;
  const message = outcome ? repository.getCommit(operation.request.ownerScope, operation.request.simulationId, outcome.commitId)
    ?.events.find(event => event.type === "message_accepted") : null;
  const receipt = outcome ? repository.exportSimulation(operation.request.ownerScope, operation.request.simulationId).commandResults
    .find(item => item.commandId === operation.request.commandId)?.canonicalInput : null;
  const artifact = operation.draft?.artifact ?? (receipt?.kind === "saved_alternative" ? receipt.payload.generated?.generatedArtifact : null);
  return { ...stageAlternative(operation), review: {
    completeWhisper: operation.completeWhisper,
    text: message?.type === "message_accepted" ? message.message.text : artifact?.text ?? operation.request.manualText ?? null,
    audience: message?.type === "message_accepted" ? message.message.audience : artifact?.proposedAudience ?? operation.request.audience,
    attribution: operation.request.action === "manual" ? "manual" : "generated",
    runtime: artifact ? { adapter: artifact.provenance.adapter, providerId: artifact.provenance.providerId,
      modelId: artifact.provenance.modelId } : null,
  } };
}

export type SavedAlternativeBody = Omit<import("../core/saved-alternatives.ts").AlternativeRequest, "ownerScope" | "simulationId">;
export type HistoricalOriginBody = import("../core/saved-alternatives.ts").HistoricalSelection;
export type StageAlternative = ReturnType<typeof stageAlternative>;
export type StageAlternativeDetail = ReturnType<typeof stageAlternativeDetail>;
export type StageAcceptedOutcome = { branch: { id: string; headCommitId: string }; commit: { id: string }; replayed: boolean };
