/** Temporary migration oracle; the checked-in cases remain native behavior proofs. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startBranchSimulation, commitManualTurn, commitRuntimeEffects } from "../../src/core/branch-kernel.ts";
import { projectRoutingContext } from "../../src/core/candidate-routing.ts";
import { openBranchStore } from "../../src/store/branch-sqlite.ts";
import type { GenerateActorTurnDraftCommand } from "../../src/core/ports.ts";

const root = await mkdtemp(path.join(tmpdir(), "doxvelt-routing-oracle-"));
const store = await openBranchStore(path.join(root, "story.sqlite")).open();
try {
  const base = { ownerScope: "local", simulationId: "routing", branchId: "main" };
  const started = await startBranchSimulation(store, { ...base, commandId: "start", workspacePath: path.resolve("examples/last-crossing"), scenarioId: "last-crossing" });
  const presence = commitRuntimeEffects(store, { ...base, expectedHead: started.root.id, commandId: "presence", payload: {
    audienceChanges: [{ actorId: "corin", action: "add" }, { actorId: "mara", action: "add" }],
  } });
  const turn = commitManualTurn(store, { ...base, expectedHead: presence.commit.id, commandId: "turn", payload: {
    actorId: "corin", audience: ["mara"], text: "A received statement remains a claim.", knowledgePolicy: "actor-knowledge-v1",
  } });
  const cases = [];
  for (const version of [1, 2, 3, 4] as const) {
    for (const recall of [undefined, [{ publicationId: "episode-1", label: "Earlier", text: "A fallible recollection, not current presence." }]]) {
      const command: GenerateActorTurnDraftCommand = { ...base, commandId: "generate", expectedHead: turn.commit.id, payload: {
        actorId: "corin", audience: ["corin", "mara"], stageWhisperIds: [], runtimeProfile: { id: "character", version: "v1" },
        promptPolicy: { id: version >= 3 ? "actor-knowledge-v1" : "audience-proposal-v1", version: "v1" }, outputSchema: { id: "audience-proposal", digest: "v1" }, skillDigests: [],
        routing: { version, ...(version >= 2 ? { completeWhisper: "Speak only to Mara." } : {}), initialAudience: version === 4 ? null : ["mara"],
          correctedAudience: version === 4 ? ["mara"] : null, sourceDraftId: null, correction: "", preservedText: null },
      } };
      const snapshot = (value: ReturnType<typeof projectRoutingContext>) => ({ contextHash: value.contextHash, promptHash: value.promptHash, availableRecipientIds: value.availableRecipientIds });
      const expected = snapshot(projectRoutingContext(store, command, [], null, recall));
      cases.push({ command, source: null, recall: recall ?? null, expected });
      if (version === 1) {
        const source = { draftId: "source", actorId: "corin", basisHeadCommitId: turn.commit.id,
          artifact: { text: "UNACCEPTED-SOURCE-WORDING" }, audience: ["corin", "mara"] };
        // The projector reads only these source fields; source-record validation is a separate contract.
        cases.push({ command, source, recall: recall ?? null,
          expected: snapshot(projectRoutingContext(store, command, [], source as Parameters<typeof projectRoutingContext>[3], recall)) });
      }
    }
  }
  await mkdir("api/tests/fixtures", { recursive: true });
  await writeFile("api/tests/fixtures/routing.json", JSON.stringify(cases, null, 2) + "\n");
} finally { store.close(); await rm(root, { recursive: true, force: true }); }
