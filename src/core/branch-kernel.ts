import { compileWorkspace } from "./compiler.ts";
import {
  applyAccessChange,
  applyValidatedAccessChange,
  assertValidAccessGraph,
} from "./access-graph.ts";
import { assembleActorContext } from "./context.ts";
import { prepareCompiledRevision } from "./content-revision.ts";
import {
  foldMemoryOperations,
  legacyClosureOperations,
  operationToEpisodeMemory,
  operationToLongTermMemory,
  projectPerceptions,
} from "./memory-operations.ts";
import {
  buildAccessEvents,
  buildAudienceEvents,
  buildManualMessage,
  buildStageWhisperEvents,
  deriveFirstImpressionEvents,
  domainId,
  fingerprintCommand,
  normalizeAudience,
  recordCommand,
  resolveTurnActor,
  unwrapRecordedOutcome,
} from "./domain-rules.ts";
import {
  BranchConflictError,
  DomainNotFoundError,
  DomainValidationError,
  type ManualTurnPayload,
  type RuntimeEffectsPayload,
  type SimulationRepository,
  type StageWhisperCommand,
} from "./ports.ts";
import type {
  AccessLinkRecord,
  ActorContext,
  AssetRecord,
  BranchRecord,
  CommandEnvelope,
  CommitRecord,
  CompiledWorkspace,
  EntityRecord,
  EpisodeClosure,
  EpisodeMemoryRecord,
  FirstImpressionRecord,
  LongTermMemoryRecord,
  MemoryOperation,
  MessageVersionRecord,
  ProjectionQuery,
  RuntimeEvent,
  PerceptionRecord,
  StageWhisperRecord,
  SubjectiveBeliefRecord,
  TranscriptTurn,
} from "./types.ts";

export const LOCAL_OWNER_SCOPE = "local";

export type StartBranchSimulation = {
  ownerScope: string;
  simulationId: string;
  commandId: string;
  workspacePath: string;
  scenarioId?: string | null;
  branchId?: string;
};

export type {
  ManualTurnPayload,
  RuntimeEffectsPayload,
  StageWhisperCommand,
} from "./ports.ts";

export type BranchProjection = {
  branch: BranchRecord;
  head: CommitRecord;
  commits: CommitRecord[];
  transcript: TranscriptTurn[];
  audience: Array<{ actorId: string; status: "active" | "inactive" }>;
  accessLinks: AccessLinkRecord[];
  beliefs: SubjectiveBeliefRecord[];
  firstImpressions: FirstImpressionRecord[];
  episodeClosures: EpisodeClosure[];
  episodeMemories: EpisodeMemoryRecord[];
  longTermMemories: LongTermMemoryRecord[];
  perceptions: PerceptionRecord[];
  memoryOperations: MemoryOperation[];
};

export async function startBranchSimulation(
  repository: SimulationRepository,
  input: StartBranchSimulation,
) {
  const compiled = await compileWorkspace(input.workspacePath);
  assertNoCompilerErrors(compiled);
  return startBranchSimulationFromCompiled(repository, { ...input, compiled });
}

export function startBranchSimulationFromCompiled(
  repository: SimulationRepository,
  input: Omit<StartBranchSimulation, "workspacePath"> & {
    compiled: CompiledWorkspace;
  },
) {
  const compiled = prepareCompiledRevision(input.compiled);
  assertValidAccessGraph(compiled.accessLinks);
  const branchId =
    input.branchId ||
    domainId("branch", input.ownerScope, input.simulationId, input.commandId);
  const created = repository.startSimulation({
    ownerScope: input.ownerScope,
    simulationId: input.simulationId,
    scenarioId: input.scenarioId ?? "default",
    sourceRoot: input.compiled.sourceRoot,
    compiled,
    defaultBranchId: branchId,
    rootCommitId: domainId(
      "commit",
      input.ownerScope,
      input.simulationId,
      input.commandId,
    ),
    commandId: input.commandId,
  });
  return { ...created, compiled };
}

