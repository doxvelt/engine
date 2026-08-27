import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeBranchEpisode } from "../src/core/branch-episode.ts";
import { compileWorkspace } from "../src/core/compiler.ts";
import {
  commitManualTurn,
  commitRuntimeEffects,
  editAcceptedMessage,
  fingerprintCommand,
  forkBranch,
  regenerateAcceptedResponse,
  stageWhisper,
  startBranchSimulation,
  startBranchSimulationFromCompiled,
} from "../src/core/branch-kernel.ts";
import type { SimulationArchive } from "../src/core/ports.ts";
import { stableStringify } from "../src/core/domain-rules.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

const workspace = path.resolve("examples/executive-interviews");

async function fixture(t: test.TestContext, simulationId: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-verifier-"));
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const started = await startBranchSimulation(store, {
    ownerScope: "local",
    simulationId,
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
    commandId: `${simulationId}-start`,
  });
  return { root, store, started };
}

function syncCommitResult(archive: SimulationArchive, commitId: string): void {
  const commit = archive.commits.find((item) => item.id === commitId)!;
  const command = archive.commandResults.find(
    (item) => item.commandId === commit.commandId,
  )!;
  (command.result as { commit: unknown }).commit = structuredClone(commit);
}

function expectRejected(archive: SimulationArchive): void {
  assert.throws(() => validateSimulationArchive(archive));
}

test("archive import rejects access self-cycles and transitive cycles", async (t) => {
  const { root, store, started } = await fixture(t, "access-cycles");
  const turn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "access-cycles",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "cycle-turn",
    payload: { actorId: "ceo", text: "Cycle attempt", audience: [] },
  });
  const original = store.exportSimulation("local", "access-cycles");
  const variants = [
    [{ action: "grant", member: "ceo", container: "ceo", reason: null }],
    [
      { action: "grant", member: "ceo", container: "cfo", reason: null },
      { action: "grant", member: "cfo", container: "ceo", reason: null },
    ],
  ] as const;
  for (const [index, changes] of variants.entries()) {
    const archive = structuredClone(original);
    const command = archive.commandResults.find(
      (item) => item.commandId === "cycle-turn",
    )!;
    if (command.canonicalInput.kind !== "turn") throw new Error("Missing turn");
    command.canonicalInput.payload.accessChanges = [...changes];
    command.fingerprint = fingerprintCommand(command.canonicalInput);
    const commit = archive.commits.find((item) => item.id === turn.commit.id)!;
    commit.events.splice(1, 0, ...changes.map((change) => ({
      type: "access_changed" as const,
      ...change,
      mode: "member" as const,
    })));
    syncCommitResult(archive, commit.id);
    const target = await openBranchStore(path.join(root, `cycle-${index}.sqlite`)).open();
    try {
      assert.throws(() => validateSimulationArchive(archive), /cycle|itself/);
      assert.equal(target.getSimulation("local", "access-cycles"), null);
    } finally {
      target.close();
    }
  }
});

test("manual turn provenance is derived from the command", async (t) => {
  const { store, started } = await fixture(t, "derived-provenance");
  const result = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "derived-provenance",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "derived-turn",
    payload: {
      actorId: "ceo",
      text: "Canonical",
      audience: [],
      logicalMessageId: "caller-controlled",
      operation: "edit",
    },
  });
  const event = result.commit.events.find((item) => item.type === "message_accepted");
  assert.equal(event?.type, "message_accepted");
  if (event?.type !== "message_accepted") throw new Error("Missing message");
  assert.notEqual(event.message.logicalMessageId, "caller-controlled");
  assert.equal(event.message.provenance.operation, "turn");
  const archive = store.exportSimulation("local", "derived-provenance");
  const command = archive.commandResults.find((item) => item.commandId === "derived-turn")!;
  if (command.canonicalInput.kind !== "turn") throw new Error("Missing turn command");
  assert.equal("logicalMessageId" in command.canonicalInput.payload, false);
  assert.equal("operation" in command.canonicalInput.payload, false);
  validateSimulationArchive(archive);
});

