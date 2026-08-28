import type {
  NormalizedRuntimeUsage,
  OutputSchemaRef,
  PromptPolicyRef,
  RuntimeProfileRef,
  RuntimeStopReason,
} from "../core/types.ts";

export type RuntimeAdapterIdentity = {
  id: string;
  version: string;
};

/** Token fields are write-once fragments; later events may add missing fields or repeat identical values. */
export type RuntimeUsageFragment = Partial<NormalizedRuntimeUsage>;

export type RuntimeCompletion = {
  text: string;
  usage?: RuntimeUsageFragment;
  stopReason?: RuntimeStopReason | null;
};

export type AgentRuntimeEvent =
  | { type: "text_delta"; text: string }
  | { type: "usage"; usage: RuntimeUsageFragment }
  | { type: "tool_requested"; name: string }
  | { type: "tool_completed"; name: string }
  | ({ type: "completed" } & RuntimeCompletion)
  | ({ type: "failed" } & Omit<RuntimeCompletion, "text"> & { message?: string });

export type RunActorTurnRequest = Readonly<{
  draftId: string;
  ownerScope: string;
  simulationId: string;
  branchId: string;
  basisHeadCommitId: string;
  contentRevisionId: string;
  actorId: string;
  audience: readonly string[];
  context: unknown;
  contextHash: string;
  prompt: string;
  promptHash: string;
  runtimeProfile: Readonly<RuntimeProfileRef>;
  promptPolicy: Readonly<PromptPolicyRef>;
  outputSchema: Readonly<OutputSchemaRef>;
  skillDigests: readonly string[];
  capabilityGrant: readonly [];
}>;

export interface ActorTurnRuntime {
  readonly identity: RuntimeAdapterIdentity;
  runActorTurn(
    request: RunActorTurnRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentRuntimeEvent>;
}
