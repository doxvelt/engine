export type EntityKind = "agent" | "affiliation" | "artifact" | "stateless";

export type YamlValue = string | boolean | null | string[];

export type FrontmatterData = Record<string, YamlValue>;

export type SourceFile = {
  id: string;
  path: string;
  name: string;
  data: FrontmatterData;
  body: string;
  text: string;
};

export type EntitySourceFile = SourceFile & {
  section: string;
};

export type EntitySource = {
  id: string;
  kind: EntityKind;
  rawKind: YamlValue | undefined;
  name: string;
  visibility: string;
  folder: string;
  files: EntitySourceFile[];
};

export type WorkspaceSource = {
  root: string;
  models: SourceFile[];
  worlds: SourceFile[];
  scenarios: SourceFile[];
  formats: SourceFile[];
  entities: EntitySource[];
  connections: SourceFile[];
};

export type SourceSpan = {
  file: string;
  line: number;
  quote: string;
};

export type AssetKind =
  | "model"
  | "world"
  | "scenario"
  | "format"
  | "connection";

export type AssetRecord = {
  id: string;
  kind: AssetKind;
  name: string;
  path: string;
  metadata: FrontmatterData;
  body: string;
};

export type EntityRecord = {
  id: string;
  kind: EntityKind;
  rawKind?: YamlValue;
  name: string;
  visibility: string;
  folder: string;
  files: string[];
};

export type LineRecordContext =
  | { holder: string; section: string; connectionId?: never }
  | { connectionId: string; holder?: never; section?: never };

export type TaggedLineRecord = {
  tags: string[];
  mentions: string[];
  context: LineRecordContext;
  sourceSpan: SourceSpan;
};

export type MentionRecord = {
  id: string;
  sourceSpan: SourceSpan;
};

export type BeliefRecord = {
  holder: string;
  strength: number;
  propositionText: string;
  mentions: string[];
  sourceSpan: SourceSpan;
};

export type SurfaceRecord = {
  entity: string;
  channels: string[];
  text: string;
  sourceSpan: SourceSpan;
};

export type AccessLinkRecord = {
  member: string;
  container: string;
  mode: "member";
  sourceSpan: SourceSpan;
};

export type BeliefProvenanceMode =
  | "held"
  | "accessed_through_membership"
  | "retained_after_access_loss"
  | "observed"
  | "experienced"
  | "inferred"
  | "told"
  | "briefed"
  | "read"
  | "stolen"
  | "generated"
  | "joined";

export type BeliefProvenance = {
  mode: BeliefProvenanceMode;
  holder: string;
  sourceHolder: string;
  accessPath: string[];
};

export type SubjectiveBeliefAccess = {
  belief: SubjectiveBeliefRecord;
  provenance: BeliefProvenance;
};

export type CurrentBeliefGroup = {
  key: string;
  current: SubjectiveBeliefAccess[];
  superseded: SubjectiveBeliefAccess[];
  conflicting: SubjectiveBeliefAccess[];
};

export type CurrentBeliefResolution = {
  current: SubjectiveBeliefAccess[];
  superseded: SubjectiveBeliefAccess[];
  conflicting: SubjectiveBeliefAccess[];
  groups: CurrentBeliefGroup[];
};

export type DiagnosticRecord = {
  severity: "warning" | "error";
  code: string;
  message: string;
  sourceSpans?: SourceSpan[];
};

export type CompiledWorkspace = {
  sourceRoot: string;
  models: AssetRecord[];
  worlds: AssetRecord[];
  scenarios: AssetRecord[];
  formats: AssetRecord[];
  entities: EntityRecord[];
  connections: AssetRecord[];
  mentions: MentionRecord[];
  taggedLines: TaggedLineRecord[];
  beliefs: BeliefRecord[];
  surfaces: SurfaceRecord[];
  accessLinks: AccessLinkRecord[];
  diagnostics: DiagnosticRecord[];
};

