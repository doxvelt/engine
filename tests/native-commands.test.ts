import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { commitManualTurn, inspectActorContext, projectBranch, stageWhisper, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

for (const first of ["native", "typescript"]) {
  for (const scoped of [false, true]) {
    test(`native manual commits share atomic command receipts and subjectivity (${first} first, ${scoped ? "scoped" : "legacy"})`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-turn-"));
      const database = path.join(root, "story.sqlite");
      const store = await openBranchStore(database).open();
      try {
        const base = { ownerScope: "local", simulationId: "sim", branchId: "main" };
        const started = await startBranchSimulation(store, { ...base, commandId: "start", workspacePath: path.resolve("examples/executive-interviews") });
        const whisperCommand = { ...base, expectedHead: started.root.id, commandId: "whisper", targetActorId: "ceo", text: "Private instruction." };
        const nativeWhisper = await nativeRequest("/simulations/sim/whispers", { ...whisperCommand, ownerScope: undefined }, database);
        const whisper = stageWhisper(store, whisperCommand);
        assert.deepEqual(nativeWhisper, whisper);
        const body = { branchId: "main", expectedHead: started.root.id, commandId: "turn", actorId: "ceo", manualText: scoped ? "#CFO(private report) Shared report." : "A report.",
          audience: ["student-team", "cfo"], stageWhisperIds: [whisper.id], whisperText: " Additional direction. ",
          audienceChanges: [{ actorId: "ceo", action: "add" as const }, { actorId: "cfo", action: "add" as const }],
          accessChanges: [{ action: "revoke" as const, member: "cfo", container: "ceo" }],
          ...(scoped ? { audienceSyntax: "scoped-v1" as const, knowledgePolicy: "actor-knowledge-v1" as const } : {}) };
        const command = { ...base, expectedHead: started.root.id, commandId: "turn", payload: { actorId: body.actorId, text: body.manualText,
          audience: body.audience, stageWhisper: body.whisperText, stageWhisperIds: body.stageWhisperIds,
          audienceChanges: body.audienceChanges, accessChanges: body.accessChanges, ...(scoped ? { audienceSyntax: "scoped-v1" as const, knowledgePolicy: "actor-knowledge-v1" as const } : {}) } };
        const context = scoped ? null : inspectActorContext(store, { ...base, head: started.root.id, actorId: "ceo", audience: body.audience, stageWhispers: [whisper] });
        let result: any;
        let expected: ReturnType<typeof commitManualTurn>;
        if (first === "native") { result = await nativeRequest("/simulations/sim/turns", body, database); expected = commitManualTurn(store, command); }
        else { expected = commitManualTurn(store, command); result = await nativeRequest("/simulations/sim/turns", body, database); }
        assert.deepEqual(result, { ...expected, replayed: first === "typescript", turn: projectBranch(store, base).transcript[0], ...(context ? { context } : {}) });
        assert.deepEqual(await nativeRequest("/simulations/sim/turns", body, database), { ...result, replayed: true });
        validateSimulationArchive(store.exportSimulation("local", "sim"));
        const before = store.exportSimulation("local", "sim");
        await nativeRequest("/simulations/sim/turns", { ...body, manualText: "Changed" }, database, 409);
        await nativeRequest("/simulations/sim/turns", { ...body, commandId: "stale" }, database, 409);
        await nativeRequest("/simulations/sim/turns", { ...body, commandId: "bad", expectedHead: expected.commit.id, stageWhisperIds: [],
          accessChanges: [{ action: "grant", member: "ceo", container: "ceo" }] }, database, 400);
        assert.deepEqual(store.exportSimulation("local", "sim"), before, "Rejected commands leave no accepted effects or receipts");
      } finally { store.close(); await rm(root, { recursive: true, force: true }); }
    });
  }
}