export function commitManualTurn(
  repository: SimulationRepository,
  command: CommandEnvelope<ManualTurnPayload>,
) {
  const recorded = recordCommand("turn", command);
  const directCommand: CommandEnvelope<ManualTurnPayload> = {
    ownerScope: recorded.ownerScope,
    simulationId: recorded.simulationId,
    branchId: recorded.branchId,
    expectedHead: recorded.expectedHead,
    commandId: recorded.commandId,
    payload: recorded.payload,
  };
  const commandFingerprint = fingerprintCommand(recorded);
  const replay = replayCommitCommand(repository, directCommand, commandFingerprint);
  if (replay) return replay;
  assertExpectedBranchHead(repository, directCommand);
  const commit = buildManualCommit(repository, directCommand);
  return repository.appendCommit({
    branchId: directCommand.branchId,
    expectedHead: directCommand.expectedHead,
    commandInput: recorded,
    commandFingerprint,
    commit,
  });
}

function buildManualCommit(
  repository: SimulationRepository,
  command: CommandEnvelope<ManualTurnPayload>,
  provenance?: {
    logicalMessageId: string;
    operation: "edit" | "regenerate";
  },
): CommitRecord {
  const text = command.payload.text.trim();
  if (!text) throw new DomainValidationError("Turn text is empty.");
  const actor = requireActor(
    repository,
    command.ownerScope,
    command.simulationId,
    command.payload.actorId,
  );
  const audience = normalizeAudience(actor.id, command.payload.audience);
  for (const audienceActorId of audience)
    requireActor(
      repository,
      command.ownerScope,
      command.simulationId,
      audienceActorId,
    );
  const message = buildManualMessage({
    ownerScope: command.ownerScope,
    simulationId: command.simulationId,
    commandId: command.commandId,
    actorId: actor.id,
    text,
    audience,
    logicalMessageId: provenance?.logicalMessageId || domainId(
      "message",
      command.ownerScope,
      command.simulationId,
      command.commandId,
    ),
    operation: provenance?.operation || "turn",
  });
  const events: RuntimeEvent[] = [{ type: "message_accepted", message }];
  for (const change of command.payload.audienceChanges || []) {
    requireActor(
      repository,
      command.ownerScope,
      command.simulationId,
      change.actorId,
    );
    events.push(...buildAudienceEvents([change]));
  }
  const projected = projectBranch(repository, {
    ownerScope: command.ownerScope,
    simulationId: command.simulationId,
    branchId: command.branchId,
    head: command.expectedHead,
  });
  let effectiveAccess = projected.accessLinks;
  for (const change of command.payload.accessChanges || []) {
    requireEntity(
      repository,
      command.ownerScope,
      command.simulationId,
      change.member,
    );
    requireEntity(
      repository,
      command.ownerScope,
      command.simulationId,
      change.container,
    );
    effectiveAccess = applyValidatedAccessChange(effectiveAccess, change);
    events.push(...buildAccessEvents([change]));
  }
  const revision = requireRevision(
    repository,
    command.ownerScope,
    command.simulationId,
  );
  events.push(...deriveFirstImpressionEvents({
    audience,
    surfaces: revision.compiled.surfaces,
    existing: projected.firstImpressions,
  }));
  const pendingWhispers = repository.listPendingStageWhispers(
    command.ownerScope,
    command.simulationId,
    command.branchId,
    command.expectedHead,
    actor.id,
  );
  const selectedWhispers = selectStageWhispers(
    pendingWhispers,
    command.payload.stageWhisperIds,
  );
  events.push(...buildStageWhisperEvents({
    ownerScope: command.ownerScope,
    simulationId: command.simulationId,
    commandId: command.commandId,
    actorId: actor.id,
    selected: selectedWhispers,
    inline: command.payload.stageWhisper,
  }));
  const commit: CommitRecord = {
    id: domainId(
      "commit",
      command.ownerScope,
      command.simulationId,
      command.commandId,
    ),
    ownerScope: command.ownerScope,
    simulationId: command.simulationId,
    parentCommitId: command.expectedHead,
    kind: "turn",
    commandId: command.commandId,
    events,
    createdAt: new Date().toISOString(),
  };
  return commit;
}

