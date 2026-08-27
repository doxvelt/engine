import { domainId, fingerprintCommand, recordCommand, unwrapRecordedOutcome } from "./domain-rules.ts";
import { assertExpectedBranchHead, projectBranch } from "./branch-kernel.ts";
import {
  DomainNotFoundError,
  DomainValidationError,
  type RetractMemoryPayload,
  type ReviseMemoryPayload,
  type SimulationRepository,
} from "./ports.ts";
import type {
  BranchRecord,
  CommandEnvelope,
  CommitRecord,
  EpisodeMemoryRecord,
  LongTermMemoryRecord,
  MemoryOperation,
  PerceptionRecord,
} from "./types.ts";
import { runtimeEventId } from "./retained-beliefs.ts";

export { runtimeEventId };

export function projectPerceptions(commits: CommitRecord[]): PerceptionRecord[] {
  const result: PerceptionRecord[] = [];
  for (const commit of commits)
    commit.events.forEach((event, index) => {
      if (event.type !== "message_accepted") return;
      const sourceEventId = runtimeEventId(commit.id, index);
      for (const actorId of event.message.audience)
        result.push({
          id: domainId("perception", actorId, sourceEventId, event.message.id),
          simulationId: commit.simulationId,
          actorId,
          sourceCommitId: commit.id,
          sourceEventId,
          sourceMessageVersionId: event.message.id,
          createdAt: commit.createdAt,
        });
    });
  return result;
}

export function legacyClosureOperations(commit: CommitRecord): MemoryOperation[] {
  const closureEvent = commit.events.find((event) => event.type === "episode_closed");
  if (!closureEvent || closureEvent.type !== "episode_closed") return [];
  if (closureEvent.closure.memoryOperations)
    return closureEvent.closure.memoryOperations;
  const common = (actorId: string, memoryId: string) => ({
    memoryId,
    simulationId: commit.simulationId,
    actorId,
    basisCommitId: commit.parentCommitId!,
    closureCommitId: commit.id,
    sourcePerceptionIds: [] as string[],
    sourceEventIds: [] as string[],
    sourceMessageVersionIds: [] as string[],
    producer: { mode: "legacy_closure" as const, commandId: commit.commandId },
    createdAt: commit.createdAt,
  });
  return [
    ...closureEvent.closure.memories.map((memory) => ({
      ...common(memory.actorId, memory.id),
      id: domainId("memory_operation", commit.id, memory.id, "asserted"),
      memoryKind: "episode" as const,
      type: "asserted" as const,
      content: memory.text,
    })),
    ...closureEvent.closure.longTermMemories.map((memory) => ({
      ...common(memory.actorId, memory.id),
      id: domainId("memory_operation", commit.id, memory.id, "consolidated"),
      memoryKind: "long_term" as const,
      type: "consolidated" as const,
      content: memory.text,
      episodeMemoryId: memory.episodeMemoryId,
    })),
  ];
}

export function foldMemoryOperations(operations: MemoryOperation[]): {
  current: Map<string, MemoryOperation>;
  active: MemoryOperation[];
} {
  const current = new Map<string, MemoryOperation>();
  for (const operation of operations) current.set(operation.memoryId, operation);
  return {
    current,
    active: [...current.values()].filter((operation) => operation.type !== "retracted"),
  };
}

export function operationToEpisodeMemory(
  operation: MemoryOperation,
  original?: EpisodeMemoryRecord,
): EpisodeMemoryRecord {
  if (operation.type === "retracted") throw new Error("Retracted memory is inactive.");
  return {
    id: operation.memoryId,
    episodeId: original?.episodeId || operation.closureCommitId || operation.basisCommitId,
    simulationId: operation.simulationId,
    actorId: operation.actorId,
    text: operation.content,
    sourceTurnIds: original?.sourceTurnIds || operation.sourceMessageVersionIds,
    sourcePerceptionIds: operation.sourcePerceptionIds,
    sourceEventIds: operation.sourceEventIds,
    sourceMessageVersionIds: operation.sourceMessageVersionIds,
    createdAt: operation.createdAt,
  };
}