test("archive validates compiled content even for revision-ID starts", async (t) => {
  const { store } = await fixture(t, "malformed-content");
  const archive = store.exportSimulation("local", "malformed-content");
  const start = archive.commandResults[0]!;
  if (start.canonicalInput.kind !== "start") throw new Error("Missing start");
  delete (start.canonicalInput as { compiled?: unknown }).compiled;
  (start.canonicalInput as { contentRevisionId?: string }).contentRevisionId =
    archive.contentRevision.id;
  start.fingerprint = fingerprintCommand(start.canonicalInput);
  (archive.contentRevision.compiled.entities[0] as { kind: string }).kind = "invalid";
  archive.contentRevision.digest = createHash("sha256").update(stableStringify({
    ...archive.contentRevision.compiled, sourceRoot: "",
  })).digest("hex");
  assert.throws(() => validateSimulationArchive(archive), /entity kind/);
});

test("episode closures require at least one open turn", async (t) => {
  const { store, started } = await fixture(t, "empty-closure");
  const turn = commitManualTurn(store, {
    ownerScope: "local", simulationId: "empty-closure", branchId: "main",
    expectedHead: started.root.id, commandId: "closure-turn",
    payload: { actorId: "ceo", text: "Turn", audience: [] },
  });
  const closed = await closeBranchEpisode(store, {
    ownerScope: "local", simulationId: "empty-closure", branchId: "main",
    expectedHead: turn.commit.id, commandId: "closure-close", payload: {},
  });
  const archive = store.exportSimulation("local", "empty-closure");
  const turnCommit = archive.commits.find((item) => item.id === turn.commit.id)!;
  turnCommit.events = [];
  syncCommitResult(archive, turn.commit.id);
  const closureCommand = archive.commandResults.find(
    (item) => item.commandId === closed.commit.commandId,
  )!;
  archive.commandResults = [
    closureCommand,
    ...archive.commandResults.filter((item) => item !== closureCommand),
  ];
  assert.throws(() => validateSimulationArchive(archive), /no open turns/);
});

test("stateless actors survive export, verification, and import", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-stateless-"));
  const source = await openBranchStore(path.join(root, "source.sqlite")).open();
  const target = await openBranchStore(path.join(root, "target.sqlite")).open();
  t.after(async () => {
    source.close();
    target.close();
    await rm(root, { recursive: true, force: true });
  });
  const compiled = await compileWorkspace(workspace);
  const actor = compiled.entities.find((entity) => entity.id === "ceo")!;
  actor.kind = "stateless";
  const started = startBranchSimulationFromCompiled(source, {
    ownerScope: "local",
    simulationId: "stateless-roundtrip",
    scenarioId: "executive-interviews",
    branchId: "main",
    commandId: "stateless-start",
    compiled,
  });
  commitManualTurn(source, {
    ownerScope: "local",
    simulationId: "stateless-roundtrip",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "stateless-turn",
    payload: { actorId: "ceo", text: "Generated without memory.", audience: [] },
  });
  const archive = source.exportSimulation("local", "stateless-roundtrip");
  validateSimulationArchive(archive);
  target.importSimulation(archive);
  assert.equal(target.exportSimulation("local", "stateless-roundtrip").commits.length, 2);
});