function selectStageWhispers(
  pendingWhispers: StageWhisperRecord[],
  requestedIds: string[] | undefined,
): StageWhisperRecord[] {
  if (requestedIds === undefined) return pendingWhispers;
  if (
    !Array.isArray(requestedIds) ||
    !requestedIds.every((id) => typeof id === "string" && id.length > 0)
  )
    throw new DomainValidationError(
      "stageWhisperIds must contain non-empty strings.",
    );
  if (new Set(requestedIds).size !== requestedIds.length)
    throw new DomainValidationError(
      "stageWhisperIds must not contain duplicates.",
    );
  const pendingById = new Map(
    pendingWhispers.map((whisper) => [String(whisper.id), whisper]),
  );
  return requestedIds.map((id) => {
    const whisper = pendingById.get(id);
    if (!whisper)
      throw new DomainValidationError(
        `Stage whisper ${id} is not pending for this actor and branch head.`,
      );
    return whisper;
  });
}

export function commitRuntimeEffects(
  repository: SimulationRepository,
  command: CommandEnvelope<RuntimeEffectsPayload>,
) {
  const recorded = recordCommand("effects", command);
  const commandFingerprint = fingerprintCommand(recorded);
  const replay = replayCommitCommand(repository, command, commandFingerprint);
  if (replay) return replay;
  assertExpectedBranchHead(repository, command);
  const projection = projectBranch(repository, {
    ownerScope: command.ownerScope,
    simulationId: command.simulationId,
    branchId: command.branchId,
    head: command.expectedHead,
  });
  const events: RuntimeEvent[] = [];
  for (const change of command.payload.audienceChanges || []) {
    requireActor(
      repository,
      command.ownerScope,
      command.simulationId,
      change.actorId,
    );
    events.push(...buildAudienceEvents([change]));
  }
  let accessLinks = projection.accessLinks;
  for (const change of command.payload.accessChanges || []) {
    requireEntity(
      repository,
      command.ownerScope,
      command.simulationId,
      change.member,
    );
    requireEntity(
      repository,
      command.ownerScope,
      command.simulationId,
      change.container,
    );
    accessLinks = applyValidatedAccessChange(accessLinks, change);
    events.push(...buildAccessEvents([change]));
  }
  if (!events.length)
    throw new DomainValidationError("Runtime effects command has no effects.");
  const commit: CommitRecord = {
    id: domainId(
      "commit",
      command.ownerScope,
      command.simulationId,
      command.commandId,
    ),
    ownerScope: command.ownerScope,
    simulationId: command.simulationId,
    parentCommitId: command.expectedHead,
    kind: "effects",
    commandId: command.commandId,
    events,
    createdAt: new Date().toISOString(),
  };
  return repository.appendCommit({
    branchId: command.branchId,
    expectedHead: command.expectedHead,
    commandInput: recorded,
    commandFingerprint,
    commit,
  });
}

