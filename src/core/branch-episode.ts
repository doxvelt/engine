import {
  fingerprintCommand,
  assertExpectedBranchHead,
  inspectActorContext,
  projectBranch,
} from "./branch-kernel.ts";
import {
  canHoldEpisodeMemory,
  domainId,
  recordCommand,
  unwrapRecordedOutcome,
} from "./domain-rules.ts";
import { deriveRetainedBeliefs, runtimeEventId } from "./retained-beliefs.ts";
import type { SimulationRepository } from "./ports.ts";
import { DomainNotFoundError, DomainValidationError } from "./ports.ts";
import type {
  ActorContext,
  BranchRecord,
  CommandEnvelope,
  CommitRecord,
  EntityRecord,
  EpisodeClosure,
  EpisodeMemoryRecord,
  ExtractedBeliefRecord,
  LongTermMemoryRecord,
  MemoryOperation,
  RetainedBeliefRecord,
  TranscriptTurn,
} from "./types.ts";

export type ExtractedBeliefCandidate = {
  strength: number;
  propositionText: string;
};
export type EpisodeMemoryGenerationInput = {
  actor: EntityRecord;
  context: ActorContext;
  turns: TranscriptTurn[];
  label: string | null;
};
export type EpisodeBeliefExtractionInput = {
  actor: EntityRecord;
  context: ActorContext;
  memory: EpisodeMemoryRecord;
};
export type EpisodeClosureGenerator = {
  writeMemory(input: EpisodeMemoryGenerationInput): Promise<string> | string;
  writeLongTermMemory?(
    input: EpisodeBeliefExtractionInput,
  ): Promise<string | null> | string | null;
  extractBeliefs(
    input: EpisodeBeliefExtractionInput,
  ): Promise<ExtractedBeliefCandidate[]> | ExtractedBeliefCandidate[];
};

