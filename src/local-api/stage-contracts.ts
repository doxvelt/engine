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
  routingReview?: { initialAudience: string[] | null; correctedAudience: string[] | null; originalWhisper: string[]; correction: string;
    sourceDraftId: string | null; sourceAudience: string[] | null; originalDraftId: string; preserved: boolean };
};

/** Review includes explicit direction for routed candidates, never actor context or prompt. */
export function stageDraft(draft: StageDraft | ActorTurnDraftRecord): StageDraft {
  const { id, branchId, basisHeadCommitId, actorId, audience, status, artifact, failure, createdAt, generationCommandId } = draft;
  const routing = "routing" in draft ? draft.routing : undefined;
  const routingReview = routing ? { initialAudience: routing.initialAudience, correctedAudience: routing.correctedAudience,
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
  commandId: string;
  audience: string[];
  correction: string;
  preservedText?: string;
};