export function editAcceptedMessage(
  repository: SimulationRepository,
  input: Omit<CommandEnvelope<ManualTurnPayload>, "branchId"> & {
    sourceBranchId: string;
    sourceCommitId: string;
    branchId: string;
    branchName?: string;
  },
) {
  const recorded = recordCommand("edit", input);
  const commandFingerprint = fingerprintCommand(recorded);
  const replay = replayCommitCommand(repository, input, commandFingerprint);
  if (replay) return replay;
  assertExpectedBranchHead(repository, {
    ownerScope: input.ownerScope,
    simulationId: input.simulationId,
    branchId: input.sourceBranchId,
    expectedHead: input.expectedHead,
  });
  assertCommitOnSourceBranch(repository, input);
  const source = repository.getCommit(
    input.ownerScope,
    input.simulationId,
    input.sourceCommitId,
  );
  if (!source)
    throw new DomainNotFoundError(
      `Source commit not found: ${input.sourceCommitId}`,
    );
  const original = source.events.find(
    (event) => event.type === "message_accepted",
  );
  if (!original || original.type !== "message_accepted")
    throw new DomainValidationError("Source commit has no accepted message.");
  if (input.payload.actorId !== original.message.actorId)
    throw new DomainValidationError(
      "An edited message must retain its original actor.",
    );
  const parent = source.parentCommitId;
  if (!parent)
    throw new DomainValidationError("The root commit cannot be edited.");
  const commit = buildManualCommit(repository, {
    ownerScope: input.ownerScope,
    simulationId: input.simulationId,
    branchId: input.sourceBranchId,
    expectedHead: parent,
    commandId: input.commandId,
    payload: { ...input.payload },
  }, {
    logicalMessageId: original.message.logicalMessageId,
    operation: "edit",
  });
  return repository.appendCommitToNewBranch({
    sourceBranchId: input.sourceBranchId,
    expectedHead: input.expectedHead,
    branchId: input.branchId,
    name: input.branchName || "edit",
    atCommitId: parent,
    originKind: "edit",
    commandInput: recorded,
    commandFingerprint,
    commit,
  });
}

export function regenerateAcceptedResponse(
  repository: SimulationRepository,
  input: Omit<CommandEnvelope<ManualTurnPayload>, "branchId"> & {
    sourceBranchId: string;
    sourceCommitId: string;
    branchId: string;
    branchName?: string;
  },
) {
  const recorded = recordCommand("regenerate", input);
  const commandFingerprint = fingerprintCommand(recorded);
  const replay = replayCommitCommand(repository, input, commandFingerprint);
  if (replay) return replay;
  assertExpectedBranchHead(repository, {
    ownerScope: input.ownerScope,
    simulationId: input.simulationId,
    branchId: input.sourceBranchId,
    expectedHead: input.expectedHead,
  });
  assertCommitOnSourceBranch(repository, input);
  const source = repository.getCommit(
    input.ownerScope,
    input.simulationId,
    input.sourceCommitId,
  );
  if (!source)
    throw new DomainNotFoundError(
      `Source commit not found: ${input.sourceCommitId}`,
    );
  const original = source.events.find(
    (event) => event.type === "message_accepted",
  );
  if (!original || original.type !== "message_accepted")
    throw new DomainValidationError("Source commit has no accepted message.");
  if (input.payload.actorId !== original.message.actorId)
    throw new DomainValidationError(
      "A regenerated response must retain its original actor.",
    );
  const parent = source.parentCommitId;
  if (!parent)
    throw new DomainValidationError("The root commit cannot be regenerated.");
  const commit = buildManualCommit(repository, {
    ownerScope: input.ownerScope,
    simulationId: input.simulationId,
    branchId: input.sourceBranchId,
    expectedHead: parent,
    commandId: input.commandId,
    payload: { ...input.payload },
  }, {
    logicalMessageId: original.message.logicalMessageId,
    operation: "regenerate",
  });
  return repository.appendCommitToNewBranch({
    sourceBranchId: input.sourceBranchId,
    expectedHead: input.expectedHead,
    branchId: input.branchId,
    name: input.branchName || "regenerate",
    atCommitId: parent,
    originKind: "regenerate",
    commandInput: recorded,
    commandFingerprint,
    commit,
  });
}

export function forkBranch(
  repository: SimulationRepository,
  input: {
    ownerScope: string;
    simulationId: string;
    sourceBranchId: string;
    expectedHead: string;
    atCommitId: string;
    branchId: string;
    commandId: string;
    name?: string | null;
  },
) {
  const recorded = recordCommand("fork", input);
  const commandFingerprint = fingerprintCommand(recorded);
  const replay = repository.replayCommand(
    input.ownerScope,
    input.simulationId,
    input.commandId,
    commandFingerprint,
  );
  const replayValue = replay
    ? unwrapRecordedOutcome(replay) as { branch: BranchRecord }
    : null;
  if (replayValue) return { ...replayValue, replayed: true };
  assertExpectedBranchHead(repository, {
    ownerScope: input.ownerScope,
    simulationId: input.simulationId,
    branchId: input.sourceBranchId,
    expectedHead: input.expectedHead,
  });
  return repository.createBranch(input);
}

