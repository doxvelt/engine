import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { commitManualTurn, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { requestEpisodeClosure, runEpisodeMemoryJob } from "../src/core/branch-episode.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

for (const first of ["native", "typescript"]) {
  test(`native closure requests atomically pin detached job lineage (${first} first)`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-job-"));
    const database = path.join(root, "story.sqlite");
    const store = await openBranchStore(database).open();
    try {
      const base = { ownerScope: "local", simulationId: "sim", branchId: "main" };
      const started = await startBranchSimulation(store, { ...base, commandId: "start", workspacePath: path.resolve("examples/executive-interviews") });
      const turn = commitManualTurn(store, { ...base, expectedHead: started.root.id, commandId: "turn", payload: { actorId: "ceo", text: "Report.", audience: ["cfo"],
        accessChanges: [{ action: "revoke", member: "cfo", container: "ceo" }] } });
      const command = { ...base, expectedHead: turn.commit.id, commandId: "closure", payload: { label: "  Meeting  " } };
      const body = { branchId: "main", expectedHead: turn.commit.id, commandId: "closure", label: command.payload.label };
      let result: any;
      let expected: ReturnType<typeof requestEpisodeClosure>;
      if (first === "native") { result = await nativeRequest("/simulations/sim/episodes/request-closure", body, database); expected = requestEpisodeClosure(store, command); }
      else { expected = requestEpisodeClosure(store, command); result = await nativeRequest("/simulations/sim/episodes/request-closure", body, database); }
      assert.deepEqual(result, { ...expected, replayed: first === "typescript" });
      assert.deepEqual(await nativeRequest("/simulations/sim/memory-jobs", undefined, database), [expected.job]);
      assert.deepEqual(await nativeRequest(`/simulations/sim/memory-jobs/${expected.job.id}/transitions`, undefined, database), []);
      await assert.rejects(runEpisodeMemoryJob(store, { ...base, jobId: expected.job.id }, { writeMemory: () => { throw new Error("Private provider failure"); }, extractBeliefs: () => [] }));
      const twin = await openBranchStore(path.join(root, "oracle.sqlite")).open();
      try {
        twin.importSimulation(store.exportSimulation("local", "sim"));
        const oracle = await runEpisodeMemoryJob(twin, { ...base, jobId: expected.job.id });
        const native = await nativeRequest(`/simulations/sim/memory-jobs/${expected.job.id}`, {}, database);
        assert.deepEqual(native.closure, oracle.closure);
        assert.deepEqual(native.operations, oracle.operations);
        assert.equal(native.job.resultFingerprint, oracle.job.resultFingerprint);
        assert.equal(native.job.attemptCount, 2);
        assert.ok(native.closure.retainedBeliefs.length > 0, "Access loss must retain provenance with weakened beliefs");
        assert.deepEqual(await runEpisodeMemoryJob(store, { ...base, jobId: expected.job.id }), { ...native, replayed: true });
      } finally { twin.close(); }
      assert.deepEqual(await nativeRequest("/simulations/sim/memory-jobs", undefined, database), store.listMemoryJobs("local", "sim"));
      assert.deepEqual(await nativeRequest(`/simulations/sim/memory-jobs/${expected.job.id}/transitions`, undefined, database), store.listMemoryJobTransitions("local", "sim", expected.job.id));
      assert.deepEqual(await nativeRequest("/simulations/sim/episodes/request-closure", body, database), requestEpisodeClosure(store, command));
      const before = store.exportSimulation("local", "sim");
      await nativeRequest("/simulations/sim/episodes/request-closure", { ...body, commandId: "empty", expectedHead: expected.commit.id }, database, 400);
      assert.deepEqual(store.exportSimulation("local", "sim"), before);
      validateSimulationArchive(before);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
}