test("branch origins make equal timestamps portable without wall-clock inference", async (t) => {
  const { store, started } = await fixture(t, "equal-time");
  const turn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "equal-time",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "equal-turn",
    payload: { actorId: "ceo", text: "Original", audience: ["cfo"] },
  });
  editAcceptedMessage(store, {
    ownerScope: "local",
    simulationId: "equal-time",
    sourceBranchId: "main",
    sourceCommitId: turn.commit.id,
    expectedHead: turn.commit.id,
    branchId: "edit",
    commandId: "equal-edit",
    payload: { actorId: "ceo", text: "Edited", audience: ["cfo"] },
  });
  regenerateAcceptedResponse(store, {
    ownerScope: "local",
    simulationId: "equal-time",
    sourceBranchId: "main",
    sourceCommitId: turn.commit.id,
    expectedHead: turn.commit.id,
    branchId: "regenerate",
    commandId: "equal-regenerate",
    payload: { actorId: "ceo", text: "Regenerated", audience: ["cfo"] },
  });
  forkBranch(store, {
    ownerScope: "local",
    simulationId: "equal-time",
    sourceBranchId: "main",
    expectedHead: turn.commit.id,
    atCommitId: started.root.id,
    branchId: "fork",
    commandId: "equal-fork",
  });
  const archive = store.exportSimulation("local", "equal-time");
  for (const commit of archive.commits) commit.createdAt = "2026-01-01T00:00:00.000Z";
  for (const branch of archive.branches) branch.createdAt = "2026-01-01T00:00:00.000Z";
  for (const command of archive.commandResults) {
    command.createdAt = "2026-01-01T00:00:00.000Z";
    if (typeof command.result !== "object" || command.result === null) continue;
    const result = command.result as Record<string, unknown>;
    if (result.commit && typeof result.commit === "object")
      (result.commit as { createdAt: string }).createdAt = "2026-01-01T00:00:00.000Z";
    if (result.root && typeof result.root === "object")
      (result.root as { createdAt: string }).createdAt = "2026-01-01T00:00:00.000Z";
    if (result.branch && typeof result.branch === "object")
      (result.branch as { createdAt: string }).createdAt = "2026-01-01T00:00:00.000Z";
  }
  validateSimulationArchive(archive);
});

test("verifier rejects cyclic branch-origin ancestry", async (t) => {
  const { store, started } = await fixture(t, "origin-cycle");
  const turn = commitManualTurn(store, {
    ownerScope: "local", simulationId: "origin-cycle", branchId: "main",
    expectedHead: started.root.id, commandId: "origin-turn",
    payload: { actorId: "ceo", text: "Turn", audience: [] },
  });
  forkBranch(store, {
    ownerScope: "local", simulationId: "origin-cycle", sourceBranchId: "main",
    expectedHead: turn.commit.id, atCommitId: started.root.id,
    branchId: "fork", commandId: "origin-fork",
  });
  const archive = store.exportSimulation("local", "origin-cycle");
  const main = archive.branches.find((item) => item.id === "main")!;
  const fork = archive.branches.find((item) => item.id === "fork")!;
  main.origin = {
    kind: "fork", commandId: "origin-fork", sourceBranchId: "fork",
    sourceHeadCommitId: fork.headCommitId, baseCommitId: started.root.id,
  };
  if (fork.origin.kind === "root") throw new Error("Fork has root origin");
  fork.origin = { ...fork.origin, sourceBranchId: "main" };
  assert.throws(() => validateSimulationArchive(archive), /branch-origin cycle/);
});

test("verifier binds every branch origin to its creating command kind", async (t) => {
  const { store, started } = await fixture(t, "origin-command-kind");
  const mainTurn = commitManualTurn(store, {
    ownerScope: "local", simulationId: "origin-command-kind", branchId: "main",
    expectedHead: started.root.id, commandId: "origin-main-turn",
    payload: { actorId: "ceo", text: "Main", audience: [] },
  });
  forkBranch(store, {
    ownerScope: "local", simulationId: "origin-command-kind",
    sourceBranchId: "main", expectedHead: mainTurn.commit.id,
    atCommitId: started.root.id, branchId: "fork", commandId: "origin-fork",
  });
  const forkTurn = commitManualTurn(store, {
    ownerScope: "local", simulationId: "origin-command-kind", branchId: "fork",
    expectedHead: started.root.id, commandId: "origin-fork-turn",
    payload: { actorId: "ceo", text: "Fork", audience: [] },
  });
  const original = store.exportSimulation("local", "origin-command-kind");
  const replaceCreatingCommand = (
    archive: SimulationArchive,
    origin: SimulationArchive["branches"][number]["origin"],
  ): void => {
    const branch = archive.branches.find((item) => item.id === "fork")!;
    branch.origin = origin;
    const turnCommand = archive.commandResults.find(
      (item) => item.commandId === "origin-fork-turn",
    )!;
    if (turnCommand.result.kind !== "commit") throw new Error("Missing turn result");
    turnCommand.result.branch.origin = structuredClone(origin);
    archive.commandResults = archive.commandResults.filter(
      (item) => item.commandId !== "origin-fork",
    );
  };
  const variants: Array<(archive: SimulationArchive) => void> = [
    (archive) => {
      const branch = archive.branches.find((item) => item.id === "fork")!;
      if (branch.origin.kind === "root") throw new Error("Fork has root origin");
      replaceCreatingCommand(archive, {
        ...branch.origin,
        commandId: "origin-fork-turn",
      });
    },
    (archive) => replaceCreatingCommand(archive, {
      kind: "root",
      commandId: "origin-fork-turn",
      baseCommitId: forkTurn.commit.id,
    }),
  ];
  for (const mutate of variants) {
    const archive = structuredClone(original);
    mutate(archive);
    assert.throws(
      () => validateSimulationArchive(archive),
      /branch provenance|exactly one root|root branch origin/,
    );
  }
});