export type SimulationRecord = {
  id: string;
  ownerScope: string;
  contentRevisionId: string;
  sourceRoot: string;
  scenarioId: string | null;
  defaultBranchId: string;
  createdAt: string;
};

export type ContentRevisionRecord = {
  id: string;
  ownerScope: string;
  digest: string;
  compiled: CompiledWorkspace;
  createdAt: string;
};

export type BranchRecord = {
  id: string;
  ownerScope: string;
  simulationId: string;
  name: string | null;
  headCommitId: string;
  origin:
    | { kind: "root"; commandId: string; baseCommitId: string }
    | {
        kind: "fork" | "edit" | "regenerate";
        commandId: string;
        sourceBranchId: string;
        sourceHeadCommitId: string;
        baseCommitId: string;
      };
  createdAt: string;
};

export type CommitKind =
  | "root"
  | "turn"
  | "effects"
  | "episode_closure"
  | "memory";

export type CommitRecord = {
  id: string;
  ownerScope: string;
  simulationId: string;
  parentCommitId: string | null;
  kind: CommitKind;
  commandId: string;
  events: RuntimeEvent[];
  createdAt: string;
};

export type MessageVersionRecord = {
  id: string;
  logicalMessageId: string;
  actorId: string;
  text: string;
  audience: string[];
  provenance:
    | { mode: "manual"; operation: "turn" | "edit" | "regenerate" }
    | {
        mode: "generated";
        operation: "turn";
        sourceArtifactDigest: string;
        finalTextSource: "generated_verbatim" | "director_preserved" | "acceptor_edited";
      };
};

export type RuntimeEvent =
  | { type: "message_accepted"; message: MessageVersionRecord }
  | {
      type: "audience_changed";
      actorId: string;
      action: "add" | "remove" | "deactivate" | "reactivate";
      reason: string | null;
    }
  | {
      type: "access_changed";
      action: "grant" | "revoke";
      member: string;
      container: string;
      mode: "member";
      reason: string | null;
    }
  | {
      type: "first_impression_formed";
      impression: Omit<
        FirstImpressionRecord,
        "id" | "simulationId" | "createdAt"
      >;
    }
  | {
      type: "stage_whisper_consumed";
      whisperId: string;
      targetActorId: string;
      text: string;
    }
  | { type: "episode_closed"; closure: EpisodeClosure }
  | { type: "memory_operation"; operation: MemoryOperation };

export type CommandEnvelope<TPayload> = {
  ownerScope: string;
  simulationId: string;
  branchId: string;
  expectedHead: string;
  commandId: string;
  payload: TPayload;
};

export type ProjectionQuery = {
  ownerScope: string;
  simulationId: string;
  branchId: string;
  head?: string;
};

export type TranscriptTurn = {
  id: string;
  simulationId: string;
  commitId?: string;
  logicalMessageId?: string;
  messageVersionId?: string;
  actorId: string;
  text: string;
  audience: string[];
  episodeId: string | null;
  createdAt: string;
};

export type StageWhisperRecord = {
  id: string;
  simulationId: string;
  ownerScope: string;
  branchId: string;
  expectedHead: string;
  commandId: string;
  targetActorId: string;
  text: string;
  createdAt: string;
};

export type EpisodeRecord = {
  id: string;
  simulationId: string;
  commitId?: string;
  label: string | null;
  closedAt: string;
};

export type EpisodeMemoryRecord = {
  id: string;
  episodeId: string;
  simulationId: string;
  actorId: string;
  text: string;
  sourceTurnIds: string[];
  sourcePerceptionIds?: string[];
  sourceEventIds?: string[];
  sourceMessageVersionIds?: string[];
  createdAt: string;
};

export type LongTermMemoryRecord = {
  id: string;
  episodeId: string;
  episodeMemoryId: string;
  simulationId: string;
  actorId: string;
  text: string;
  createdAt: string;
};

export type PerceptionRecord = {
  id: string;
  simulationId: string;
  actorId: string;
  sourceCommitId: string;
  sourceEventId: string;
  sourceMessageVersionId: string;
  createdAt: string;
};

