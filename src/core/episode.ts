import { assembleActorContext } from "./context.ts";
import type {
  ActorContext,
  AssetRecord,
  EntityRecord,
  EpisodeClosure,
  EpisodeMemoryRecord,
  ExtractedBeliefRecord,
  SimulationRecord,
  TranscriptTurn
} from "./types.ts";
import type { RuntimeStore } from "../store/sqlite.ts";

export type ExtractedBeliefCandidate = {
  strength: number;
  propositionText: string;
};

export type EpisodeClosureGenerator = {
  writeMemory(input: EpisodeMemoryGenerationInput): Promise<string> | string;
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

  const actors = store.listActors(simulationId).filter((actor) => actor.kind === "agent");
  const episode = store.createEpisode({ simulationId, label: label || null });
  const memories: EpisodeMemoryRecord[] = [];
  const extractedBeliefs: ExtractedBeliefRecord[] = [];

  for (const actor of actors) {
    const turns = store.listAccessibleTurns(simulationId, actor.id);
    if (turns.length === 0) continue;

    const context = buildClosureContext({ store, simulation, actor });
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

  return { episode, memories, extractedBeliefs };
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
  actor
}: {
  store: RuntimeStore;
  simulation: SimulationRecord;
  actor: EntityRecord;
}): ActorContext {
  return assembleActorContext({
    simulation,
    actor,
    worlds: store.listCompiledRecords<AssetRecord>(simulation.id, "world"),
    scenario: simulation.scenarioId
      ? store.getCompiledRecord<AssetRecord>(simulation.id, "scenario", simulation.scenarioId)
      : null,
    formats: store.listCompiledRecords<AssetRecord>(simulation.id, "format"),
    beliefs: store.listBeliefHistory(simulation.id),
    turns: store.listAccessibleTurns(simulation.id, actor.id)
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
