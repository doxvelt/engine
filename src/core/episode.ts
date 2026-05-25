import { createRetainedBeliefDraft } from "./beliefs.ts";
import { assembleActorContext, resolveBeliefAccess } from "./context.ts";
import { ensureFirstImpressions } from "./impressions.ts";
import type {
  ActorContext,
  AssetRecord,
  EntityRecord,
  EpisodeClosure,
  EpisodeMemoryRecord,
  ExtractedBeliefRecord,
  LongTermMemoryRecord,
  RetainedBeliefRecord,
  SimulationRecord,
  SubjectiveBeliefAccess,
  TranscriptTurn
} from "./types.ts";
import type { RuntimeStore } from "../store/sqlite.ts";

export type ExtractedBeliefCandidate = {
  strength: number;
  propositionText: string;
};

export type EpisodeClosureGenerator = {
  writeMemory(input: EpisodeMemoryGenerationInput): Promise<string> | string;
  writeLongTermMemory?(input: LongTermMemoryGenerationInput): Promise<string | null> | string | null;
  extractBeliefs(input: EpisodeBeliefExtractionInput): Promise<ExtractedBeliefCandidate[]> | ExtractedBeliefCandidate[];
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

export type LongTermMemoryGenerationInput = EpisodeBeliefExtractionInput;

export async function closeEpisode({
  store,
  simulationId = "default",
  label,
  generator = deterministicEpisodeClosureGenerator
}: {
  store: RuntimeStore;
  simulationId?: string;
  label?: string | null;
  generator?: EpisodeClosureGenerator;
}): Promise<EpisodeClosure> {
  const simulation = store.getSimulation(simulationId);
  if (!simulation) throw new Error(`Simulation not found: ${simulationId}`);

  const unclosedTurns = store.listUnclosedTurns(simulationId);
  if (unclosedTurns.length === 0) {
    throw new Error(`No unclosed turns to close for simulation: ${simulationId}`);
  }

  const actors = store.listActors(simulationId).filter((actor) => actor.kind === "agent");
  const episode = store.createEpisode({ simulationId, label: label || null });
  const memories: EpisodeMemoryRecord[] = [];
  const longTermMemories: LongTermMemoryRecord[] = [];
  const extractedBeliefs: ExtractedBeliefRecord[] = [];
  const retainedBeliefs: RetainedBeliefRecord[] = [];

  for (const actor of actors) {
    const turns = store.listUnclosedAccessibleTurns(simulationId, actor.id);
    if (turns.length === 0) continue;

    const context = buildClosureContext({ store, simulation, actor, turns });
    const memoryText = await generator.writeMemory({
      actor,
      context,
      turns,
      label: label || null
    });

    const memory = store.createEpisodeMemory({
      episodeId: episode.id,
      simulationId,
      actorId: actor.id,
      text: memoryText,
      sourceTurnIds: turns.map((turn) => turn.id)
    });

    memories.push(memory);

    const longTermMemoryText = (await generator.writeLongTermMemory?.({ actor, context, memory }))?.trim();
    if (longTermMemoryText) {
      longTermMemories.push(
        store.createLongTermMemory({
          episodeId: episode.id,
          episodeMemoryId: memory.id,
          simulationId: memory.simulationId,
          actorId: memory.actorId,
          text: longTermMemoryText
        })
      );
    }

    const beliefCandidates = await generator.extractBeliefs({ actor, context, memory });
    for (const candidate of beliefCandidates) {
      const propositionText = candidate.propositionText.trim();
      if (!propositionText) continue;

      extractedBeliefs.push(
        store.createExtractedBelief({
          episodeId: episode.id,
          memoryId: memory.id,
          simulationId: memory.simulationId,
          holder: memory.actorId,
          strength: normalizeStrength(candidate.strength),
          propositionText
        })
      );
    }
  }

  for (const actor of actors) {
    const turns = store.listUnclosedAccessibleTurns(simulationId, actor.id);
    if (turns.length === 0) continue;

    retainedBeliefs.push(
      ...createRetainedBeliefsForActor({
        store,
        simulationId,
        episodeId: episode.id,
        actorId: actor.id
      })
    );
  }

  store.markTurnsClosed({
    simulationId,
    episodeId: episode.id,
    turnIds: unclosedTurns.map((turn) => turn.id)
  });

  return { episode, memories, longTermMemories, extractedBeliefs, retainedBeliefs };
}

export const deterministicEpisodeClosureGenerator: EpisodeClosureGenerator = {
  writeMemory({ actor, turns }) {
    return writeDeterministicMemory(actor, turns);
  },
  extractBeliefs({ memory }) {
    return [
      {
        strength: 1,
        propositionText: `@${memory.actorId} experienced an episode with ${memory.sourceTurnIds.length} accessible turn(s).`
      }
    ];
  }
};

function buildClosureContext({
  store,
  simulation,
  actor,
  turns
}: {
  store: RuntimeStore;
  simulation: SimulationRecord;
  actor: EntityRecord;
  turns: TranscriptTurn[];
}): ActorContext {
  const observedEntityIds = turns.flatMap((turn) => turn.audience);
  ensureFirstImpressions({
    store,
    simulationId: simulation.id,
    observerId: actor.id,
    observedEntityIds
  });

  return assembleActorContext({
    simulation,
    actor,
    worlds: store.listCompiledRecords<AssetRecord>(simulation.id, "world"),
    scenario: simulation.scenarioId
      ? store.getCompiledRecord<AssetRecord>(simulation.id, "scenario", simulation.scenarioId)
      : null,
    formats: store.listCompiledRecords<AssetRecord>(simulation.id, "format"),
    beliefs: store.listBeliefHistory(simulation.id),
    accessLinks: store.listEffectiveAccessLinks(simulation.id),
    surfaces: store.listSurfaces(simulation.id),
    longTermMemories: store.listLongTermMemories(simulation.id, actor.id),
    observedEntityIds,
    stageWhispers: store.listPendingStageWhispers(simulation.id, actor.id),
    turns
  });
}

function writeDeterministicMemory(actor: EntityRecord, turns: TranscriptTurn[]): string {
  const renderedTurns = turns.map((turn) => `${turn.actorId}: ${turn.text}`).join("\n");

  return [
    `${actor.name} remembers this episode through accessible transcript material.`,
    "",
    renderedTurns
  ].join("\n");
}

function normalizeStrength(strength: number): number {
  if (strength >= 3) return 3;
  if (strength > 0) return 1;
  if (strength <= -3) return -3;
  if (strength < 0) return -1;
  return 0;
}

function createRetainedBeliefsForActor({
  store,
  simulationId,
  episodeId,
  actorId
}: {
  store: RuntimeStore;
  simulationId: string;
  episodeId: number | bigint;
  actorId: string;
}): RetainedBeliefRecord[] {
  const currentAccessLinks = store.listEffectiveAccessLinks(simulationId);
  const currentBeliefAccess = resolveBeliefAccess(
    actorId,
    store.listNonRetainedBeliefHistory(simulationId),
    currentAccessLinks
  );
  const currentKeys = new Set(currentBeliefAccess.map(beliefAccessKey));
  const retained: RetainedBeliefRecord[] = [];

  for (const event of store.listRuntimeAccessEvents(simulationId)) {
    if (event.action !== "revoke") continue;

    const previousBeliefAccess = resolveBeliefAccess(
      actorId,
      store.listNonRetainedBeliefHistory(simulationId),
      store.listEffectiveAccessLinksBeforeEvent(simulationId, event.id)
    );

    for (const access of previousBeliefAccess) {
      if (access.provenance.mode !== "accessed_through_membership") continue;
      if (currentKeys.has(beliefAccessKey(access))) continue;

      const draft = createRetainedBeliefDraft({
        holder: actorId,
        sourceBelief: access.belief,
        previousProvenance: access.provenance
      });
      const existing = store.getRetainedBelief({
        simulationId,
        holder: draft.holder,
        sourceHolder: draft.provenance.sourceHolder,
        propositionText: draft.propositionText,
        runtimeAccessEventId: event.id
      });
      if (existing) continue;

      retained.push(
        store.createRetainedBelief({
          episodeId,
          simulationId,
          holder: draft.holder,
          strength: draft.strength,
          propositionText: draft.propositionText,
          sourceHolder: draft.provenance.sourceHolder,
          accessPath: draft.provenance.accessPath,
          sourceBelief: access.belief as RetainedBeliefRecord["sourceBelief"],
          runtimeAccessEventId: event.id
        })
      );
    }
  }

  return retained;
}

function beliefAccessKey(access: SubjectiveBeliefAccess): string {
  return `${access.provenance.sourceHolder}:${access.belief.propositionText}`;
}