test("canonical commits, branches, and whispers require exact command provenance", async (t) => {
  const { store, started } = await fixture(t, "command-provenance");
  const turn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "command-provenance",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "provenance-turn",
    payload: { actorId: "ceo", text: "A turn", audience: ["cfo"] },
  });
  forkBranch(store, {
    ownerScope: "local",
    simulationId: "command-provenance",
    sourceBranchId: "main",
    expectedHead: turn.commit.id,
    atCommitId: started.root.id,
    branchId: "fork",
    commandId: "provenance-fork",
  });
  stageWhisper(store, {
    ownerScope: "local",
    simulationId: "command-provenance",
    branchId: "main",
    expectedHead: turn.commit.id,
    commandId: "provenance-whisper",
    targetActorId: "ceo",
    text: "Private",
  });
  const original = store.exportSimulation("local", "command-provenance");
  const variants: Array<(archive: SimulationArchive) => void> = [
    (archive) => {
      archive.commandResults = archive.commandResults.filter(
        (item) => item.commandId !== "provenance-turn",
      );
    },
    (archive) => {
      archive.commandResults = archive.commandResults.filter(
        (item) => item.commandId !== "provenance-fork",
      );
    },
    (archive) => {
      archive.commandResults.push(structuredClone(archive.commandResults[0]!));
    },
    (archive) => {
      const branch = archive.branches.find((item) => item.id === "fork")!;
      if (branch.origin.kind !== "root") branch.origin.baseCommitId = turn.commit.id;
    },
    (archive) => {
      archive.commandResults.push({
        commandId: "orphan",
        canonicalInput: {
          kind: "turn",
          ownerScope: "local",
          simulationId: "command-provenance",
          commandId: "orphan",
        } as never,
        fingerprint: "",
        result: {} as never,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      archive.commandResults.at(-1)!.fingerprint = fingerprintCommand(
        archive.commandResults.at(-1)!.canonicalInput,
      );
    },
  ];
  for (const mutate of variants) {
    const archive = structuredClone(original);
    mutate(archive);
    expectRejected(archive);
  }
});

