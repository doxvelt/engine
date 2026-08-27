import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  requestEpisodeClosure,
  runEpisodeMemoryJob,
} from "../src/core/branch-episode.ts";
import {
  commitManualTurn,
  forkBranch,
  inspectActorContext,
  projectBranch,
  startBranchSimulation,
} from "../src/core/branch-kernel.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import {
  BranchConflictError,
  CommandIdentityError,
  type ClosureRequestInput,
} from "../src/core/ports.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import {
  domainId,
  fingerprintCommand,
  recordCommand,
  stableStringify,
} from "../src/core/domain-rules.ts";

const workspace = path.resolve("examples/executive-interviews");

test("closure jobs are persistent, retryable, detached, and causally branch-aware", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-jobs-"));
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const started = await startBranchSimulation(store, {
    ownerScope: "owner",
    simulationId: "sim",
    commandId: "start",
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
  });
  const turn = commitManualTurn(store, {
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "turn",
    payload: {
      actorId: "ceo",
      text: "A private observation.",
      audience: ["ceo"],
    },
  });
  forkBranch(store, {
    ownerScope: "owner",
    simulationId: "sim",
    sourceBranchId: "main",
    expectedHead: turn.commit.id,
    atCommitId: turn.commit.id,
    branchId: "before",
    commandId: "fork-before",
  });
  let calls = 0;
  const requested = requestEpisodeClosure(store, {
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: turn.commit.id,
    commandId: "close",
    payload: { label: "Beat" },
  });
  assert.equal(calls, 0);
  assert.equal(requested.job.status, "pending");
  assert.equal(
    store.getBranch("owner", "sim", "main")?.headCommitId,
    requested.commit.id,
  );
  const replay = requestEpisodeClosure(store, {
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: turn.commit.id,
    commandId: "close",
    payload: { label: "Beat" },
  });
  assert.equal(replay.replayed, true);
  assert.throws(
    () =>
      requestEpisodeClosure(store, {
        ownerScope: "owner",
        simulationId: "sim",
        branchId: "main",
        expectedHead: turn.commit.id,
        commandId: "close",
        payload: { label: "Changed" },
      }),
    CommandIdentityError,
  );
  assert.throws(
    () =>
      requestEpisodeClosure(store, {
        ownerScope: "owner",
        simulationId: "sim",
        branchId: "main",
        expectedHead: turn.commit.id,
        commandId: "stale",
        payload: {},
      }),
    BranchConflictError,
  );
  forkBranch(store, {
    ownerScope: "owner",
    simulationId: "sim",
    sourceBranchId: "main",
    expectedHead: requested.commit.id,
    atCommitId: requested.commit.id,
    branchId: "after",
    commandId: "fork-after",
  });
  await assert.rejects(
    () =>
      runEpisodeMemoryJob(
        store,
        { ownerScope: "owner", simulationId: "sim", jobId: requested.job.id },
        {
          writeMemory() {
            calls++;
            throw new Error("temporary");
          },
          extractBeliefs() {
            return [];
          },
        },
      ),
    /temporary/,
  );
  assert.equal(store.listMemoryJobs("owner", "sim")[0]?.attemptCount, 1);
  assert.equal(store.listDetachedMemoryOperations("owner", "sim").length, 0);
  const completed = await runEpisodeMemoryJob(
    store,
    { ownerScope: "owner", simulationId: "sim", jobId: requested.job.id },
    {
      writeMemory() {
        calls++;
        return "I remember.";
      },
      extractBeliefs() {
        return [{ strength: 3, propositionText: "Board pressure is severe" }];
      },
    },
  );
  assert.equal(completed.job.status, "completed");
  assert.equal(completed.job.attemptCount, 2);
  assert.deepEqual(
    store.listMemoryJobTransitions("owner", "sim", requested.job.id)
      .map((item) => `${item.status}#${item.attempt}`),
    ["running#1", "failed#1", "running#2", "completed#2"],
  );
  assert.equal(
    projectBranch(store, {
      ownerScope: "owner",
      simulationId: "sim",
      branchId: "before",
    }).memoryOperations.length,
    0,
  );
  assert.equal(
    projectBranch(store, {
      ownerScope: "owner",
      simulationId: "sim",
      branchId: "after",
    }).memoryOperations.length,
    1,
  );
  const head = store.getBranch("owner", "sim", "main")?.headCommitId;
  const repeated = await runEpisodeMemoryJob(store, {
    ownerScope: "owner",
    simulationId: "sim",
    jobId: requested.job.id,
  });
  assert.equal(repeated.replayed, true);
  assert.equal(store.getBranch("owner", "sim", "main")?.headCommitId, head);
  assert.equal(store.listDetachedMemoryOperations("owner", "sim").length, 1);
  assert.deepEqual(repeated.closure, completed.closure);
  assert.equal(
    store.listMemoryJobTransitions("owner", "sim", requested.job.id).length,
    4,
  );
  const commitsBefore = structuredClone(
    store.listAncestors("owner", "sim", requested.commit.id),
  );
  const projectAtClosure = () =>
    projectBranch(store, {
      ownerScope: "owner",
      simulationId: "sim",
      branchId: "main",
      head: requested.commit.id,
    });
  const firstProjection = projectAtClosure();
  assert.deepEqual(projectAtClosure(), firstProjection);
  assert.deepEqual(
    store.listAncestors("owner", "sim", requested.commit.id),
    commitsBefore,
  );
  assert.equal(
    firstProjection.episodeMemories[0]?.episodeId,
    completed.closure.episode.id,
  );
  assert.equal(
    firstProjection.episodeMemories[0]?.id,
    completed.closure.memories[0]?.id,
  );
  assert.equal(
    firstProjection.episodeClosures[0]?.extractedBeliefs[0]?.propositionText,
    "Board pressure is severe",
  );
  assert.equal(
    inspectActorContext(store, {
      ownerScope: "owner",
      simulationId: "sim",
      branchId: "main",
      head: requested.commit.id,
      actorId: "ceo",
    }).subjective.beliefs.some(
      (belief) =>
        "propositionText" in belief &&
        belief.propositionText === "Board pressure is severe",
    ),
    true,
  );
  store.close();
  await store.open();
  assert.deepEqual(
    store.listMemoryJobTransitions("owner", "sim", requested.job.id)
      .map((item) => `${item.status}#${item.attempt}`),
    ["running#1", "failed#1", "running#2", "completed#2"],
  );
  assert.equal(
    projectAtClosure().episodeClosures[0]?.extractedBeliefs[0]?.propositionText,
    "Board pressure is severe",
  );
  const turn2 = commitManualTurn(store, {
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: head!,
    commandId: "turn-2",
    payload: { actorId: "ceo", text: "Pending episode.", audience: ["ceo"] },
  });
  const pending = requestEpisodeClosure(store, {
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: turn2.commit.id,
    commandId: "close-pending",
    payload: {},
  });
  const turn3 = commitManualTurn(store, {
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: pending.commit.id,
    commandId: "turn-3",
    payload: { actorId: "ceo", text: "Failed episode.", audience: ["ceo"] },
  });
  const failed = requestEpisodeClosure(store, {
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: turn3.commit.id,
    commandId: "close-failed",
    payload: {},
  });
  await assert.rejects(
    () =>
      runEpisodeMemoryJob(
        store,
        { ownerScope: "owner", simulationId: "sim", jobId: failed.job.id },
        {
          writeMemory() {
            throw new Error("provider token sk-secret-value");
          },
          extractBeliefs() {
            return [];
          },
        },
      ),
    /sk-secret-value/,
  );
  assert.equal(
    store.getMemoryJob("owner", "sim", failed.job.id)?.lastError,
    "Memory generation failed.",
  );
  const archive = store.exportSimulation("owner", "sim");
  validateSimulationArchive(archive);
  const target = await openBranchStore(
    path.join(root, "imported.sqlite"),
  ).open();
  target.importSimulation(structuredClone(archive));
  assert.deepEqual(
    target.listMemoryJobs("owner", "sim").map((job) => job.status),
    ["completed", "pending", "failed"],
  );
  assert.deepEqual(
    target.listMemoryJobTransitions("owner", "sim"),
    archive.memoryJobTransitions,
  );
  assert.equal(
    projectBranch(target, {
      ownerScope: "owner",
      simulationId: "sim",
      branchId: "after",
    }).memoryOperations.length,
    1,
  );
  target.close();
  const forged = structuredClone(archive);
  forged.detachedMemoryOperations![0]!.actorId = "cfo";
  assert.throws(() => validateSimulationArchive(forged));
  const variants: Array<(value: typeof archive) => void> = [
    (value) => {
      value.memoryJobs![0]!.resultFingerprint = "0".repeat(64);
    },
    (value) => {
      value.memoryJobs![0]!.result!.episode.id = "forged-episode";
      value.memoryJobs![0]!.resultFingerprint = fingerprint(
        value.memoryJobs![0]!.result,
      );
    },
    (value) => {
      value.memoryJobs![0]!.result!.extractedBeliefs[0]!.holder = "cfo";
      value.memoryJobs![0]!.resultFingerprint = fingerprint(
        value.memoryJobs![0]!.result,
      );
    },
    (value) => {
      value.detachedMemoryOperations = [];
    },
    (value) => {
      value.memoryJobs![1]!.result = structuredClone(
        value.memoryJobs![0]!.result,
      );
    },
    (value) => { value.memoryJobs![1]!.label = "forged"; },
    (value) => { value.memoryJobs![1]!.originBranchId = "after"; },
    (value) => { value.memoryJobs![2]!.basisHeadCommitId = value.commits[0]!.id; },
    (value) => { value.memoryJobs![2]!.createdAt = "2020-01-01T00:00:00.000Z"; },
    (value) => { value.memoryJobTransitions!.reverse(); },
    (value) => { value.memoryJobs![0]!.attemptCount = 99; },
    (value) => {
      value.memoryJobTransitions![0]!.result = structuredClone(
        value.memoryJobs![0]!.result,
      );
    },
    (value) => mutateCompletedOperation(value, (operation) => {
      operation.producer.mode = "manual";
    }),
    (value) => mutateCompletedOperation(value, (operation) => {
      operation.memoryKind = "long_term";
    }),
    (value) => {
      mutateCompletedOperation(value, (operation) => {
        if (operation.type === "asserted") operation.content = "";
      });
    },
    (value) => {
      value.memoryJobs![0]!.result!.memoryOperations = [];
      syncCompletedResult(value);
    },
    (value) => {
      value.memoryJobs![0]!.result!.memoryOperations!.push(
        structuredClone(value.memoryJobs![0]!.result!.memoryOperations![0]!),
      );
      syncCompletedResult(value);
    },
    (value) => {
      const operation = value.memoryJobs![0]!.result!
        .memoryOperations![0]! as unknown as Record<string, unknown>;
      operation.type = "consolidated";
      operation.memoryKind = "long_term";
      operation.episodeMemoryId = "forged";
      syncCompletedResult(value);
    },
    (value) => {
      value.memoryJobs![2]!.result = structuredClone(
        value.memoryJobs![0]!.result,
      );
    },
  ];
  for (const [index, mutate] of variants.entries()) {
    const invalid = structuredClone(archive);
    mutate(invalid);
    assert.throws(() => validateSimulationArchive(invalid));
    const audit = await openBranchStore(
      path.join(root, `audit-${index}.sqlite`),
    ).open();
    assert.throws(() => audit.importSimulation(invalid));
    assert.equal(audit.getSimulation("owner", "sim"), null);
    audit.close();
  }
});