export type MemoryKind = "episode" | "long_term";
export type MemoryProducer = {
  mode: "episode_closure" | "manual" | "legacy_closure";
  commandId: string;
};
type MemoryOperationBase = {
  id: string;
  memoryId: string;
  simulationId: string;
  actorId: string;
  memoryKind: MemoryKind;
  basisCommitId: string;
  closureCommitId: string | null;
  sourcePerceptionIds: string[];
  sourceEventIds: string[];
  sourceMessageVersionIds: string[];
  producer: MemoryProducer;
  createdAt: string;
};
export type MemoryOperation =
  | (MemoryOperationBase & { type: "asserted"; content: string })
  | (MemoryOperationBase & {
      type: "consolidated";
      content: string;
      episodeMemoryId: string;
    })
  | (MemoryOperationBase & {
      type: "revised";
      content: string;
      revisesOperationId: string;
    })
  | (MemoryOperationBase & {
      type: "retracted";
      retractsOperationId: string;
    });

export type MemoryJobStatus = "pending" | "running" | "failed" | "completed";
export type MemoryJobResult = EpisodeClosure;
export type MemoryJobTransition = {
  id: string;
  jobId: string;
  ownerScope: string;
  simulationId: string;
  attempt: number;
  status: "running" | "failed" | "completed";
  resultFingerprint: string | null;
  result: MemoryJobResult | null;
  error: string | null;
  createdAt: string;
};
export type MemoryJobRecord = {
  id: string;
  ownerScope: string;
  simulationId: string;
  originBranchId: string;
  episodeId: string;
  closureCommitId: string;
  basisHeadCommitId: string;
  commandId: string;
  label: string | null;
  status: MemoryJobStatus;
  attemptCount: number;
  resultFingerprint: string | null;
  result: MemoryJobResult | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExtractedBeliefRecord = {
  id: string;
  episodeId: string;
  memoryId: string;
  simulationId: string;
  holder: string;
  strength: number;
  propositionText: string;
  createdAt: string;
};

export type RetainedBeliefRecord = {
  id: string;
  episodeId: string;
  simulationId: string;
  holder: string;
  strength: number;
  propositionText: string;
  sourceHolder: string;
  accessPath: string[];
  sourceBelief: BeliefRecord | ExtractedBeliefRecord | FirstImpressionRecord;
  runtimeAccessEventId: string;
  createdAt: string;
};

export type FirstImpressionRecord = {
  id: string;
  simulationId: string;
  holder: string;
  observerId: string;
  entityId: string;
  strength: number;
  propositionText: string;
  surfaceSourceSpan: SourceSpan;
  createdAt: string;
};

export type SubjectiveBeliefRecord =
  | BeliefRecord
  | ExtractedBeliefRecord
  | FirstImpressionRecord
  | RetainedBeliefRecord;

export type EpisodeClosure = {
  episode: EpisodeRecord;
  memories: EpisodeMemoryRecord[];
  longTermMemories: LongTermMemoryRecord[];
  extractedBeliefs: ExtractedBeliefRecord[];
  retainedBeliefs: RetainedBeliefRecord[];
  memoryOperations?: MemoryOperation[];
};

export type ActorContext = {
  simulation: {
    id: string;
    scenarioId: string | null;
    sourceRoot: string;
    branchId?: string;
    headCommitId?: string;
    contentRevisionId?: string;
  };
  actor: EntityRecord;
  assets: {
    worlds: AssetRecord[];
    scenario: AssetRecord | null;
    formats: AssetRecord[];
  };
  subjective: {
    beliefs: SubjectiveBeliefRecord[];
    beliefAccess: SubjectiveBeliefAccess[];
    beliefHistoryAccess: SubjectiveBeliefAccess[];
    beliefResolution: CurrentBeliefResolution;
    longTermMemories: LongTermMemoryRecord[];
    surfaces: SurfaceRecord[];
    transcript: TranscriptTurn[];
    stageWhispers: StageWhisperRecord[];
    currentAudience: string[];
  };
  diagnostics: DiagnosticRecord[];
  promptPreview: string;
};

export type RuntimeProfileRef = {
  id: string;
  version: string;
};

export type PromptPolicyRef = {
  id: string;
  version: string;
};

export type OutputSchemaRef = {
  id: string;
  digest: string;
};

export type DraftStageWhisperSnapshot = {
  id: string;
  text: string;
};

export type NormalizedRuntimeUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type RuntimeStopReason =
  | "stop"
  | "length"
  | "tool_use"
  | "error"
  | "aborted"
  | "other";

export type DraftRuntimeProvenance = {
  adapter: { id: string; version: string };
  runtimeProfile: RuntimeProfileRef;
  providerId: string | null;
  modelId: string | null;
  usage: NormalizedRuntimeUsage;
  stopReason: RuntimeStopReason | null;
  terminalStatus: "completed" | "failed";
};

export type ActorTurnDraftArtifact = {
  text: string;
  digest: string;
  provenance: DraftRuntimeProvenance;
  proposedAudience?: string[];
};

export const ACTOR_KNOWLEDGE_POLICY = "actor-knowledge-v1";

export type DraftRoutingInput = {
  version: 1 | 2 | 3;
  /** Required for v2/v3. Complete replacement, including an intentionally empty whisper. */
  completeWhisper?: string;
  initialAudience: string[] | null;
  correction: string;
  correctedAudience: string[] | null;
  preservedText: string | null;
  sourceDraftId: string | null;
};

export type DraftRouting = DraftRoutingInput & {
  availableRecipientIds: string[];
  originalDraftId: string;
  originalGenerationCommandId: string;
  source: null | {
    draftId: string;
    generationCommandId: string;
    actorId: string;
    branchId: string;
    basisHeadCommitId: string;
    contentRevisionId: string;
    audience: string[];
    artifact: ActorTurnDraftArtifact;
    contextHash: string;
    promptHash: string;
  };
};

export type ActorTurnDraftFailure = {
  code: "runtime_failure" | "invalid_stream";
  message: string;
  provenance: DraftRuntimeProvenance;
};

export type ActorTurnDraftStatus =
  | "generating"
  | "ready"
  | "failed"
  | "discarded"
  | "accepted";

export type ActorTurnDraftRecord = {
  routing?: DraftRouting;
  id: string;
  ownerScope: string;
  simulationId: string;
  generationCommandId: string;
  branchId: string;
  basisHeadCommitId: string;
  contentRevisionId: string;
  actorId: string;
  audience: string[];
  stageWhispers: DraftStageWhisperSnapshot[];
  runtimeProfile: RuntimeProfileRef;
  promptPolicy: PromptPolicyRef;
  outputSchema: OutputSchemaRef;
  skillDigests: string[];
  capabilityGrant: [];
  context: unknown;
  contextHash: string;
  prompt: string;
  promptHash: string;
  status: ActorTurnDraftStatus;
  artifact: ActorTurnDraftArtifact | null;
  failure: ActorTurnDraftFailure | null;
  createdAt: string;
  updatedAt: string;
};

export type AcceptDraftReceipt = {
  routing?: DraftRouting;
  receiptVersion: 1 | 2;
  draftId: string;
  generationCommandId: string;
  contentRevisionId: string;
  actorId: string;
  audience: string[];
  stageWhispers: DraftStageWhisperSnapshot[];
  runtimeProfile: RuntimeProfileRef;
  promptPolicy: PromptPolicyRef;
  outputSchema: OutputSchemaRef;
  skillDigests: string[];
  capabilityGrant: [];
  contextHash: string;
  promptHash: string;
  generatedArtifact: ActorTurnDraftArtifact;
  accepted:
    | { textSource: "generated_verbatim" | "director_preserved" }
    | { textSource: "acceptor_edited"; text: string };
};