test("verifier rejects unauthorized, reordered, forged, and root events", async (t) => {
  const { store, started } = await fixture(t, "event-sequence");
  const turn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "event-sequence",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "sequence-turn",
    payload: {
      actorId: "ceo",
      text: "Observed",
      audience: ["cfo"],
      audienceChanges: [{ actorId: "cfo", action: "add" }],
    },
  });
  const original = store.exportSimulation("local", "event-sequence");
  const variants: Array<(archive: SimulationArchive) => void> = [
    (archive) => {
      archive.commits[0]!.events.push({
        type: "audience_changed",
        actorId: "ceo",
        action: "add",
        reason: null,
      });
      syncCommitResult(archive, archive.commits[0]!.id);
    },
    (archive) => {
      archive.commits[1]!.events.push({
        type: "episode_closed",
        closure: {
          episode: {
            id: "extra",
            simulationId: "event-sequence",
            label: null,
            closedAt: "2026-01-01T00:00:00.000Z",
          },
          memories: [],
          longTermMemories: [],
          extractedBeliefs: [],
          retainedBeliefs: [],
        },
      });
      syncCommitResult(archive, turn.commit.id);
    },
    (archive) => {
      const events = archive.commits[1]!.events;
      const impressionIndex = events.findIndex(
        (event) => event.type === "first_impression_formed",
      );
      const [impression] = events.splice(impressionIndex, 1);
      events.splice(1, 0, impression!);
      syncCommitResult(archive, turn.commit.id);
    },
    (archive) => {
      const impression = archive.commits[1]!.events.find(
        (event) => event.type === "first_impression_formed",
      );
      if (impression?.type === "first_impression_formed")
        impression.impression.propositionText = "Forged impression";
      syncCommitResult(archive, turn.commit.id);
    },
    (archive) => {
      const message = archive.commits[1]!.events[0];
      if (message?.type === "message_accepted") message.message.id = "wrong";
      syncCommitResult(archive, turn.commit.id);
    },
  ];
  for (const mutate of variants) {
    const archive = structuredClone(original);
    mutate(archive);
    expectRejected(archive);
  }
});

test("verifier rejects empty turns, no-op effects, and forged commit IDs", async (t) => {
  const { store, started } = await fixture(t, "command-invariants");
  const turn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "command-invariants",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "invariant-turn",
    payload: { actorId: "ceo", text: "Valid", audience: [] },
  });
  const effects = commitRuntimeEffects(store, {
    ownerScope: "local",
    simulationId: "command-invariants",
    branchId: "main",
    expectedHead: turn.commit.id,
    commandId: "invariant-effects",
    payload: {
      audienceChanges: [{ actorId: "cfo", action: "add" }],
    },
  });
  const original = store.exportSimulation("local", "command-invariants");
  const variants: Array<(archive: SimulationArchive) => void> = [
    (archive) => {
      const command = archive.commandResults.find(
        (item) => item.commandId === "invariant-turn",
      )!;
      if (command.canonicalInput.kind !== "turn") throw new Error("Missing turn");
      command.canonicalInput.payload.text = "";
      command.fingerprint = fingerprintCommand(command.canonicalInput);
      const commit = archive.commits.find((item) => item.id === turn.commit.id)!;
      const event = commit.events[0];
      if (event?.type !== "message_accepted") throw new Error("Missing message");
      event.message.text = "";
      syncCommitResult(archive, commit.id);
    },
    (archive) => {
      const command = archive.commandResults.find(
        (item) => item.commandId === "invariant-effects",
      )!;
      if (command.canonicalInput.kind !== "effects")
        throw new Error("Missing effects");
      command.canonicalInput.payload = {};
      command.fingerprint = fingerprintCommand(command.canonicalInput);
      const commit = archive.commits.find((item) => item.id === effects.commit.id)!;
      commit.events = [];
      syncCommitResult(archive, commit.id);
    },
    (archive) => {
      const commit = archive.commits.find((item) => item.id === effects.commit.id)!;
      commit.id = "forged-effects-commit";
      const branch = archive.branches.find((item) => item.id === "main")!;
      branch.headCommitId = commit.id;
      const command = archive.commandResults.find(
        (item) => item.commandId === "invariant-effects",
      )!;
      if (command.result.kind !== "commit") throw new Error("Missing outcome");
      command.result.commit = structuredClone(commit);
      command.result.branch.headCommitId = commit.id;
    },
  ];
  for (const [index, mutate] of variants.entries()) {
    const archive = structuredClone(original);
    mutate(archive);
    let rejected = false;
    try {
      validateSimulationArchive(archive);
    } catch {
      rejected = true;
    }
    assert.equal(rejected, true, `command invariant variant ${index}`);
  }
});

