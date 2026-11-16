import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { commitManualTurn, commitRuntimeEffects, editAcceptedMessage, regenerateAcceptedResponse, projectBranch, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

for (const first of ["native", "typescript"]) {
  test(`native effects and sibling replacements preserve source history (${first} first)`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-history-"));
    const database = path.join(root, "story.sqlite");
    const store = await openBranchStore(database).open();
    try {
      const base = { ownerScope: "local", simulationId: "sim", branchId: "main" };
      const started = await startBranchSimulation(store, { ...base, commandId: "start", workspacePath: path.resolve("examples/executive-interviews") });
      let head = started.root.id;
      for (const kind of ["audience", "access"] as const) {
        const body = kind === "audience" ? { actorId: "ceo", action: "add" as const } : { action: "revoke" as const, member: "cfo", container: "ceo" };
        const command = { ...base, expectedHead: head, commandId: kind, payload: { [kind === "audience" ? "audienceChanges" : "accessChanges"]: [body] } };
        let expected: ReturnType<typeof commitRuntimeEffects>;
        let result: any;
        if (first === "native") { result = await nativeRequest(`/simulations/sim/${kind}`, { ...body, branchId: "main", expectedHead: head, commandId: kind }, database); expected = commitRuntimeEffects(store, command); }
        else { expected = commitRuntimeEffects(store, command); result = await nativeRequest(`/simulations/sim/${kind}`, { ...body, branchId: "main", expectedHead: head, commandId: kind }, database); }
        assert.deepEqual(result, { ...expected, replayed: first === "typescript" });
        head = expected.commit.id;
      }
      const original = commitManualTurn(store, { ...base, expectedHead: head, commandId: "original", payload: { actorId: "ceo", text: "Original.", audience: ["cfo"] } });
      const source = projectBranch(store, base);
      for (const action of ["edit", "regenerate"] as const) {
        const request = { ...base, expectedHead: original.commit.id, sourceBranchId: "main", sourceCommitId: original.commit.id,
          branchId: action, commandId: action, payload: { actorId: "ceo", text: "  Replacement.  ", audience: ["student-team"] } };
        const old = () => action === "edit" ? editAcceptedMessage(store, request) : regenerateAcceptedResponse(store, request);
        const body = { branchId: "main", newBranchId: action, expectedHead: original.commit.id, sourceCommitId: original.commit.id, commandId: action,
          actorId: request.payload.actorId, manualText: request.payload.text, audience: request.payload.audience };
        let expected: ReturnType<typeof old>;
        let result: any;
        if (first === "native") { result = await nativeRequest(`/simulations/sim/${action}`, body, database); expected = old(); }
        else { expected = old(); result = await nativeRequest(`/simulations/sim/${action}`, body, database); }
        assert.deepEqual(result, { ...expected, replayed: first === "typescript" });
        assert.deepEqual(await nativeRequest(`/simulations/sim/${action}`, body, database), { ...result, replayed: true });
        assert.deepEqual(projectBranch(store, base), source);
        assert.equal(expected.commit.parentCommitId, original.commit.parentCommitId);
        const before = store.exportSimulation("local", "sim");
        await nativeRequest(`/simulations/sim/${action}`, { ...body, commandId: action + "-bad", newBranchId: action + "-bad", actorId: "cfo" }, database, 400);
        assert.deepEqual(store.exportSimulation("local", "sim"), before);
      }
      validateSimulationArchive(store.exportSimulation("local", "sim"));
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
}