test("schema-v4 closure archives deterministically upconvert to v5 jobs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-v4-"));
  const store = await openBranchStore(path.join(root, "source.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const started = await startBranchSimulation(store, {
    ownerScope: "owner",
    simulationId: "legacy",
    commandId: "start",
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
  });
  const turn = commitManualTurn(store, {
    ownerScope: "owner",
    simulationId: "legacy",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "turn",
    payload: { actorId: "ceo", text: "Legacy memory.", audience: ["ceo"] },
  });
  const requested = requestEpisodeClosure(store, {
    ownerScope: "owner",
    simulationId: "legacy",
    branchId: "main",
    expectedHead: turn.commit.id,
    commandId: "close",
    payload: {},
  });
  const run = await runEpisodeMemoryJob(store, {
    ownerScope: "owner",
    simulationId: "legacy",
    jobId: requested.job.id,
  });
  const legacy = store.exportSimulation("owner", "legacy");
  legacy.schemaVersion = 4;
  delete legacy.memoryJobs;
  delete legacy.memoryJobTransitions;
  delete legacy.detachedMemoryOperations;
  const commit = legacy.commits.find(
    (item) => item.id === requested.commit.id,
  )!;
  const event = commit.events[0];
  assert.equal(event?.type, "episode_closed");
  if (event?.type === "episode_closed")
    Object.assign(event.closure, run.closure);
  const command = legacy.commandResults.find(
    (item) => item.commandId === "close",
  )!;
  if (command.result.kind === "commit")
    command.result.commit = structuredClone(commit);
  const invalidMemory = structuredClone(legacy);
  const invalidMemoryCommit = invalidMemory.commits.find(
    (item) => item.id === requested.commit.id,
  )!;
  const invalidMemoryEvent = invalidMemoryCommit.events[0];
  if (invalidMemoryEvent?.type === "episode_closed")
    invalidMemoryEvent.closure.memories[0]!.actorId = "cfo";
  const invalidMemoryCommand = invalidMemory.commandResults.find(
    (item) => item.commandId === "close",
  )!;
  if (invalidMemoryCommand.result.kind === "commit")
    invalidMemoryCommand.result.commit = structuredClone(invalidMemoryCommit);
  assert.throws(() => validateSimulationArchive(invalidMemory));
  const invalidBelief = structuredClone(legacy);
  const invalidBeliefCommit = invalidBelief.commits.find(
    (item) => item.id === requested.commit.id,
  )!;
  const invalidBeliefEvent = invalidBeliefCommit.events[0];
  if (invalidBeliefEvent?.type === "episode_closed")
    invalidBeliefEvent.closure.extractedBeliefs[0]!.memoryId = "forged";
  const invalidBeliefCommand = invalidBelief.commandResults.find(
    (item) => item.commandId === "close",
  )!;
  if (invalidBeliefCommand.result.kind === "commit")
    invalidBeliefCommand.result.commit = structuredClone(invalidBeliefCommit);
  assert.throws(() => validateSimulationArchive(invalidBelief));
  const invalidProvenance = structuredClone(legacy);
  const invalidProvenanceCommit = invalidProvenance.commits.find(
    (item) => item.id === requested.commit.id,
  )!;
  const invalidProvenanceEvent = invalidProvenanceCommit.events[0];
  if (invalidProvenanceEvent?.type === "episode_closed")
    invalidProvenanceEvent.closure.memories[0]!.sourcePerceptionIds = ["forged"];
  const invalidProvenanceCommand = invalidProvenance.commandResults.find(
    (item) => item.commandId === "close",
  )!;
  if (invalidProvenanceCommand.result.kind === "commit")
    invalidProvenanceCommand.result.commit = structuredClone(invalidProvenanceCommit);
  assert.throws(() => validateSimulationArchive(invalidProvenance));
  validateSimulationArchive(legacy);
  const normalized = legacy as {
    schemaVersion: number;
    memoryJobs?: Array<{
      status: string;
      result?: { extractedBeliefs: unknown[] } | null;
    }>;
  };
  assert.equal(normalized.schemaVersion, 5);
  assert.equal(normalized.memoryJobs?.[0]?.status, "completed");
  assert.ok(normalized.memoryJobs?.[0]?.result?.extractedBeliefs.length);
  const target = await openBranchStore(path.join(root, "target.sqlite")).open();
  target.importSimulation(legacy);
  assert.ok(projectBranch(target, {
    ownerScope: "owner", simulationId: "legacy", branchId: "main",
  }).episodeClosures[0]?.extractedBeliefs.length);
  target.close();
});