test("closure records reject foreign, dangling, inaccessible, and non-ancestor provenance", async (t) => {
  const { store, started } = await fixture(t, "closure-provenance");
  const turn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "closure-provenance",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "closure-turn",
    payload: { actorId: "ceo", text: "Private", audience: ["ceo"] },
  });
  const closed = await closeBranchEpisode(store, {
    ownerScope: "local",
    simulationId: "closure-provenance",
    branchId: "main",
    expectedHead: turn.commit.id,
    commandId: "closure-close",
    payload: { label: "Review" },
  });
  const future = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "closure-provenance",
    branchId: "main",
    expectedHead: closed.commit.id,
    commandId: "closure-future",
    payload: { actorId: "ceo", text: "Future", audience: ["ceo"] },
  });
  const original = store.exportSimulation("local", "closure-provenance");
  const mutateClosure = (
    archive: SimulationArchive,
    mutate: (closure: typeof closed.closure) => void,
  ) => {
    const commit = archive.commits.find((item) => item.id === closed.commit.id)!;
    const event = commit.events[0];
    if (!event || event.type !== "episode_closed")
      throw new Error("Missing closure");
    mutate(event.closure);
    syncCommitResult(archive, commit.id);
  };
  const variants: Array<(archive: SimulationArchive) => void> = [
    (archive) => mutateClosure(archive, (closure) => {
      closure.episode.simulationId = "foreign";
    }),
    (archive) => mutateClosure(archive, (closure) => {
      closure.memories[0]!.episodeId = "foreign";
    }),
    (archive) => mutateClosure(archive, (closure) => {
      closure.memories[0]!.actorId = "missing";
    }),
    (archive) => mutateClosure(archive, (closure) => {
      closure.memories[0]!.sourceTurnIds = ["missing-turn"];
    }),
    (archive) => mutateClosure(archive, (closure) => {
      closure.memories[0]!.sourceTurnIds = [];
    }),
    (archive) => mutateClosure(archive, (closure) => {
      const event = future.commit.events[0];
      if (!event || event.type !== "message_accepted")
        throw new Error("Missing future turn");
      closure.memories[0]!.sourceTurnIds = [event.message.id];
    }),
    (archive) => mutateClosure(archive, (closure) => {
      closure.memories[0]!.actorId = "cfo";
    }),
    (archive) => mutateClosure(archive, (closure) => {
      closure.extractedBeliefs[0]!.memoryId = "missing-memory";
    }),
    (archive) => mutateClosure(archive, (closure) => {
      closure.episode.commitId = started.root.id;
    }),
  ];
  for (const mutate of variants) {
    const archive = structuredClone(original);
    mutate(archive);
    expectRejected(archive);
  }
});

test("retained beliefs require the ancestor revoke that actually caused access loss", async (t) => {
  const { store, started } = await fixture(t, "retained-provenance");
  const granted = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "retained-provenance",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "retained-grant",
    payload: {
      actorId: "coo",
      text: "Access granted",
      audience: [],
      accessChanges: [{ action: "grant", member: "coo", container: "ceo" }],
    },
  });
  const revoked = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "retained-provenance",
    branchId: "main",
    expectedHead: granted.commit.id,
    commandId: "retained-revoke",
    payload: {
      actorId: "coo",
      text: "Access revoked",
      audience: [],
      accessChanges: [{ action: "revoke", member: "coo", container: "ceo" }],
    },
  });
  const noop = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "retained-provenance",
    branchId: "main",
    expectedHead: revoked.commit.id,
    commandId: "retained-noop",
    payload: {
      actorId: "coo",
      text: "Still revoked",
      audience: [],
      accessChanges: [{ action: "revoke", member: "coo", container: "ceo" }],
    },
  });
  const closed = await closeBranchEpisode(store, {
    ownerScope: "local",
    simulationId: "retained-provenance",
    branchId: "main",
    expectedHead: noop.commit.id,
    commandId: "retained-close",
    payload: {},
  });
  const original = store.exportSimulation("local", "retained-provenance");
  const retained = closed.closure.retainedBeliefs.find(
    (belief) => belief.holder === "coo" && belief.sourceHolder === "ceo",
  );
  assert.ok(retained);
  for (const eventId of [
    `${noop.commit.id}:event:1`,
    `${closed.commit.id}:event:0`,
    "missing:event:0",
  ]) {
    const archive = structuredClone(original);
    const commit = archive.commits.find((item) => item.id === closed.commit.id)!;
    const event = commit.events[0];
    if (!event || event.type !== "episode_closed")
      throw new Error("Missing closure");
    const belief = event.closure.retainedBeliefs.find(
      (item) => item.id === retained.id,
    )!;
    belief.runtimeAccessEventId = eventId;
    syncCommitResult(archive, commit.id);
    expectRejected(archive);
  }
  {
    const archive = structuredClone(original);
    const commit = archive.commits.find((item) => item.id === closed.commit.id)!;
    const event = commit.events[0];
    if (!event || event.type !== "episode_closed") throw new Error("Missing closure");
    event.closure.retainedBeliefs = [];
    syncCommitResult(archive, commit.id);
    expectRejected(archive);
  }
  {
    const archive = structuredClone(original);
    const replacement = archive.contentRevision.compiled.beliefs.find(
      (belief) => belief.propositionText !== retained.sourceBelief.propositionText,
    );
    assert.ok(replacement);
    const commit = archive.commits.find((item) => item.id === closed.commit.id)!;
    const event = commit.events[0];
    if (!event || event.type !== "episode_closed") throw new Error("Missing closure");
    const belief = event.closure.retainedBeliefs.find(
      (item) => item.id === retained.id,
    )!;
    belief.sourceBelief = replacement;
    syncCommitResult(archive, commit.id);
    expectRejected(archive);
  }
});

