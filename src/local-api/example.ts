import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { compileWorkspace } from "../core/compiler.ts";
import { initWorkspace } from "../core/init.ts";
import { LOCAL_OWNER_SCOPE, startBranchSimulationFromCompiled } from "../core/branch-kernel.ts";
import { domainId } from "../core/domain-rules.ts";
import { CommandIdentityError, DomainValidationError, type SimulationRepository } from "../core/ports.ts";
import type { ExampleEntry } from "./stage-contracts.ts";

const simulationId = "example-last-crossing";
const commandId = "example-last-crossing-start-v1";

/** Local onboarding composes the supported compiler/start contract. The database
 * owns the resume pointer; browser storage and mutable source never choose it. */
export async function playLastCrossing(repository: SimulationRepository, localDirectory: string): Promise<ExampleEntry> {
  const existing = resume(repository);
  if (existing) return existing;
  // Exclusive allocation avoids touching any pre-existing user source, including
  // interrupted setup folders. Only this invocation's unused allocation is removed.
  const allocated = await mkdtemp(path.join(localDirectory, "last-crossing-"));
  const workspacePath = path.join(allocated, "source");
  try {
    await initWorkspace(workspacePath, { template: "last-crossing" });
    const compiled = await compileWorkspace(workspacePath);
    if (compiled.diagnostics.some(item => item.severity === "error"))
      throw new DomainValidationError("The bundled example did not compile.");
    if (!resume(repository)) {
      try {
        startBranchSimulationFromCompiled(repository, {
          ownerScope: LOCAL_OWNER_SCOPE, simulationId, commandId,
          branchId: "main", scenarioId: "last-crossing", compiled,
        });
      } catch (error) {
        // Another API process can win the same immutable start while we compile.
        // Only a verified example run is a successful race outcome.
        if (!resume(repository)) throw error;
      }
    }
    return resume(repository)!;
  } finally {
    const saved = repository.getSimulation(LOCAL_OWNER_SCOPE, simulationId);
    if (saved?.sourceRoot !== workspacePath) await rm(allocated, { recursive: true, force: true });
  }
}

function resume(repository: SimulationRepository): ExampleEntry | null {
  const simulation = repository.getSimulation(LOCAL_OWNER_SCOPE, simulationId);
  if (!simulation) return null;
  const root = repository.getCommit(LOCAL_OWNER_SCOPE, simulationId, domainId("commit", LOCAL_OWNER_SCOPE, simulationId, commandId));
  if (simulation.scenarioId !== "last-crossing" || root?.kind !== "root" || root.commandId !== commandId)
    throw new CommandIdentityError("The example run identity is already in use by another simulation.");
  return { simulationId, branchId: simulation.defaultBranchId, workspacePath: simulation.sourceRoot };
}