test("closure repository guards parent consistency and rolls back atomically", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-closure-parent-"));
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const started = await startBranchSimulation(store, {
    ownerScope: "owner", simulationId: "parent", commandId: "start",
    workspacePath: workspace, branchId: "main",
  });
  const turn = commitManualTurn(store, {
    ownerScope: "owner", simulationId: "parent", branchId: "main",
    expectedHead: started.root.id, commandId: "turn",
    payload: { actorId: "ceo", text: "Accepted turn.", audience: [] },
  });
  const invalid = closureRequest(
    "owner", "parent", "main", turn.commit.id, "close-invalid",
    started.root.id,
  );
  assert.throws(() => store.requestClosure(invalid), /parent/);
  assert.equal(
    store.getBranch("owner", "parent", "main")?.headCommitId,
    turn.commit.id,
  );
  assert.equal(store.getCommit("owner", "parent", invalid.commit.id), null);
  assert.equal(store.getMemoryJob("owner", "parent", invalid.job.id), null);
  assert.equal(store.replayCommand(
    "owner", "parent", invalid.commit.commandId, invalid.commandFingerprint,
  ), null);
});

test("detached checkpoints require open turns in every job state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-empty-checkpoint-"));
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const started = await startBranchSimulation(store, {
    ownerScope: "owner", simulationId: "checkpoints", commandId: "start",
    workspacePath: workspace, branchId: "main",
  });
  const turn = commitManualTurn(store, {
    ownerScope: "owner", simulationId: "checkpoints", branchId: "main",
    expectedHead: started.root.id, commandId: "turn",
    payload: { actorId: "ceo", text: "Close me.", audience: [] },
  });
  const first = requestEpisodeClosure(store, {
    ownerScope: "owner", simulationId: "checkpoints", branchId: "main",
    expectedHead: turn.commit.id, commandId: "close-1", payload: {},
  });
  const second = closureRequest(
    "owner", "checkpoints", "main", first.commit.id, "close-2",
  );
  store.requestClosure(second);
  const invalid = () => validateSimulationArchive(
    store.exportSimulation("owner", "checkpoints"),
  );
  assert.throws(invalid, /no open turns/);
  const running = store.startMemoryJob("owner", "checkpoints", second.job.id);
  assert.throws(invalid, /no open turns/);
  store.failMemoryJob(running, "failed");
  assert.throws(invalid, /no open turns/);
});