test("retained provenance rejects a revoke while an alternate path remained", async (t) => {
  const { store, started } = await fixture(t, "retained-alternate-path");
  const granted = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "retained-alternate-path",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "alternate-grant",
    payload: {
      actorId: "cfo",
      text: "Two paths remain.",
      audience: ["cfo"],
      accessChanges: [
        { action: "grant", member: "cfo", container: "coo" },
        { action: "grant", member: "coo", container: "ceo" },
      ],
    },
  });
  const directRevoke = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "retained-alternate-path",
    branchId: "main",
    expectedHead: granted.commit.id,
    commandId: "alternate-direct-revoke",
    payload: {
      actorId: "cfo",
      text: "The alternate path still works.",
      audience: ["cfo"],
      accessChanges: [{ action: "revoke", member: "cfo", container: "ceo" }],
    },
  });
  const causalRevoke = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "retained-alternate-path",
    branchId: "main",
    expectedHead: directRevoke.commit.id,
    commandId: "alternate-causal-revoke",
    payload: {
      actorId: "cfo",
      text: "The alternate path is now gone.",
      audience: ["cfo"],
      accessChanges: [{ action: "revoke", member: "cfo", container: "coo" }],
    },
  });
  const closed = await closeBranchEpisode(store, {
    ownerScope: "local",
    simulationId: "retained-alternate-path",
    branchId: "main",
    expectedHead: causalRevoke.commit.id,
    commandId: "alternate-close",
    payload: {},
  });
  const archive = store.exportSimulation("local", "retained-alternate-path");
  const commit = archive.commits.find((item) => item.id === closed.commit.id)!;
  const event = commit.events[0];
  if (!event || event.type !== "episode_closed")
    throw new Error("Missing closure");
  const belief = event.closure.retainedBeliefs.find(
    (item) => item.holder === "cfo" && item.sourceHolder === "ceo",
  );
  assert.ok(belief);
  belief.runtimeAccessEventId = `${directRevoke.commit.id}:event:1`;
  syncCommitResult(archive, commit.id);
  expectRejected(archive);
});

test("padded stage-whisper retries use one normalized fingerprint", async (t) => {
  const { store, started } = await fixture(t, "padded-whisper");
  const command = {
    ownerScope: "local",
    simulationId: "padded-whisper",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "padded-command",
    targetActorId: "ceo",
    text: "  Speak carefully.  ",
  };
  const first = stageWhisper(store, command);
  const retry = stageWhisper(store, command);
  assert.equal(first.text, "Speak carefully.");
  assert.deepEqual(retry, first);
});
