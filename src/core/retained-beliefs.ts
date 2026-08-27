import { applyAccessChange } from "./access-graph.ts";
import { createRetainedBeliefDraft } from "./beliefs.ts";
import { resolveBeliefAccess } from "./context.ts";
import { canHoldEpisodeMemory, domainId } from "./domain-rules.ts";
import type {
  AccessLinkRecord,
  CommitRecord,
  EntityRecord,
  FirstImpressionRecord,
  RetainedBeliefRecord,
  SubjectiveBeliefAccess,
  SubjectiveBeliefRecord,
} from "./types.ts";

type LostAccess = {
  access: SubjectiveBeliefAccess;
  runtimeAccessEventId: string;
};

export function deriveRetainedBeliefs(input: {
  simulationId: string;
  commandId: string;
  episodeId: string;
  createdAt: string;
  entities: EntityRecord[];
  initialBeliefs: SubjectiveBeliefRecord[];
  initialAccessLinks: AccessLinkRecord[];
  ancestry: CommitRecord[];
}): RetainedBeliefRecord[] {
  const actors = input.entities.filter(canHoldEpisodeMemory);
  const lostByActor = new Map(
    actors.map((actor) => [actor.id, new Map<string, LostAccess>()]),
  );
  let links = [...input.initialAccessLinks];
  const beliefs = [...input.initialBeliefs];
  let impressionIndex = 0;
  for (const commit of input.ancestry)
    for (const [eventIndex, event] of commit.events.entries()) {
      if (event.type === "access_changed") {
        const beforeByActor = new Map(
          actors.map((actor) => [
            actor.id,
            resolveBeliefAccess(actor.id, beliefs, links),
          ]),
        );
        links = applyAccessChange(links, event);
        if (event.action !== "revoke") continue;
        for (const actor of actors) {
          const afterKeys = new Set(
            resolveBeliefAccess(actor.id, beliefs, links).map(accessKey),
          );
          for (const access of beforeByActor.get(actor.id) || []) {
            if (
              access.provenance.mode !== "accessed_through_membership" ||
              afterKeys.has(accessKey(access))
            ) continue;
            lostByActor.get(actor.id)!.set(accessKey(access), {
              access,
              runtimeAccessEventId: runtimeEventId(commit.id, eventIndex),
            });
          }
        }
        continue;
      }
      if (event.type === "first_impression_formed") {
        const impression: FirstImpressionRecord = {
          ...event.impression,
          id: `${commit.id}:impression:${impressionIndex++}`,
          simulationId: input.simulationId,
          createdAt: commit.createdAt,
        };
        beliefs.push(impression);
        continue;
      }
      if (event.type === "episode_closed")
        beliefs.push(
          ...event.closure.extractedBeliefs,
          ...event.closure.retainedBeliefs,
        );
    }
  const retained: RetainedBeliefRecord[] = [];
  for (const actor of actors) {
    const currentKeys = new Set(
      resolveBeliefAccess(actor.id, beliefs, links).map(accessKey),
    );
    let index = 0;
    for (const lost of lostByActor.get(actor.id)!.values()) {
      const { access, runtimeAccessEventId } = lost;
      if (
        access.provenance.mode !== "accessed_through_membership" ||
        currentKeys.has(accessKey(access)) ||
        "sourceBelief" in access.belief
      ) continue;
      const draft = createRetainedBeliefDraft({
        holder: actor.id,
        sourceBelief: access.belief,
        previousProvenance: access.provenance,
      });
      retained.push({
        id: domainId("retained", input.commandId, actor.id, String(index++)),
        episodeId: input.episodeId,
        simulationId: input.simulationId,
        holder: actor.id,
        strength: draft.strength,
        propositionText: draft.propositionText,
        sourceHolder: draft.provenance.sourceHolder,
        accessPath: draft.provenance.accessPath,
        sourceBelief: draft.sourceBelief,
        runtimeAccessEventId,
        createdAt: input.createdAt,
      });
    }
  }
  return retained;
}

export function runtimeEventId(commitId: string, eventIndex: number): string {
  return `${commitId}:event:${eventIndex}`;
}

function accessKey(access: SubjectiveBeliefAccess): string {
  return `${access.provenance.sourceHolder}\u0000${access.belief.propositionText}`;
}
