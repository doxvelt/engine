import type { SimulationArchive } from "../src/core/ports.ts";

export function completedArchiveAsSchemaV4(
  source: SimulationArchive,
): SimulationArchive {
  const archive = structuredClone(source);
  for (const job of archive.memoryJobs ?? []) {
    if (job.status !== "completed" || !job.result) continue;
    const commit = archive.commits.find((item) => item.id === job.closureCommitId);
    const event = commit?.events[0];
    if (!commit || event?.type !== "episode_closed")
      throw new Error(`Missing closure commit for completed job ${job.id}`);
    event.closure = structuredClone(job.result);
    const command = archive.commandResults.find(
      (item) => item.commandId === commit.commandId,
    );
    if (!command || command.result.kind !== "commit")
      throw new Error(`Missing closure command result for completed job ${job.id}`);
    command.result.commit = structuredClone(commit);
  }
  archive.schemaVersion = 4;
  delete archive.memoryJobs;
  delete archive.memoryJobTransitions;
  delete archive.detachedMemoryOperations;
  return archive;
}