export function stageWhisper(
  repository: SimulationRepository,
  command: StageWhisperCommand,
): StageWhisperRecord {
  const normalizedCommand = { ...command, text: command.text.trim() };
  const recorded = recordCommand("whisper", normalizedCommand);
  const commandFingerprint = fingerprintCommand(recorded);
  const replay = repository.replayCommand(
    command.ownerScope,
    command.simulationId,
    command.commandId,
    commandFingerprint,
  );
  if (replay) return unwrapRecordedOutcome(replay) as StageWhisperRecord;
  assertExpectedBranchHead(repository, command);
  requireActor(
    repository,
    command.ownerScope,
    command.simulationId,
    command.targetActorId,
  );
  const text = normalizedCommand.text;
  if (!text) throw new DomainValidationError("Stage whisper text is empty.");
  return repository.createStageWhisper(normalizedCommand);
}

export function assertExpectedBranchHead(
  repository: SimulationRepository,
  input: {
    ownerScope: string;
    simulationId: string;
    branchId: string;
    expectedHead: string;
  },
): BranchRecord {
  const branch = repository.getBranch(
    input.ownerScope,
    input.simulationId,
    input.branchId,
  );
  if (!branch)
    throw new DomainNotFoundError(`Branch not found: ${input.branchId}`);
  if (branch.headCommitId !== input.expectedHead)
    throw new BranchConflictError(input.expectedHead, branch.headCommitId);
  return branch;
}

function replayCommitCommand(
  repository: SimulationRepository,
  command: { ownerScope: string; simulationId: string; commandId: string },
  commandFingerprint: string,
): { branch: BranchRecord; commit: CommitRecord; replayed: boolean } | null {
  const recordedReplay = repository.replayCommand(
    command.ownerScope,
    command.simulationId,
    command.commandId,
    commandFingerprint,
  );
  const replay = recordedReplay
    ? unwrapRecordedOutcome(recordedReplay) as {
        branch: BranchRecord;
        commit: CommitRecord;
      }
    : null;
  return replay ? { ...replay, replayed: true } : null;
}