export function operationToLongTermMemory(
  operation: MemoryOperation,
  original?: LongTermMemoryRecord,
): LongTermMemoryRecord {
  if (operation.type === "retracted") throw new Error("Retracted memory is inactive.");
  return {
    id: operation.memoryId,
    episodeId: original?.episodeId || operation.closureCommitId || operation.basisCommitId,
    episodeMemoryId: original?.episodeMemoryId || (operation.type === "consolidated" ? operation.episodeMemoryId : operation.memoryId),
    simulationId: operation.simulationId,
    actorId: operation.actorId,
    text: operation.content,
    createdAt: operation.createdAt,
  };
}

export function reviseMemory(
  repository: SimulationRepository,
  command: CommandEnvelope<ReviseMemoryPayload>,
) {
  return mutateMemory(repository, "revise_memory", command);
}

export function retractMemory(
  repository: SimulationRepository,
  command: CommandEnvelope<RetractMemoryPayload>,
) {
  return mutateMemory(repository, "retract_memory", command);
}

function mutateMemory(
  repository: SimulationRepository,
  kind: "revise_memory" | "retract_memory",
  command: CommandEnvelope<ReviseMemoryPayload | RetractMemoryPayload>,
) {
  if (kind === "revise_memory")
    command = {
      ...command,
      payload: {
        ...command.payload,
        content: (command.payload as ReviseMemoryPayload).content.trim(),
      },
    };
  const recorded = recordCommand(kind, command) as Extract<
    import("./ports.ts").RecordedCommand,
    { kind: typeof kind }
  >;
  const fingerprint = fingerprintCommand(recorded);
  const prior = repository.replayCommand(
    command.ownerScope, command.simulationId, command.commandId, fingerprint,
  );
  if (prior) {
    const result = unwrapRecordedOutcome(prior) as { branch: BranchRecord; commit: CommitRecord };
    return { ...result, replayed: true };
  }
  assertExpectedBranchHead(repository, command);
  const projection = projectBranch(repository, command);
  const current = projection.memoryOperations
    .filter((operation) => operation.memoryId === command.payload.memoryId)
    .at(-1);
  if (!current)
    throw new DomainNotFoundError(`Memory not found: ${command.payload.memoryId}`);
  if (current.actorId !== command.payload.actorId)
    throw new DomainValidationError("An actor cannot change another actor's memory.");
  if (current.type === "retracted")
    throw new DomainValidationError("Memory is already retracted.");
  const targetId = kind === "revise_memory"
    ? (command.payload as ReviseMemoryPayload).revisesOperationId
    : (command.payload as RetractMemoryPayload).retractsOperationId;
  if (targetId !== current.id)
    throw new DomainValidationError("Memory operation chain is stale.");
  const content = kind === "revise_memory"
    ? (command.payload as ReviseMemoryPayload).content
    : null;
  if (kind === "revise_memory" && !content)
    throw new DomainValidationError("Replacement memory content is empty.");
  const createdAt = new Date().toISOString();
  const base = {
    id: domainId("memory_operation", command.ownerScope, command.simulationId, command.commandId),
    memoryId: current.memoryId,
    simulationId: current.simulationId,
    actorId: current.actorId,
    memoryKind: current.memoryKind,
    basisCommitId: command.expectedHead,
    closureCommitId: null,
    sourcePerceptionIds: current.sourcePerceptionIds,
    sourceEventIds: current.sourceEventIds,
    sourceMessageVersionIds: current.sourceMessageVersionIds,
    producer: { mode: "manual" as const, commandId: command.commandId },
    createdAt,
  };
  const operation: MemoryOperation = kind === "revise_memory"
    ? { ...base, type: "revised", content: content!, revisesOperationId: current.id }
    : { ...base, type: "retracted", retractsOperationId: current.id };
  const commit: CommitRecord = {
    id: domainId("commit", command.ownerScope, command.simulationId, command.commandId),
    ownerScope: command.ownerScope,
    simulationId: command.simulationId,
    parentCommitId: command.expectedHead,
    kind: "memory",
    commandId: command.commandId,
    events: [{ type: "memory_operation", operation }],
    createdAt,
  };
  return repository.appendCommit({
    branchId: command.branchId,
    expectedHead: command.expectedHead,
    commandInput: recorded,
    commandFingerprint: fingerprint,
    commit,
  });
}
