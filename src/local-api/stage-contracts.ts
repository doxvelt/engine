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
>;

/** Review/discovery never needs the actor's prompt, context or private direction. */
export function stageDraft(draft: StageDraft): StageDraft {
  const { id, branchId, basisHeadCommitId, actorId, audience, status, artifact, failure, createdAt, generationCommandId } = draft;
  return { id, branchId, basisHeadCommitId, actorId, audience, status, artifact, failure, createdAt, generationCommandId };
}

export type ExampleEntry = { simulationId: string; branchId: string; workspacePath: string };
