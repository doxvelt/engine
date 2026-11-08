import { domainId } from "./domain-rules.ts";
import { DomainValidationError, type SimulationRepository } from "./ports.ts";
import type { BranchRecord, CommitRecord } from "./types.ts";

/** A branch inherits corrections to turns in its prefix, even when it diverges before the correction was recorded. */
export function branchBodyCorrections(repository: Pick<SimulationRepository, "getBranch" | "getCommit">, branch: BranchRecord) {
  const corrections = new Map<string, { text: string; commitId: string; performance?: import("./audience-scopes.ts").ScopedPerformance }>();
  const visited = new Set<string>();
  let current: BranchRecord | null = branch;
  while (current && current.origin.kind !== "root") {
    const { id, ownerScope, simulationId, origin } = current;
    if (visited.has(id)) throw new DomainValidationError("Invalid story path ancestry.");
    visited.add(id);
    if (origin.kind === "edit") {
      const commit = repository.getCommit(ownerScope, simulationId, domainId("commit", ownerScope, simulationId, origin.commandId));
      const correction = commit?.events.find(event => event.type === "message_body_corrected");
      if (commit && correction && !corrections.has(correction.messageVersionId))
        corrections.set(correction.messageVersionId, { text: correction.text, commitId: commit.id,
          ...(correction.performance ? { performance: correction.performance } : {}) });
    }
    current = repository.getBranch(ownerScope, simulationId, origin.sourceBranchId);
  }
  return corrections;
}

/** Closures already formed from corrected source, including their later dependents. */
export function invalidatedBodyClosures(
  repository: Pick<SimulationRepository, "getBranch" | "getCommit" | "listAncestors">,
  branch: BranchRecord,
  commits: CommitRecord[],
  corrections = branchBodyCorrections(repository, branch),
) {
  const present = new Set(commits.flatMap(commit => commit.events
    .filter(event => event.type === "message_accepted").map(event => event.message.id)));
  const invalidated = new Set<string>();
  for (const [messageId, correction] of corrections) {
    if (!present.has(messageId)) continue;
    let affected = false;
    for (const commit of repository.listAncestors(branch.ownerScope, branch.simulationId, correction.commitId)) {
      if (commit.events.some(event => event.type === "message_accepted" && event.message.id === messageId)) affected = true;
      if (affected && commit.events.some(event => event.type === "episode_closed")) invalidated.add(commit.id);
    }
  }
  return invalidated;
}
