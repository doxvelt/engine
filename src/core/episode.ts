import type { EntityRecord, EpisodeClosure, EpisodeMemoryRecord, TranscriptTurn } from "./types.ts";
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

  for (const actor of actors) {
    const turns = store.listAccessibleTurns(simulationId, actor.id);
    if (turns.length === 0) continue;

    memories.push(
      store.createEpisodeMemory({
        episodeId: episode.id,
        simulationId,
        actorId: actor.id,
        text: writeDeterministicMemory(actor, turns),
        sourceTurnIds: turns.map((turn) => turn.id)
      })
    );
  }

  return { episode, memories };
}

function writeDeterministicMemory(actor: EntityRecord, turns: TranscriptTurn[]): string {
  const renderedTurns = turns.map((turn) => `${turn.actorId}: ${turn.text}`).join("\n");

  return [
    `${actor.name} remembers this episode through accessible transcript material.`,
    "",
    renderedTurns
  ].join("\n");
}
