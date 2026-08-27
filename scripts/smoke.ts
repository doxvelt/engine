import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeBranchEpisode } from "../src/core/branch-episode.ts";
import {
  commitManualTurn,
  inspectActorContext,
  startBranchSimulation,
} from "../src/core/branch-kernel.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-smoke-"));
const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
try {
  const started = await startBranchSimulation(store, {
    ownerScope: "local",
    simulationId: "smoke",
    workspacePath: path.resolve("examples/executive-interviews"),
    scenarioId: "executive-interviews",
    branchId: "main",
    commandId: "smoke-start",
  });
  const turn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "smoke",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "smoke-turn",
    payload: {
      actorId: "ceo",
      text: "We need to understand what is really going on.",
      audience: ["student-team"],
    },
  });
  const context = inspectActorContext(store, {
    ownerScope: "local",
    simulationId: "smoke",
    branchId: "main",
    actorId: "student-team",
  });
  if (!context.promptPreview.includes("really going on"))
    throw new Error("Subjective transcript projection failed.");
  const closure = await closeBranchEpisode(store, {
    ownerScope: "local",
    simulationId: "smoke",
    branchId: "main",
    expectedHead: turn.commit.id,
    commandId: "smoke-close",
    payload: { label: "Smoke episode" },
  });
  if (
    !closure.closure.memories.length ||
    !closure.closure.extractedBeliefs.length
  )
    throw new Error("Branch closure projection failed.");
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}
console.log("smoke ok (branch-aware manual kernel)");