test("job state ignores wall-clock rollback between lifecycle transitions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-clock-rollback-"));
  const dbPath = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(dbPath).open();
  const started = await startBranchSimulation(store, {
    ownerScope: "owner", simulationId: "clock", commandId: "start",
    workspacePath: workspace, branchId: "main",
  });
  const turn = commitManualTurn(store, {
    ownerScope: "owner", simulationId: "clock", branchId: "main",
    expectedHead: started.root.id, commandId: "turn",
    payload: { actorId: "ceo", text: "Remember me.", audience: [] },
  });
  const requested = requestEpisodeClosure(store, {
    ownerScope: "owner", simulationId: "clock", branchId: "main",
    expectedHead: turn.commit.id, commandId: "close", payload: {},
  });
  await runEpisodeMemoryJob(store, {
    ownerScope: "owner", simulationId: "clock", jobId: requested.job.id,
  });
  store.close();
  const database = new DatabaseSync(dbPath);
  database.prepare(
    "UPDATE memory_job_transitions SET created_at = ? WHERE job_id = ? AND status = 'completed'",
  ).run("1900-01-01T00:00:00.000Z", requested.job.id);
  database.close();
  const reopened = await openBranchStore(dbPath).open();
  t.after(async () => { reopened.close(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(
    reopened.listMemoryJobTransitions("owner", "clock", requested.job.id)
      .map((item) => item.status),
    ["running", "completed"],
  );
  assert.equal(
    reopened.getMemoryJob("owner", "clock", requested.job.id)?.status,
    "completed",
  );
  validateSimulationArchive(reopened.exportSimulation("owner", "clock"));
});

function closureRequest(
  ownerScope: string,
  simulationId: string,
  branchId: string,
  expectedHead: string,
  commandId: string,
  parentCommitId = expectedHead,
): ClosureRequestInput {
  const command = {
    ownerScope, simulationId, branchId, expectedHead, commandId,
    payload: { label: null },
  };
  const recorded = recordCommand("closure", command);
  const createdAt = new Date().toISOString();
  const commitId = domainId("commit", ownerScope, simulationId, commandId);
  const episodeId = domainId("episode", commandId);
  return {
    branchId,
    expectedHead,
    commandInput: recorded,
    commandFingerprint: fingerprintCommand(recorded),
    commit: {
      id: commitId,
      ownerScope,
      simulationId,
      parentCommitId,
      kind: "episode_closure",
      commandId,
      events: [{
        type: "episode_closed",
        closure: {
          episode: {
            id: episodeId,
            simulationId,
            commitId,
            label: null,
            closedAt: createdAt,
          },
          memories: [],
          longTermMemories: [],
          extractedBeliefs: [],
          retainedBeliefs: [],
          memoryOperations: [],
        },
      }],
      createdAt,
    },
    job: {
      id: domainId("memory_job", ownerScope, simulationId, commandId),
      ownerScope,
      simulationId,
      originBranchId: branchId,
      episodeId,
      closureCommitId: commitId,
      basisHeadCommitId: expectedHead,
      commandId,
      label: null,
      status: "pending",
      attemptCount: 0,
      resultFingerprint: null,
      result: null,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function mutateCompletedOperation(
  archive: Parameters<typeof validateSimulationArchive>[0],
  mutate: (operation: NonNullable<typeof archive.detachedMemoryOperations>[number]) => void,
): void {
  mutate(archive.memoryJobs![0]!.result!.memoryOperations![0]!);
  syncCompletedResult(archive);
}

function syncCompletedResult(
  archive: Parameters<typeof validateSimulationArchive>[0],
): void {
  const job = archive.memoryJobs![0]!;
  job.resultFingerprint = fingerprint(job.result);
  archive.detachedMemoryOperations = structuredClone(job.result!.memoryOperations!);
  const completed = archive.memoryJobTransitions!.find(
    (item) => item.jobId === job.id && item.status === "completed",
  )!;
  completed.result = structuredClone(job.result);
  completed.resultFingerprint = job.resultFingerprint;
}