export function projectBranch(
  repository: SimulationRepository,
  query: ProjectionQuery,
): BranchProjection {
  const branch = repository.getBranch(
    query.ownerScope,
    query.simulationId,
    query.branchId,
  );
  if (!branch)
    throw new DomainNotFoundError(`Branch not found: ${query.branchId}`);
  const selectedHead = query.head || branch.headCommitId;
  if (
    !repository.getCommit(query.ownerScope, query.simulationId, selectedHead)
  )
    throw new DomainNotFoundError(`Commit not found: ${selectedHead}`);
  const branchAncestry = new Set(
    repository
      .listAncestors(query.ownerScope, query.simulationId, branch.headCommitId)
      .map((item) => item.id),
  );
  if (!branchAncestry.has(selectedHead))
    throw new DomainValidationError(
      `Commit ${selectedHead} is not an ancestor of branch ${query.branchId}.`,
    );
  const commits = repository.listAncestors(
    query.ownerScope,
    query.simulationId,
    selectedHead,
  );
  const revision = requireRevision(
    repository,
    query.ownerScope,
    query.simulationId,
  );
  const transcript: TranscriptTurn[] = [];
  const audience = new Map<string, "active" | "inactive">();
  let accessLinks = [...revision.compiled.accessLinks];
  const beliefs: SubjectiveBeliefRecord[] = [...revision.compiled.beliefs];
  const firstImpressions: FirstImpressionRecord[] = [];
  const episodeClosures: EpisodeClosure[] = [];
  const episodeMemories: EpisodeMemoryRecord[] = [];
  const longTermMemories: LongTermMemoryRecord[] = [];
  const memoryOperations: MemoryOperation[] = [];
  const detachedOperations = repository.listDetachedMemoryOperations(
    query.ownerScope, query.simulationId,
  );
  const completedClosureResults = new Map(
    repository.listMemoryJobs(query.ownerScope, query.simulationId)
      .filter((job) => job.status === "completed" && job.result)
      .map((job) => [job.closureCommitId, job.result!]),
  );
  for (const commit of commits)
    for (const event of commit.events) {
      switch (event.type) {
        case "message_accepted":
          transcript.push({
            id: event.message.id,
            messageVersionId: event.message.id,
            logicalMessageId: event.message.logicalMessageId,
            commitId: commit.id,
            simulationId: query.simulationId,
            actorId: event.message.actorId,
            text: event.message.text,
            audience: event.message.audience,
            episodeId: null,
            createdAt: commit.createdAt,
          });
          break;
        case "audience_changed":
          if (event.action === "remove") audience.delete(event.actorId);
          else
            audience.set(
              event.actorId,
              event.action === "deactivate" ? "inactive" : "active",
            );
          break;
        case "access_changed":
          accessLinks = applyAccessChange(accessLinks, event);
          break;
        case "first_impression_formed": {
          const impression: FirstImpressionRecord = {
            ...event.impression,
            id: `${commit.id}:impression:${firstImpressions.length}`,
            simulationId: query.simulationId,
            createdAt: commit.createdAt,
          };
          firstImpressions.push(impression);
          beliefs.push(impression);
          break;
        }
        case "stage_whisper_consumed":
          break;
        case "episode_closed": {
          const closure = structuredClone(
            completedClosureResults.get(commit.id) || event.closure,
          );
          for (const turn of transcript) {
            if (turn.episodeId === null)
              turn.episodeId = closure.episode.id;
          }
          episodeClosures.push(closure);
          const late = detachedOperations.filter(
            (operation) => operation.closureCommitId === commit.id,
          );
          memoryOperations.push(...(late.length ? late : legacyClosureOperations(commit)));
          beliefs.push(
            ...closure.extractedBeliefs,
            ...closure.retainedBeliefs,
          );
          break;
        }
        case "memory_operation":
          memoryOperations.push(event.operation);
          break;
        default:
          assertNever(event);
      }
    }
  const activeMemories = foldMemoryOperations(memoryOperations).active;
  const originalEpisodeMemories = episodeClosures.flatMap((item) => item.memories);
  const originalLongTermMemories = episodeClosures.flatMap(
    (item) => item.longTermMemories,
  );
  episodeMemories.push(...activeMemories
    .filter((operation) => operation.memoryKind === "episode")
    .map((operation) => operationToEpisodeMemory(
      operation,
      originalEpisodeMemories.find((item) => item.id === operation.memoryId),
    )));
  longTermMemories.push(...activeMemories
    .filter((operation) => operation.memoryKind === "long_term")
    .map((operation) => operationToLongTermMemory(
      operation,
      originalLongTermMemories.find((item) => item.id === operation.memoryId),
    )));
  return {
    branch: { ...branch, headCommitId: selectedHead },
    head: commits.at(-1)!,
    commits,
    transcript,
    audience: [...audience].map(([actorId, status]) => ({ actorId, status })),
    accessLinks,
    beliefs,
    firstImpressions,
    episodeClosures,
    episodeMemories,
    longTermMemories,
    perceptions: projectPerceptions(commits),
    memoryOperations,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported runtime event: ${JSON.stringify(value)}`);
}

export function inspectActorContext(
  repository: SimulationRepository,
  query: ProjectionQuery & {
    actorId: string;
    audience?: string[];
    stageWhispers?: StageWhisperRecord[];
    turns?: TranscriptTurn[];
  },
): ActorContext {
  const projection = projectBranch(repository, query);
  const revision = requireRevision(
    repository,
    query.ownerScope,
    query.simulationId,
  );
  const simulation = repository.getSimulation(
    query.ownerScope,
    query.simulationId,
  )!;
  const actor = revision.compiled.entities.find(
    (item) => item.id === query.actorId,
  );
  if (!actor)
    throw new DomainNotFoundError(`Actor not found: ${query.actorId}`);
  const activeAudience =
    query.audience ||
    projection.audience
      .filter((item) => item.status === "active")
      .map((item) => item.actorId);
  for (const audienceActorId of activeAudience)
    requireActor(
      repository,
      query.ownerScope,
      query.simulationId,
      audienceActorId,
    );
  const observedEntityIds = activeAudience.filter((item) => item !== actor.id);
  const turns =
    query.turns ||
    projection.transcript.filter((turn) => turn.audience.includes(actor.id));
  return assembleActorContext({
    simulation,
    actor,
    worlds: revision.compiled.worlds,
    scenario: simulation.scenarioId
      ? revision.compiled.scenarios.find(
          (item) => item.id === simulation.scenarioId,
        ) || null
      : null,
    formats: revision.compiled.formats,
    beliefs: projection.beliefs,
    accessLinks: projection.accessLinks,
    surfaces: revision.compiled.surfaces,
    longTermMemories: projection.longTermMemories.filter(
      (item) => item.actorId === actor.id,
    ),
    observedEntityIds,
    currentAudience: [actor.id, ...observedEntityIds],
    turns,
    stageWhispers: query.stageWhispers || [],
  });
}

function assertCommitOnSourceBranch(
  repository: SimulationRepository,
  input: {
    ownerScope: string;
    simulationId: string;
    sourceBranchId: string;
    sourceCommitId: string;
    expectedHead: string;
  },
): void {
  const sourceBranch = repository.getBranch(
    input.ownerScope,
    input.simulationId,
    input.sourceBranchId,
  );
  if (!sourceBranch)
    throw new DomainNotFoundError(
      `Source branch not found: ${input.sourceBranchId}`,
    );
  const sourceIsAncestor = repository
    .listAncestors(input.ownerScope, input.simulationId, input.expectedHead)
    .some((commit) => commit.id === input.sourceCommitId);
  if (!sourceIsAncestor) {
    throw new DomainValidationError(
      `Source commit ${input.sourceCommitId} is not on source branch ${input.sourceBranchId}.`,
    );
  }
}

function requireRevision(
  repository: SimulationRepository,
  ownerScope: string,
  simulationId: string,
) {
  const simulation = repository.getSimulation(ownerScope, simulationId);
  if (!simulation)
    throw new DomainNotFoundError(`Simulation not found: ${simulationId}`);
  const revision = repository.getContentRevision(
    ownerScope,
    simulation.contentRevisionId,
  );
  if (!revision)
    throw new DomainNotFoundError(
      `Content revision not found: ${simulation.contentRevisionId}`,
    );
  return revision;
}
function requireActor(
  repository: SimulationRepository,
  ownerScope: string,
  simulationId: string,
  actorId: string,
): EntityRecord {
  const actor = requireRevision(
    repository,
    ownerScope,
    simulationId,
  ).compiled.entities.find((item) => item.id === actorId);
  if (!actor || !resolveTurnActor([actor], actorId))
    throw new DomainNotFoundError(`Actor not found: ${actorId}`);
  return actor;
}
function requireEntity(
  repository: SimulationRepository,
  ownerScope: string,
  simulationId: string,
  entityId: string,
): EntityRecord {
  const entity = requireRevision(
    repository,
    ownerScope,
    simulationId,
  ).compiled.entities.find((item) => item.id === entityId);
  if (!entity) throw new DomainNotFoundError(`Entity not found: ${entityId}`);
  return entity;
}
export { applyAccessChange, fingerprintCommand };
function assertNoCompilerErrors(compiled: {
  diagnostics: Array<{ severity: string; message: string }>;
}): void {
  const errors = compiled.diagnostics.filter(
    (item) => item.severity === "error",
  );
  if (errors.length)
    throw new Error(
      [
        "Cannot start Doxvelt simulation because compilation produced errors.",
        ...errors.map((item) => `- ${item.message}`),
      ].join("\n"),
    );
}
