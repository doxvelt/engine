import { createHash } from "node:crypto";
import {
  assertExpectedBranchHead,
  inspectActorContext,
  projectBranch,
} from "./branch-kernel.ts";
import {
  canHoldEpisodeMemory,
  domainId,
  fingerprintCommand,
  recordCommand,
  stableStringify,
  unwrapRecordedOutcome,
} from "./domain-rules.ts";
import { deriveRetainedBeliefs, runtimeEventId } from "./retained-beliefs.ts";
import {
  DomainNotFoundError,
  DomainValidationError,
  type SimulationRepository,
} from "./ports.ts";
import type {
  ActorContext,
  CommandEnvelope,
  EntityRecord,
  EpisodeClosure,
  EpisodeMemoryRecord,
  ExtractedBeliefRecord,
  LongTermMemoryRecord,
  MemoryJobRecord,
  MemoryOperation,
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

export function requestEpisodeClosure(
  repository: SimulationRepository,
  command: CommandEnvelope<{ label?: string | null }>,
) {
  const normalized = {
    ...command,
    payload: { label: command.payload.label?.trim() || null },
  };
  const recorded = recordCommand("closure", normalized);
  const commandFingerprint = fingerprintCommand(recorded);
  const replay = repository.replayCommand(
    command.ownerScope,
    command.simulationId,
    command.commandId,
    commandFingerprint,
  );
  if (replay) {
    const prior = unwrapRecordedOutcome(replay) as {
      branch: import("./types.ts").BranchRecord;
      commit: import("./types.ts").CommitRecord;
    };
    const job = repository.getMemoryJob(
      command.ownerScope,
      command.simulationId,
      domainId(
        "memory_job",
        command.ownerScope,
        command.simulationId,
        command.commandId,
      ),
    );
    if (!job) throw new Error("Replayed closure has no memory job.");
    return { ...prior, job, replayed: true };
  }
  assertExpectedBranchHead(repository, normalized);
  const projection = projectBranch(repository, {
    ...normalized,
    head: normalized.expectedHead,
  });
  const lastClosure = projection.commits.findLastIndex(
    (commit) => commit.kind === "episode_closure",
  );
  if (
    !projection.commits
      .slice(lastClosure + 1)
      .some((commit) =>
        commit.events.some((event) => event.type === "message_accepted"),
      )
  )
    throw new DomainValidationError(
      `No unclosed turns to close for simulation: ${command.simulationId}`,
    );
  const createdAt = new Date().toISOString();
  const commitId = domainId(
    "commit",
    command.ownerScope,
    command.simulationId,
    command.commandId,
  );
  const episodeId = domainId("episode", command.commandId);
  const closure: EpisodeClosure = {
    episode: {
      id: episodeId,
      simulationId: command.simulationId,
      commitId,
      label: normalized.payload.label,
      closedAt: createdAt,
    },
    memories: [],
    longTermMemories: [],
    extractedBeliefs: [],
    retainedBeliefs: [],
    memoryOperations: [],
  };
  const commit = {
    id: commitId,
    ownerScope: command.ownerScope,
    simulationId: command.simulationId,
    parentCommitId: command.expectedHead,
    kind: "episode_closure" as const,
    commandId: command.commandId,
    events: [{ type: "episode_closed" as const, closure }],
    createdAt,
  };
  const job: MemoryJobRecord = {
    id: domainId(
      "memory_job",
      command.ownerScope,
      command.simulationId,
      command.commandId,
    ),
    ownerScope: command.ownerScope,
    simulationId: command.simulationId,
    originBranchId: command.branchId,
    episodeId,
    closureCommitId: commitId,
    basisHeadCommitId: command.expectedHead,
    commandId: command.commandId,
    label: normalized.payload.label,
    status: "pending",
    attemptCount: 0,
    resultFingerprint: null,
    result: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
  };
  return repository.requestClosure({
    branchId: command.branchId,
    expectedHead: command.expectedHead,
    commandInput: recorded,
    commandFingerprint,
    commit,
    job,
  });
}

export async function runEpisodeMemoryJob(
  repository: SimulationRepository,
  input: { ownerScope: string; simulationId: string; jobId: string },
  generator: EpisodeClosureGenerator = deterministicEpisodeClosureGenerator,
) {
  const existing = repository.getMemoryJob(
    input.ownerScope,
    input.simulationId,
    input.jobId,
  );
  if (!existing)
    throw new DomainNotFoundError(`Memory job not found: ${input.jobId}`);
  if (existing.status === "completed")
    return {
      job: existing,
      operations: repository
        .listDetachedMemoryOperations(input.ownerScope, input.simulationId)
        .filter(
          (operation) => operation.closureCommitId === existing.closureCommitId,
        ),
      closure: existing.result!,
      replayed: true,
    };
  const job = repository.startMemoryJob(
    input.ownerScope,
    input.simulationId,
    input.jobId,
  );
  try {
    const generated = await generate(repository, job, generator);
    const fingerprint = createHash("sha256")
      .update(stableStringify(generated.closure))
      .digest("hex");
    return {
      job: repository.completeMemoryJob(job, generated.closure, fingerprint),
      operations: generated.operations,
      closure: generated.closure,
      replayed: false,
    };
  } catch (error) {
    repository.failMemoryJob(
      job,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

async function generate(
  repository: SimulationRepository,
  job: MemoryJobRecord,
  generator: EpisodeClosureGenerator,
) {
  const projection = projectBranch(repository, {
    ownerScope: job.ownerScope,
    simulationId: job.simulationId,
    branchId: job.originBranchId,
    head: job.basisHeadCommitId,
  });
  const lastClosure = projection.commits.findLastIndex(
    (commit) => commit.kind === "episode_closure",
  );
  const openIds = new Set(
    projection.commits.slice(lastClosure + 1).map((commit) => commit.id),
  );
  const turns = projection.transcript.filter(
    (turn) => turn.commitId && openIds.has(turn.commitId),
  );
  const simulation = repository.getSimulation(job.ownerScope, job.simulationId);
  if (!simulation)
    throw new DomainNotFoundError(`Simulation not found: ${job.simulationId}`);
  const revision = repository.getContentRevision(
    job.ownerScope,
    simulation.contentRevisionId,
  );
  if (!revision)
    throw new DomainNotFoundError(
      `Content revision not found: ${simulation.contentRevisionId}`,
    );
  const memories: EpisodeMemoryRecord[] = [],
    longTermMemories: LongTermMemoryRecord[] = [],
    extractedBeliefs: ExtractedBeliefRecord[] = [],
    operations: MemoryOperation[] = [];
  for (const actor of revision.compiled.entities.filter(canHoldEpisodeMemory)) {
    const perceptions = projection.perceptions.filter(
      (p) => p.actorId === actor.id && openIds.has(p.sourceCommitId),
    );
    if (!perceptions.length) continue;
    const accessibleTurns = turns.filter((turn) =>
      perceptions.some(
        (p) => p.sourceMessageVersionId === turn.messageVersionId,
      ),
    );
    const context = inspectActorContext(repository, {
      ownerScope: job.ownerScope,
      simulationId: job.simulationId,
      branchId: job.originBranchId,
      head: job.basisHeadCommitId,
      actorId: actor.id,
      turns: accessibleTurns,
    });
    const text = (
      await generator.writeMemory({
        actor,
        context,
        turns: accessibleTurns,
        label: job.label,
      })
    ).trim();
    if (!text)
      throw new DomainValidationError("Episode memory content is empty.");
    const memory: EpisodeMemoryRecord = {
      id: domainId("episode_memory", job.commandId, actor.id),
      episodeId: job.episodeId,
      simulationId: job.simulationId,
      actorId: actor.id,
      text,
      sourceTurnIds: accessibleTurns.map((t) => t.id),
      sourcePerceptionIds: perceptions.map((p) => p.id),
      sourceEventIds: perceptions.map((p) => p.sourceEventId),
      sourceMessageVersionIds: perceptions.map((p) => p.sourceMessageVersionId),
      createdAt: job.createdAt,
    };
    memories.push(memory);
    operations.push(makeOperation(job, memory, "asserted", text));
    const longText = (
      await generator.writeLongTermMemory?.({ actor, context, memory })
    )?.trim();
    if (longText) {
      const long = {
        id: domainId("long_memory", job.commandId, actor.id),
        episodeId: job.episodeId,
        episodeMemoryId: memory.id,
        simulationId: job.simulationId,
        actorId: actor.id,
        text: longText,
        createdAt: job.createdAt,
      };
      longTermMemories.push(long);
      operations.push(
        makeOperation(job, memory, "consolidated", longText, long.id),
      );
    }
    for (const candidate of await generator.extractBeliefs({
      actor,
      context,
      memory,
    }))
      if (candidate.propositionText.trim())
        extractedBeliefs.push({
          id: domainId(
            "belief",
            job.commandId,
            actor.id,
            String(
              extractedBeliefs.filter((b) => b.holder === actor.id).length,
            ),
          ),
          episodeId: job.episodeId,
          memoryId: memory.id,
          simulationId: job.simulationId,
          holder: actor.id,
          strength: normalizeStrength(candidate.strength),
          propositionText: candidate.propositionText.trim(),
          createdAt: job.createdAt,
        });
  }
  const retainedBeliefs = deriveRetainedBeliefs({
    simulationId: job.simulationId,
    commandId: job.commandId,
    episodeId: job.episodeId,
    createdAt: job.createdAt,
    entities: revision.compiled.entities,
    initialBeliefs: revision.compiled.beliefs,
    initialAccessLinks: revision.compiled.accessLinks,
    ancestry: projection.commits,
  });
  return {
    operations,
    closure: {
      episode: {
        id: job.episodeId,
        simulationId: job.simulationId,
        commitId: job.closureCommitId,
        label: job.label,
        closedAt: job.createdAt,
      },
      memories,
      longTermMemories,
      extractedBeliefs,
      retainedBeliefs,
      memoryOperations: operations,
    } as EpisodeClosure,
  };
}

function makeOperation(
  job: MemoryJobRecord,
  memory: EpisodeMemoryRecord,
  type: "asserted" | "consolidated",
  content: string,
  memoryId = memory.id,
): MemoryOperation {
  const base = {
    id: domainId("memory_operation", job.closureCommitId, memoryId, type),
    memoryId,
    simulationId: job.simulationId,
    actorId: memory.actorId,
    memoryKind:
      type === "asserted" ? ("episode" as const) : ("long_term" as const),
    basisCommitId: job.basisHeadCommitId,
    closureCommitId: job.closureCommitId,
    sourcePerceptionIds: memory.sourcePerceptionIds || [],
    sourceEventIds: memory.sourceEventIds || [],
    sourceMessageVersionIds: memory.sourceMessageVersionIds || [],
    producer: { mode: "episode_closure" as const, commandId: job.commandId },
    createdAt: job.createdAt,
  };
  return type === "asserted"
    ? { ...base, type, content }
    : { ...base, type, content, episodeMemoryId: memory.id };
}

export async function closeBranchEpisode(
  repository: SimulationRepository,
  command: CommandEnvelope<{ label?: string | null }>,
  generator = deterministicEpisodeClosureGenerator,
) {
  const requested = requestEpisodeClosure(repository, command);
  const run = await runEpisodeMemoryJob(
    repository,
    {
      ownerScope: command.ownerScope,
      simulationId: command.simulationId,
      jobId: requested.job.id,
    },
    generator,
  );
  const closure =
    run.closure ||
    projectBranch(repository, {
      ownerScope: command.ownerScope,
      simulationId: command.simulationId,
      branchId: command.branchId,
      head: requested.commit.id,
    }).episodeClosures.at(-1)!;
  return {
    ...requested,
    job: run.job,
    closure,
    replayed: requested.replayed && run.replayed,
  };
}

export { runtimeEventId };
export const deterministicEpisodeClosureGenerator: EpisodeClosureGenerator = {
  writeMemory({ actor, turns, label }) {
    return `I am @${actor.id}. ${label ? `In ${label}, ` : ""}I remember ${turns.map((t) => `${t.actorId}: ${t.text}`).join(" ")}`;
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
  return value >= 3 ? 3 : value > 0 ? 1 : value <= -3 ? -3 : value < 0 ? -1 : 0;
}
