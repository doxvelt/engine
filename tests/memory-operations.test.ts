import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeBranchEpisode } from "../src/core/branch-episode.ts";
import { commitManualTurn, forkBranch, inspectActorContext, projectBranch, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { retractMemory, reviseMemory } from "../src/core/memory-operations.ts";
import { BranchConflictError, CommandIdentityError, DomainValidationError } from "../src/core/ports.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { completedArchiveAsSchemaV4 } from "./archive-test-helpers.ts";

const workspace = path.resolve("examples/executive-interviews");

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-memory-"));
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const started = await startBranchSimulation(store, {
    ownerScope: "owner-a", simulationId: "memory-sim", commandId: "start",
    workspacePath: workspace, scenarioId: "executive-interviews", branchId: "main",
  });
  const turn = commitManualTurn(store, {
    ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main",
    expectedHead: started.root.id, commandId: "turn", payload: {
      actorId: "ceo", text: "Only the CEO and team heard this.", audience: ["student-team"],
    },
  });
  forkBranch(store, {
    ownerScope: "owner-a", simulationId: "memory-sim", sourceBranchId: "main",
    expectedHead: turn.commit.id, atCommitId: turn.commit.id, branchId: "sibling", commandId: "fork",
  });
  const closed = await closeBranchEpisode(store, {
    ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main",
    expectedHead: turn.commit.id, commandId: "close", payload: { label: "Opening" },
  }, {
    writeMemory({ actor }) { return `${actor.id} episode`; },
    writeLongTermMemory({ actor }) { return `${actor.id} lasting memory`; },
    extractBeliefs() { return []; },
  });
  return { store, started, turn, closed };
}