export async function closeBranchEpisode(
  repository: SimulationRepository,
  command: CommandEnvelope<{ label?: string | null }>,
  generator: EpisodeClosureGenerator = deterministicEpisodeClosureGenerator,
) {
  command = {
    ...command,
    payload: { ...command.payload, label: command.payload.label?.trim() || null },
  };
  const recorded = recordCommand("closure", command);
  const commandFingerprint = fingerprintCommand(recorded);
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
  if (replay) {
    const event = replay.commit.events.find(
      (item) => item.type === "episode_closed",
    );
    if (!event || event.type !== "episode_closed")
      throw new Error("Replayed closure command has no closure event.");
    return { ...replay, replayed: true, closure: event.closure };
  }
  assertExpectedBranchHead(repository, command);
  const projection = projectBranch(repository, {
    ownerScope: command.ownerScope,
    simulationId: command.simulationId,
    branchId: command.branchId,
    head: command.expectedHead,
  });
  const lastClosureIndex = projection.commits.findLastIndex((commit) =>
    commit.events.some((event) => event.type === "episode_closed"),
  );
  const openCommitIds = new Set(
    projection.commits.slice(lastClosureIndex + 1).map((item) => item.id),
  );
  const turns = projection.transcript.filter(
    (turn) => turn.commitId && openCommitIds.has(turn.commitId),
  );
  if (!turns.length)
    throw new DomainValidationError(
      `No unclosed turns to close for simulation: ${command.simulationId}`,
    );
  const simulation = repository.getSimulation(
    command.ownerScope,
    command.simulationId,
  );
  if (!simulation)
    throw new DomainNotFoundError(
      `Simulation not found: ${command.simulationId}`,
    );
  const revision = repository.getContentRevision(
    command.ownerScope,
    simulation.contentRevisionId,
  );
  if (!revision)
    throw new DomainNotFoundError(
      `Content revision not found: ${simulation.contentRevisionId}`,
    );
  const episodeId = id("episode", command.commandId);
  const createdAt = new Date().toISOString();
  const memories: EpisodeMemoryRecord[] = [];
  const longTermMemories: LongTermMemoryRecord[] = [];
  const extractedBeliefs: ExtractedBeliefRecord[] = [];
  const retainedBeliefs: RetainedBeliefRecord[] = [];
  const memoryOperations: MemoryOperation[] = [];
  const actors = revision.compiled.entities.filter(
    canHoldEpisodeMemory,
  );
  for (const actor of actors) {
    const accessibleTurns = turns.filter((turn) =>
      turn.audience.includes(actor.id),
    );
    if (!accessibleTurns.length) continue;
    const context = inspectActorContext(repository, {
      ownerScope: command.ownerScope,
      simulationId: command.simulationId,
      branchId: command.branchId,
      head: command.expectedHead,
      actorId: actor.id,
      turns: accessibleTurns,
    });
    const perceptions = projection.perceptions.filter(
      (item) => item.actorId === actor.id && openCommitIds.has(item.sourceCommitId),
    );
    const memoryText = (
      await generator.writeMemory({
        actor,
        context,
        turns: accessibleTurns,
        label: command.payload.label || null,
      })
    ).trim();
    if (!memoryText)
      throw new DomainValidationError("Episode memory content is empty.");
    const memory: EpisodeMemoryRecord = {
      id: id("episode_memory", command.commandId, actor.id),
      episodeId,
      simulationId: command.simulationId,
      actorId: actor.id,
      text: memoryText,
      sourceTurnIds: accessibleTurns.map((item) => item.id),
      sourcePerceptionIds: perceptions.map((item) => item.id),
      sourceEventIds: perceptions.map((item) => item.sourceEventId),
      sourceMessageVersionIds: perceptions.map(
        (item) => item.sourceMessageVersionId,
      ),
      createdAt,
    };
    memories.push(memory);
    const longText = (
      await generator.writeLongTermMemory?.({ actor, context, memory })
    )?.trim();
    if (longText)
      longTermMemories.push({
        id: id("long_memory", command.commandId, actor.id),
        episodeId,
        episodeMemoryId: memory.id,
        simulationId: command.simulationId,
        actorId: actor.id,
        text: longText,
        createdAt,
      });
    for (const candidate of await generator.extractBeliefs({ actor, context, memory })) {
      if (!candidate.propositionText.trim()) continue;
      const index = extractedBeliefs.filter(
        (belief) => belief.holder === actor.id,
      ).length;
      extractedBeliefs.push({
        id: id("belief", command.commandId, actor.id, String(index)),
        episodeId,
        memoryId: memory.id,
        simulationId: command.simulationId,
        holder: actor.id,
        strength: normalizeStrength(candidate.strength),
        propositionText: candidate.propositionText.trim(),
        createdAt,
      });
    }
  }
  retainedBeliefs.push(...deriveRetainedBeliefs({
    simulationId: command.simulationId,
    commandId: command.commandId,
    episodeId,
    createdAt,
    entities: revision.compiled.entities,
    initialBeliefs: revision.compiled.beliefs,
    initialAccessLinks: revision.compiled.accessLinks,
    ancestry: projection.commits,
  }));
  const closure: EpisodeClosure = {
    episode: {
      id: episodeId,
      simulationId: command.simulationId,
      label: command.payload.label || null,
      closedAt: createdAt,
    },
    memories,
    longTermMemories,
    extractedBeliefs,
    retainedBeliefs,
    memoryOperations,
  };
  const commit = {
    id: id(
      "commit",
      command.ownerScope,
      command.simulationId,
      command.commandId,
    ),
    ownerScope: command.ownerScope,
    simulationId: command.simulationId,
    parentCommitId: command.expectedHead,
    kind: "episode_closure" as const,
    commandId: command.commandId,
    events: [{ type: "episode_closed" as const, closure }],
    createdAt,
  };
  closure.episode.commitId = commit.id;
  for (const memory of memories) {
    memoryOperations.push({
      id: id("memory_operation", commit.id, memory.id, "asserted"),
      memoryId: memory.id,
      simulationId: command.simulationId,
      actorId: memory.actorId,
      memoryKind: "episode",
      type: "asserted",
      content: memory.text,
      basisCommitId: command.expectedHead,
      closureCommitId: commit.id,
      sourcePerceptionIds: memory.sourcePerceptionIds || [],
      sourceEventIds: memory.sourceEventIds || [],
      sourceMessageVersionIds: memory.sourceMessageVersionIds || [],
      producer: { mode: "episode_closure", commandId: command.commandId },
      createdAt,
    });
  }
  for (const memory of longTermMemories) {
    const episodeMemory = memories.find((item) => item.id === memory.episodeMemoryId)!;
    memoryOperations.push({
      id: id("memory_operation", commit.id, memory.id, "consolidated"),
      memoryId: memory.id,
      simulationId: command.simulationId,
      actorId: memory.actorId,
      memoryKind: "long_term",
      type: "consolidated",
      content: memory.text,
      episodeMemoryId: memory.episodeMemoryId,
      basisCommitId: command.expectedHead,
      closureCommitId: commit.id,
      sourcePerceptionIds: episodeMemory.sourcePerceptionIds || [],
      sourceEventIds: episodeMemory.sourceEventIds || [],
      sourceMessageVersionIds: episodeMemory.sourceMessageVersionIds || [],
      producer: { mode: "episode_closure", commandId: command.commandId },
      createdAt,
    });
  }
  return {
    ...repository.appendCommit({
      branchId: command.branchId,
      expectedHead: command.expectedHead,
      commandInput: recorded,
      commandFingerprint,
      commit,
    }),
    closure,
  };
}
export { runtimeEventId };

export const deterministicEpisodeClosureGenerator: EpisodeClosureGenerator = {
  writeMemory({ actor, turns, label }) {
    const lines = turns
      .map((turn) => `${turn.actorId}: ${turn.text}`)
      .join(" ");
    return `I am @${actor.id}. ${label ? `In ${label}, ` : ""}I remember ${lines}`;
  },
  extractBeliefs({ memory }) {
    return [
      {
        strength: 1,
        propositionText: `@${memory.actorId} experienced an episode with ${memory.sourceTurnIds.length} accessible turn(s).`,
      },
    ];
  },
};
function normalizeStrength(value: number) {
  if (value >= 3) return 3;
  if (value > 0) return 1;
  if (value <= -3) return -3;
  if (value < 0) return -1;
  return 0;
}
function id(kind: string, ...parts: string[]) {
  return domainId(kind, ...parts);
}
