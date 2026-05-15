import type {
  EntityRecord,
  EpisodeClosure,
  EpisodeMemoryRecord,
  ExtractedBeliefRecord,
  TranscriptTurn
} from "./types.ts";
import type { RuntimeStore } from "../store/sqlite.ts";

export function closeEpisode({
  store,
  simulationId = "default",
  label
}: {
  store: RuntimeStore;
  simulationId?: string;
  label?: string | null;
}): EpisodeClosure {
  const actors = store.listActors(simulationId).filter((actor) => actor.kind === "agent");
  const episode = store.createEpisode({ simulationId, label: label || null });
  const memories: EpisodeMemoryRecord[] = [];
  const extractedBeliefs: ExtractedBeliefRecord[] = [];

  for (const actor of actors) {
    const turns = store.listAccessibleTurns(simulationId, actor.id);
    if (turns.length === 0) continue;

    const memory = store.createEpisodeMemory({
      episodeId: episode.id,
      simulationId,
      actorId: actor.id,
      text: writeDeterministicMemory(actor, turns),
      sourceTurnIds: turns.map((turn) => turn.id)
    });

    memories.push(memory);
    extractedBeliefs.push(extractDeterministicBelief({ store, episodeId: episode.id, memory }));
  }

  return { episode, memories, extractedBeliefs };
}

function writeDeterministicMemory(actor: EntityRecord, turns: TranscriptTurn[]): string {
  const renderedTurns = turns.map((turn) => `${turn.actorId}: ${turn.text}`).join("\n");

  return [
    `${actor.name} remembers this episode through accessible transcript material.`,
    "",
    renderedTurns
  ].join("\n");
}

function extractDeterministicBelief({
  store,
  episodeId,
  memory
}: {
  store: RuntimeStore;
  episodeId: number | bigint;
  memory: EpisodeMemoryRecord;
}): ExtractedBeliefRecord {
  return store.createExtractedBelief({
    episodeId,
    memoryId: memory.id,
    simulationId: memory.simulationId,
    holder: memory.actorId,
    strength: 1,
    propositionText: `@${memory.actorId} experienced an episode with ${memory.sourceTurnIds.length} accessible turn(s).`
  });
}