test("perceptions and closure operations carry stable complete subjective provenance", async (t) => {
  const { store, turn, closed } = await fixture(t);
  const projection = projectBranch(store, { ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main" });
  assert.equal(projection.perceptions.some((item) => item.actorId === "cfo"), false);
  assert.equal(closed.closure.memories.some((item) => item.actorId === "cfo"), false);
  const memory = closed.closure.memories.find((item) => item.actorId === "ceo")!;
  const perception = projection.perceptions.find((item) => item.actorId === "ceo")!;
  assert.equal(perception.sourceCommitId, turn.commit.id);
  const messageEvent = turn.commit.events[0];
  assert.ok(messageEvent?.type === "message_accepted");
  assert.equal(perception.sourceMessageVersionId, messageEvent.message.id);
  assert.deepEqual(memory.sourcePerceptionIds, [perception.id]);
  assert.deepEqual(memory.sourceEventIds, [perception.sourceEventId]);
  assert.deepEqual(memory.sourceMessageVersionIds, [perception.sourceMessageVersionId]);
  assert.equal(projection.memoryOperations.length, closed.closure.memoryOperations!.length);
});

test("closure failure preserves its checkpoint and a retryable failed job", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-empty-memory-"));
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const started = await startBranchSimulation(store, {
    ownerScope: "owner-a", simulationId: "empty-memory", commandId: "start",
    workspacePath: workspace, scenarioId: "executive-interviews", branchId: "main",
  });
  const turn = commitManualTurn(store, {
    ownerScope: "owner-a", simulationId: "empty-memory", branchId: "main",
    expectedHead: started.root.id, commandId: "turn",
    payload: { actorId: "ceo", text: "Observed.", audience: [] },
  });
  await assert.rejects(() => closeBranchEpisode(store, {
    ownerScope: "owner-a", simulationId: "empty-memory", branchId: "main",
    expectedHead: turn.commit.id, commandId: "close", payload: {},
  }, {
    writeMemory() { return "   "; },
    extractBeliefs() { return []; },
  }), /memory content is empty/);
  assert.notEqual(store.getBranch("owner-a", "empty-memory", "main")?.headCommitId, turn.commit.id);
  assert.equal(store.listMemoryJobs("owner-a", "empty-memory")[0]?.status, "failed");
});

test("revision and retraction are immutable branch-local idempotent operations", async (t) => {
  const { store, closed } = await fixture(t);
  forkBranch(store, {
    ownerScope: "owner-a", simulationId: "memory-sim", sourceBranchId: "main",
    expectedHead: closed.commit.id, atCommitId: closed.commit.id,
    branchId: "memory-sibling", commandId: "memory-fork",
  });
  const before = projectBranch(store, { ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main" });
  const original = before.memoryOperations.find((item) => item.actorId === "ceo" && item.memoryKind === "long_term")!;
  const revise = {
    ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main",
    expectedHead: closed.commit.id, commandId: "revise", payload: {
      actorId: "ceo", memoryId: original.memoryId, revisesOperationId: original.id,
      content: "  Corrected lasting memory  ",
    },
  };
  const revised = reviseMemory(store, revise);
  assert.deepEqual(reviseMemory(store, {
    ...revise,
    payload: { ...revise.payload, content: "Corrected lasting memory" },
  }).commit, revised.commit);
  assert.throws(() => reviseMemory(store, { ...revise, payload: { ...revise.payload, content: "changed retry" } }), CommandIdentityError);
  const after = projectBranch(store, { ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main" });
  assert.equal(after.longTermMemories.find((item) => item.id === original.memoryId)!.text, "Corrected lasting memory");
  assert.equal(before.longTermMemories.find((item) => item.id === original.memoryId)!.text, "ceo lasting memory");
  assert.equal(projectBranch(store, { ownerScope: "owner-a", simulationId: "memory-sim", branchId: "sibling" }).memoryOperations.length, 0);
  assert.equal(
    projectBranch(store, {
      ownerScope: "owner-a", simulationId: "memory-sim", branchId: "memory-sibling",
    }).longTermMemories.find((item) => item.id === original.memoryId)!.text,
    "ceo lasting memory",
  );
  assert.equal(
    projectBranch(store, {
      ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main",
      head: closed.commit.id,
    }).longTermMemories.find((item) => item.id === original.memoryId)!.text,
    "ceo lasting memory",
  );
  assert.throws(
    () => reviseMemory(store, {
      ...revise, commandId: "stale-head", expectedHead: closed.commit.id,
    }),
    BranchConflictError,
  );
  assert.throws(
    () => reviseMemory(store, {
      ...revise, commandId: "stale-op", expectedHead: revised.commit.id,
    }),
    DomainValidationError,
  );
  assert.throws(
    () => reviseMemory(store, {
      ...revise,
      commandId: "foreign",
      expectedHead: revised.commit.id,
      payload: {
        ...revise.payload,
        actorId: "coo",
        revisesOperationId: after.memoryOperations.at(-1)!.id,
      },
    }),
    DomainValidationError,
  );
  const current = after.memoryOperations.filter((item) => item.memoryId === original.memoryId).at(-1)!;
  const retracted = retractMemory(store, {
    ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main",
    expectedHead: revised.commit.id, commandId: "retract", payload: {
      actorId: "ceo", memoryId: original.memoryId, retractsOperationId: current.id,
    },
  });
  const final = projectBranch(store, {
    ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main",
  });
  assert.equal(final.longTermMemories.some((item) => item.id === original.memoryId), false);
  assert.equal(final.memoryOperations.filter((item) => item.memoryId === original.memoryId).length, 3);
  assert.equal(inspectActorContext(store, {
    ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main",
    actorId: "ceo",
  }).subjective.longTermMemories.some((item) => item.id === original.memoryId), false);
  assert.throws(
    () => retractMemory(store, {
      ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main",
      expectedHead: retracted.commit.id, commandId: "again", payload: {
        actorId: "ceo", memoryId: original.memoryId,
        retractsOperationId: final.memoryOperations.at(-1)!.id,
      },
    }),
    DomainValidationError,
  );
});

test("legacy embedded memory operation archives reject forged causal chains", async (t) => {
  const { store, closed } = await fixture(t);
  const initial = projectBranch(store, { ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main" });
  const operation = initial.memoryOperations.find((item) => item.memoryKind === "episode")!;
  reviseMemory(store, {
    ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main",
    expectedHead: closed.commit.id, commandId: "revise-export", payload: {
      actorId: operation.actorId, memoryId: operation.memoryId,
      revisesOperationId: operation.id, content: "portable revision",
    },
  });
  const archive = completedArchiveAsSchemaV4(
    store.exportSimulation("owner-a", "memory-sim"),
  );
  validateSimulationArchive(structuredClone(archive));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "doxvelt-memory-import-"));
  const target = await openBranchStore(path.join(targetRoot, "runtime.sqlite")).open();
  t.after(async () => { target.close(); await rm(targetRoot, { recursive: true, force: true }); });
  target.importSimulation(structuredClone(archive));
  assert.deepEqual(
    projectBranch(target, {
      ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main",
    }).memoryOperations,
    projectBranch(store, {
      ownerScope: "owner-a", simulationId: "memory-sim", branchId: "main",
    }).memoryOperations,
  );
  const sync = (value: typeof archive, commitId: string) => {
    const commit = value.commits.find((item) => item.id === commitId)!;
    const result = value.commandResults.find((item) => item.commandId === commit.commandId)!;
    if (result.result.kind === "commit") result.result.commit = structuredClone(commit);
  };
  const variants = [
    (value: typeof archive) => {
      const commit = value.commits.at(-1)!;
      const event = commit.events[0];
      if (event?.type === "memory_operation")
        event.operation.createdAt = "1900-01-01T00:00:00.000Z";
      sync(value, commit.id);
    },
    (value: typeof archive) => {
      const commit = value.commits.find((item) => item.kind === "episode_closure")!;
      const event = commit.events[0];
      if (event?.type !== "episode_closed") return;
      const memory = event.closure.memories[0]!;
      delete memory.sourcePerceptionIds;
      delete memory.sourceEventIds;
      delete memory.sourceMessageVersionIds;
      const operation = event.closure.memoryOperations![0]!;
      operation.sourcePerceptionIds = [];
      operation.sourceEventIds = [];
      operation.sourceMessageVersionIds = [];
      sync(value, commit.id);
    },
    (value: typeof archive) => {
      const commit = value.commits.find((item) => item.kind === "episode_closure")!;
      const event = commit.events[0];
      if (event?.type !== "episode_closed") return;
      event.closure.memories[0]!.text = "";
      const operation = event.closure.memoryOperations![0]!;
      if (operation.type === "asserted") operation.content = "";
      sync(value, commit.id);
    },
    (value: typeof archive) => {
      const commit = value.commits.at(-1)!;
      const event = commit.events[0];
      if (event?.type !== "memory_operation") return;
      event.operation.sourcePerceptionIds = [];
      event.operation.sourceEventIds = [];
      event.operation.sourceMessageVersionIds = [];
      sync(value, commit.id);
    },
    (value: typeof archive) => {
      const commit = value.commits.at(-1)!;
      const event = commit.events[0];
      if (event?.type === "memory_operation" && event.operation.type === "revised")
        event.operation.revisesOperationId = "forged";
      sync(value, commit.id);
    },
    (value: typeof archive) => {
      const commit = value.commits.find((item) => item.kind === "episode_closure")!;
      const event = commit.events[0];
      if (event?.type === "episode_closed")
        event.closure.memoryOperations![0]!.sourcePerceptionIds = ["forged"];
      sync(value, commit.id);
    },
    (value: typeof archive) => {
      const commit = value.commits.at(-1)!;
      const event = commit.events[0];
      if (event?.type === "memory_operation") event.operation.actorId = "foreign";
      sync(value, commit.id);
    },
    (value: typeof archive) => {
      const commit = value.commits.at(-1)!;
      const event = commit.events[0];
      if (event?.type === "memory_operation") event.operation.memoryId = "foreign";
      sync(value, commit.id);
    },
    (value: typeof archive) => {
      const commit = value.commits.find((item) => item.kind === "episode_closure")!;
      const event = commit.events[0];
      if (event?.type === "episode_closed")
        event.closure.memoryOperations![0]!.closureCommitId = "foreign";
      sync(value, commit.id);
    },
    (value: typeof archive) => {
      const commit = value.commits.find((item) => item.kind === "episode_closure")!;
      const event = commit.events[0];
      if (event?.type === "episode_closed")
        event.closure.memoryOperations![0]!.basisCommitId = value.commits.at(-1)!.id;
      sync(value, commit.id);
    },
    (value: typeof archive) => {
      const commit = value.commits.find((item) => item.kind === "episode_closure")!;
      const event = commit.events[0];
      if (event?.type === "episode_closed")
        event.closure.memoryOperations![1]!.id = event.closure.memoryOperations![0]!.id;
      sync(value, commit.id);
    },
  ];
  const rejectedRoot = await mkdtemp(path.join(os.tmpdir(), "doxvelt-memory-rejected-"));
  const rejected = await openBranchStore(path.join(rejectedRoot, "runtime.sqlite")).open();
  t.after(async () => { rejected.close(); await rm(rejectedRoot, { recursive: true, force: true }); });
  for (const mutate of variants) {
    const forged = structuredClone(archive); mutate(forged);
    assert.throws(() => validateSimulationArchive(forged));
    assert.throws(() => rejected.importSimulation(forged));
    assert.equal(rejected.getSimulation("owner-a", "memory-sim"), null);
  }
});
