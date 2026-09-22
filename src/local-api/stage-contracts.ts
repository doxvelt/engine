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
