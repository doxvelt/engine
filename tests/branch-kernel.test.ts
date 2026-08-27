import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BranchConflictError,
  CommandIdentityError,
  DomainNotFoundError,
  DomainValidationError,
} from "../src/core/ports.ts";
import {
  commitManualTurn,
  editAcceptedMessage,
  forkBranch,
  inspectActorContext,
  projectBranch,
  regenerateAcceptedResponse,
  startBranchSimulation,
} from "../src/core/branch-kernel.ts";
import { closeBranchEpisode } from "../src/core/branch-episode.ts";
import {
  exportSimulationPackage,
  importSimulationPackage,
} from "../src/store/portable.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

const workspace = path.resolve("examples/executive-interviews");

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-branch-"));
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const started = await startBranchSimulation(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    commandId: "start-a",
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
  });
  return { store, started };
}

test("compilation is immutable and simulation pins a revision, default branch, and root head", async (t) => {
  const { store, started } = await fixture(t);
  assert.equal(
    started.simulation.contentRevisionId,
    started.contentRevision.id,
  );
  assert.equal(started.simulation.defaultBranchId, "main");
  assert.equal(started.branch.headCommitId, started.root.id);
  assert.equal(started.root.parentCommitId, null);
  const replay = await startBranchSimulation(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    commandId: "start-a",
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
  });
  assert.equal(replay.contentRevision.id, started.contentRevision.id);
  assert.equal(replay.root.id, started.root.id);
});

test("manual commits are atomic, expected-head guarded, and command-idempotent", async (t) => {
  const { store, started } = await fixture(t);
  const command = {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "turn-1",
    payload: {
      actorId: "ceo",
      text: "The plan is changing.",
      audience: ["student-team"],
      audienceChanges: [{ actorId: "ceo", action: "add" as const }],
      accessChanges: [
        { action: "revoke" as const, member: "cfo", container: "ceo" },
      ],
      stageWhisper: "Stay calm.",
    },
  };
  const committed = commitManualTurn(store, command);
  assert.equal(committed.commit.parentCommitId, started.root.id);
  assert.equal(committed.branch.headCommitId, committed.commit.id);
  assert.deepEqual(commitManualTurn(store, command).commit, committed.commit);
  assert.throws(
    () =>
      commitManualTurn(store, {
        ...command,
        payload: { ...command.payload, text: "Different" },
      }),
    CommandIdentityError,
  );
  assert.throws(
    () =>
      commitManualTurn(store, {
        ...command,
        commandId: "stale",
        payload: { ...command.payload, text: "Stale" },
      }),
    BranchConflictError,
  );
  const projection = projectBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
  });
  assert.deepEqual(
    projection.transcript.map((item) => item.text),
    ["The plan is changing."],
  );
  assert.equal(
    projection.accessLinks.some(
      (item) => item.member === "cfo" && item.container === "ceo",
    ),
    false,
  );
  assert.equal(projection.firstImpressions.length, 2);
  assert.equal(projection.commits.length, 2);
  const player = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: committed.commit.id,
    commandId: "player-turn",
    payload: {
      actorId: "student-team",
      text: "What is the board most worried about?",
      audience: ["ceo"],
    },
  });
  assert.equal(
    player.commit.events.filter((item) => item.type === "message_accepted")
      .length,
    1,
  );
  assert.equal(
    projectBranch(store, {
      ownerScope: "owner-a",
      simulationId: "sim-a",
      branchId: "main",
    }).transcript.at(-1)?.actorId,
    "student-team",
  );
});

test("edit and regeneration create isolated sibling histories with message versions", async (t) => {
  const { store, started } = await fixture(t);
  const original = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "original",
    payload: {
      actorId: "ceo",
      text: "Original",
      audience: ["student-team"],
      accessChanges: [{ action: "revoke", member: "cfo", container: "ceo" }],
    },
  });
  const originalMessage = original.commit.events.find(
    (event) => event.type === "message_accepted",
  );
  assert.ok(originalMessage && originalMessage.type === "message_accepted");
  const edited = editAcceptedMessage(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    sourceBranchId: "main",
    expectedHead: original.commit.id,
    commandId: "edit",
    sourceCommitId: original.commit.id,
    branchId: "edit-branch",
    payload: { actorId: "ceo", text: "Edited", audience: ["cfo"] },
  });
  const regenerated = regenerateAcceptedResponse(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    sourceBranchId: "main",
    expectedHead: original.commit.id,
    commandId: "regen",
    sourceCommitId: original.commit.id,
    branchId: "regen-branch",
    payload: { actorId: "ceo", text: "Regenerated", audience: ["coo"] },
  });
  const main = projectBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
  });
  const edit = projectBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "edit-branch",
  });
  const regen = projectBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "regen-branch",
  });
  assert.deepEqual(
    main.transcript.map((item) => item.text),
    ["Original"],
  );
  assert.deepEqual(
    edit.transcript.map((item) => item.text),
    ["Edited"],
  );
  assert.deepEqual(
    regen.transcript.map((item) => item.text),
    ["Regenerated"],
  );
  assert.equal(
    edit.transcript[0]?.logicalMessageId,
    originalMessage.message.logicalMessageId,
  );
  assert.notEqual(
    edit.transcript[0]?.messageVersionId,
    originalMessage.message.id,
  );
  assert.equal(
    main.accessLinks.some(
      (item) => item.member === "cfo" && item.container === "ceo",
    ),
    false,
  );
  assert.equal(
    edit.accessLinks.some(
      (item) => item.member === "cfo" && item.container === "ceo",
    ),
    true,
  );
  assert.equal(edited.commit.parentCommitId, started.root.id);
  assert.equal(regenerated.commit.parentCommitId, started.root.id);
  assert.throws(
    () =>
      editAcceptedMessage(store, {
        ownerScope: "owner-a",
        simulationId: "sim-a",
        sourceBranchId: "main",
        expectedHead: original.commit.id,
        commandId: "bad-edit",
        sourceCommitId: original.commit.id,
        branchId: "leaked-edit",
        payload: { actorId: "missing", text: "Invalid", audience: [] },
      }),
    /retain its original actor/,
  );
  assert.equal(store.getBranch("owner-a", "sim-a", "leaked-edit"), null);
});

test("forks inherit ancestors only and projections resolve independently at selectable heads", async (t) => {
  const { store, started } = await fixture(t);
  const first = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "first",
    payload: {
      actorId: "ceo",
      text: "Shared",
      audience: ["cfo"],
      audienceChanges: [{ actorId: "cfo", action: "add" }],
    },
  });
  const second = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: first.commit.id,
    commandId: "second",
    payload: {
      actorId: "cfo",
      text: "Main only",
      audience: ["ceo"],
      audienceChanges: [{ actorId: "coo", action: "add" }],
    },
  });
  const forkCommand = {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    sourceBranchId: "main",
    expectedHead: second.commit.id,
    atCommitId: first.commit.id,
    branchId: "fork",
    commandId: "fork-command",
  };
  const forkResult = forkBranch(store, forkCommand);
  assert.equal(forkBranch(store, forkCommand).branch.id, forkResult.branch.id);
  assert.throws(
    () =>
      forkBranch(store, {
        ...forkCommand,
        commandId: "stale-fork",
        expectedHead: first.commit.id,
        branchId: "stale-fork",
      }),
    BranchConflictError,
  );
  assert.equal(store.getBranch("owner-a", "sim-a", "stale-fork"), null);
  const forked = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "fork",
    expectedHead: first.commit.id,
    commandId: "fork-turn",
    payload: {
      actorId: "coo",
      text: "Fork only",
      audience: ["ceo"],
      accessChanges: [
        { action: "revoke", member: "cfo", container: "supplier-risk-brief" },
      ],
    },
  });
  assert.deepEqual(
    projectBranch(store, {
      ownerScope: "owner-a",
      simulationId: "sim-a",
      branchId: "main",
    }).transcript.map((item) => item.text),
    ["Shared", "Main only"],
  );
  assert.deepEqual(
    projectBranch(store, {
      ownerScope: "owner-a",
      simulationId: "sim-a",
      branchId: "fork",
    }).transcript.map((item) => item.text),
    ["Shared", "Fork only"],
  );
  assert.deepEqual(
    projectBranch(store, {
      ownerScope: "owner-a",
      simulationId: "sim-a",
      branchId: "main",
      head: first.commit.id,
    }).transcript.map((item) => item.text),
    ["Shared"],
  );
  assert.equal(
    projectBranch(store, {
      ownerScope: "owner-a",
      simulationId: "sim-a",
      branchId: "main",
    }).accessLinks.some(
      (item) =>
        item.member === "cfo" && item.container === "supplier-risk-brief",
    ),
    true,
  );
  assert.equal(
    projectBranch(store, {
      ownerScope: "owner-a",
      simulationId: "sim-a",
      branchId: "fork",
    }).accessLinks.some(
      (item) =>
        item.member === "cfo" && item.container === "supplier-risk-brief",
    ),
    false,
  );
  assert.equal(forked.commit.parentCommitId, first.commit.id);
  assert.equal(second.commit.parentCommitId, first.commit.id);
});

test("projection references use typed errors and never mutate history", async (t) => {
  const { store, started } = await fixture(t);
  const turn = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "projection-reference-turn",
    payload: { actorId: "ceo", text: "Main path", audience: [] },
  });
  forkBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    sourceBranchId: "main",
    expectedHead: turn.commit.id,
    atCommitId: started.root.id,
    branchId: "projection-reference-fork",
    commandId: "projection-reference-fork-command",
  });
  const before = store.exportSimulation("owner-a", "sim-a");
  assert.throws(
    () => projectBranch(store, {
      ownerScope: "owner-a", simulationId: "sim-a", branchId: "missing",
    }),
    DomainNotFoundError,
  );
  assert.throws(
    () => projectBranch(store, {
      ownerScope: "owner-a", simulationId: "sim-a", branchId: "main",
      head: "missing-commit",
    }),
    DomainNotFoundError,
  );
  assert.throws(
    () => projectBranch(store, {
      ownerScope: "owner-a", simulationId: "sim-a",
      branchId: "projection-reference-fork", head: turn.commit.id,
    }),
    DomainValidationError,
  );
  const after = store.exportSimulation("owner-a", "sim-a");
  assert.equal(after.commits.length, before.commits.length);
  assert.equal(after.commandResults.length, before.commandResults.length);
});

test("actor context is subjective, branch-relative, and pure", async (t) => {
  const { store, started } = await fixture(t);
  const first = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "private",
    payload: {
      actorId: "ceo",
      text: "Only the CFO hears this.",
      audience: ["cfo"],
      audienceChanges: [{ actorId: "cfo", action: "add" }],
    },
  });
  forkBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    sourceBranchId: "main",
    expectedHead: first.commit.id,
    atCommitId: started.root.id,
    branchId: "other",
    commandId: "other-fork",
  });
  const before = projectBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
  });
  const cfo = inspectActorContext(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    actorId: "cfo",
  });
  const coo = inspectActorContext(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    actorId: "coo",
  });
  inspectActorContext(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "other",
    actorId: "ceo",
  });
  const after = projectBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
  });
  assert.match(cfo.promptPreview, /Only the CFO hears this/);
  assert.doesNotMatch(coo.promptPreview, /Only the CFO hears this/);
  assert.deepEqual(after, before);
  assert.equal(
    store.getBranch("owner-a", "sim-a", "other")?.headCommitId,
    started.root.id,
  );
  assert.equal(
    first.commit.events.some(
      (event) => event.type === "first_impression_formed",
    ),
    true,
  );
  assert.deepEqual(after.audience, [{ actorId: "cfo", status: "active" }]);
  assert.equal(after.firstImpressions.length, 2);
  const other = projectBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "other",
  });
  assert.equal(other.audience.length, 0);
  assert.equal(other.firstImpressions.length, 0);
  assert.equal(other.beliefs.length < after.beliefs.length, true);
});

test("failed validation and stale commits leak no events or head movement", async (t) => {
  const { store, started } = await fixture(t);
  assert.throws(
    () =>
      commitManualTurn(store, {
        ownerScope: "owner-a",
        simulationId: "sim-a",
        branchId: "main",
        expectedHead: started.root.id,
        commandId: "cycle",
        payload: {
          actorId: "ceo",
          text: "Bad effect",
          audience: [],
          accessChanges: [{ action: "grant", member: "ceo", container: "cfo" }],
        },
      }),
    /cycle/i,
  );
  assert.equal(
    store.getBranch("owner-a", "sim-a", "main")?.headCommitId,
    started.root.id,
  );
  assert.equal(
    projectBranch(store, {
      ownerScope: "owner-a",
      simulationId: "sim-a",
      branchId: "main",
    }).commits.length,
    1,
  );
});

test("episode closure atomically projects subjective memories and beliefs per branch", async (t) => {
  const { store, started } = await fixture(t);
  const publicTurn = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "episode-public",
    payload: {
      actorId: "ceo",
      text: "The board is worried about strategy drift.",
      audience: ["student-team"],
    },
  });
  const privateTurn = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: publicTurn.commit.id,
    commandId: "episode-private",
    payload: {
      actorId: "coo",
      text: "The supplier situation is worse than we are saying.",
      audience: [],
    },
  });
  forkBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    sourceBranchId: "main",
    expectedHead: privateTurn.commit.id,
    atCommitId: publicTurn.commit.id,
    branchId: "pre-closure",
    commandId: "pre-closure-fork",
  });
  const closed = await closeBranchEpisode(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: privateTurn.commit.id,
    commandId: "close-opening",
    payload: { label: "Opening interviews" },
  });
  const main = projectBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
  });
  const fork = projectBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "pre-closure",
  });
  const ceoMemory = closed.closure.memories.find(
    (item) => item.actorId === "ceo",
  );
  const cooMemory = closed.closure.memories.find(
    (item) => item.actorId === "coo",
  );
  assert.ok(ceoMemory && cooMemory);
  assert.match(ceoMemory.text, /board is worried/i);
  assert.doesNotMatch(ceoMemory.text, /supplier situation/i);
  assert.match(cooMemory.text, /supplier situation/i);
  assert.equal(main.episodeClosures.length, 1);
  assert.equal(main.episodeMemories.length, 2);
  assert.equal(main.beliefs.length > fork.beliefs.length, true);
  assert.equal(fork.episodeClosures.length, 0);
  assert.equal(
    inspectActorContext(store, {
      ownerScope: "owner-a",
      simulationId: "sim-a",
      branchId: "main",
      actorId: "ceo",
    }).subjective.longTermMemories.length,
    0,
  );
  await assert.rejects(
    () =>
      closeBranchEpisode(store, {
        ownerScope: "owner-a",
        simulationId: "sim-a",
        branchId: "main",
        expectedHead: closed.commit.id,
        commandId: "empty-close",
        payload: {},
      }),
    /No unclosed turns/,
  );
});

test("closure failure and stale closure leave no partial memory state", async (t) => {
  const { store, started } = await fixture(t);
  const turn = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "before-failure",
    payload: {
      actorId: "ceo",
      text: "Remember this only if closure succeeds.",
      audience: [],
    },
  });
  await assert.rejects(
    () =>
      closeBranchEpisode(
        store,
        {
          ownerScope: "owner-a",
          simulationId: "sim-a",
          branchId: "main",
          expectedHead: turn.commit.id,
          commandId: "failed-close",
          payload: {},
        },
        {
          writeMemory() {
            throw new Error("writer failed");
          },
          extractBeliefs() {
            return [];
          },
        },
      ),
    /writer failed/,
  );
  assert.notEqual(store.getBranch("owner-a", "sim-a", "main")?.headCommitId, turn.commit.id);
  assert.equal(store.listMemoryJobs("owner-a", "sim-a")[0]?.status, "failed");
  assert.equal(
    projectBranch(store, {
      ownerScope: "owner-a",
      simulationId: "sim-a",
      branchId: "main",
    }).episodeClosures.length,
    1,
  );
});

test("logical import/export preserves content, branches, commits, and projections", async (t) => {
  const { store, started } = await fixture(t);
  const portableCommand = {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "portable-turn",
    payload: {
      actorId: "ceo",
      text: "Portable branch state.",
      audience: ["cfo"],
    },
  };
  const turn = commitManualTurn(store, portableCommand);
  forkBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    sourceBranchId: "main",
    expectedHead: turn.commit.id,
    atCommitId: started.root.id,
    branchId: "portable-fork",
    commandId: "portable-fork-command",
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-portable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = path.join(root, "package");
  const targetSource = path.join(root, "source");
  const targetDb = path.join(root, "imported.sqlite");
  const exported = await exportSimulationPackage({
    dbPath: store.dbPath,
    ownerScope: "owner-a",
    simulationId: "sim-a",
    targetDir: packageDir,
  });
  assert.equal(exported.manifest.schemaVersion, 5);
  await importSimulationPackage({
    packageDir,
    targetSourceDir: targetSource,
    targetDbPath: targetDb,
  });
  const imported = await openBranchStore(targetDb).open();
  try {
    assert.equal(
      imported.getBranch("owner-a", "sim-a", "main")?.headCommitId,
      turn.commit.id,
    );
    assert.equal(
      imported.getBranch("owner-a", "sim-a", "portable-fork")?.headCommitId,
      started.root.id,
    );
    assert.deepEqual(
      projectBranch(imported, {
        ownerScope: "owner-a",
        simulationId: "sim-a",
        branchId: "main",
      }).transcript.map((item) => item.text),
      ["Portable branch state."],
    );
    assert.equal(
      imported.getContentRevision("owner-a", started.contentRevision.id)
        ?.compiled.entities.length,
      started.compiled.entities.length,
    );
    assert.equal(
      commitManualTurn(imported, portableCommand).commit.id,
      turn.commit.id,
    );
  } finally {
    imported.close();
  }
});

test("draft stage whispers are private, head-bound, consumed atomically, and absent from other actors", async (t) => {
  const { store, started } = await fixture(t);
  const whisper = store.createStageWhisper({
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "whisper-command",
    targetActorId: "ceo",
    text: "Do not reveal the supplier name.",
  });
  assert.deepEqual(
    store.createStageWhisper({
      ownerScope: "owner-a",
      simulationId: "sim-a",
      branchId: "main",
      expectedHead: started.root.id,
      commandId: "whisper-command",
      targetActorId: "ceo",
      text: "Do not reveal the supplier name.",
    }),
    whisper,
  );
  assert.throws(
    () =>
      store.createStageWhisper({
        ownerScope: "owner-a",
        simulationId: "sim-a",
        branchId: "main",
        expectedHead: started.root.id,
        commandId: "whisper-command",
        targetActorId: "ceo",
        text: "Different direction.",
      }),
    CommandIdentityError,
  );
  assert.equal(
    store.listPendingStageWhispers(
      "owner-a",
      "sim-a",
      "main",
      started.root.id,
      "ceo",
    ).length,
    1,
  );
  assert.equal(
    store.listPendingStageWhispers(
      "owner-a",
      "sim-a",
      "main",
      started.root.id,
      "cfo",
    ).length,
    0,
  );
  const ceoContext = inspectActorContext(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    head: started.root.id,
    actorId: "ceo",
    stageWhispers: [whisper],
  });
  const cfoContext = inspectActorContext(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    head: started.root.id,
    actorId: "cfo",
  });
  assert.match(ceoContext.promptPreview, /supplier name/);
  assert.doesNotMatch(cfoContext.promptPreview, /supplier name/);
  assert.throws(() =>
    commitManualTurn(store, {
      ownerScope: "owner-a",
      simulationId: "sim-a",
      branchId: "main",
      expectedHead: "stale",
      commandId: "stale-whisper-turn",
      payload: { actorId: "ceo", text: "Rejected", audience: [] },
    }),
  );
  assert.equal(
    store.listPendingStageWhispers(
      "owner-a",
      "sim-a",
      "main",
      started.root.id,
      "ceo",
    ).length,
    1,
  );
  const accepted = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "accepted-whisper-turn",
    payload: { actorId: "ceo", text: "Accepted", audience: [] },
  });
  assert.ok(
    accepted.commit.events.some(
      (event) =>
        event.type === "stage_whisper_consumed" &&
        event.whisperId === whisper.id,
    ),
  );
  assert.equal(
    store.listPendingStageWhispers(
      "owner-a",
      "sim-a",
      "main",
      accepted.commit.id,
      "ceo",
    ).length,
    0,
  );
});

test("access loss and retained belief consolidation are branch-relative", async (t) => {
  const { store, started } = await fixture(t);
  const setup = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "retained-setup",
    payload: {
      actorId: "cfo",
      text: "I reviewed the recovery context.",
      audience: [],
    },
  });
  forkBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    sourceBranchId: "main",
    expectedHead: setup.commit.id,
    atCommitId: setup.commit.id,
    branchId: "kept-access",
    commandId: "kept-access-fork",
  });
  const revoked = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: setup.commit.id,
    commandId: "revoke-access",
    payload: {
      actorId: "ceo",
      text: "CFO access is revoked.",
      audience: ["cfo"],
      accessChanges: [{ action: "revoke", member: "cfo", container: "ceo" }],
    },
  });
  const closed = await closeBranchEpisode(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "main",
    expectedHead: revoked.commit.id,
    commandId: "retain-close",
    payload: {},
  });
  assert.ok(
    closed.closure.retainedBeliefs.some(
      (item) =>
        item.holder === "cfo" &&
        item.sourceHolder === "ceo" &&
        item.strength === 1,
    ),
  );
  const retained = closed.closure.retainedBeliefs.find(
    (item) => item.holder === "cfo" && item.sourceHolder === "ceo",
  )!;
  const revokeIndex = revoked.commit.events.findIndex(
    (event) => event.type === "access_changed" && event.action === "revoke",
  );
  assert.equal(
    retained.runtimeAccessEventId,
    `${revoked.commit.id}:event:${revokeIndex}`,
  );
  const kept = projectBranch(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "kept-access",
  });
  assert.equal(
    kept.accessLinks.some(
      (item) => item.member === "cfo" && item.container === "ceo",
    ),
    true,
  );
  assert.equal(
    kept.beliefs.some(
      (item) => "sourceHolder" in item && item.sourceHolder === "ceo",
    ),
    false,
  );
  const siblingRevoked = commitManualTurn(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "kept-access",
    expectedHead: setup.commit.id,
    commandId: "sibling-revoke-access",
    payload: {
      actorId: "ceo",
      text: "CFO access is revoked on the sibling.",
      audience: ["cfo"],
      accessChanges: [{ action: "revoke", member: "cfo", container: "ceo" }],
    },
  });
  const siblingClosed = await closeBranchEpisode(store, {
    ownerScope: "owner-a",
    simulationId: "sim-a",
    branchId: "kept-access",
    expectedHead: siblingRevoked.commit.id,
    commandId: "sibling-retain-close",
    payload: {},
  });
  const siblingRetained = siblingClosed.closure.retainedBeliefs.find(
    (item) => item.holder === "cfo" && item.sourceHolder === "ceo",
  )!;
  assert.match(
    siblingRetained.runtimeAccessEventId,
    new RegExp(`^${siblingRevoked.commit.id}:event:`),
  );
  assert.notEqual(
    siblingRetained.runtimeAccessEventId,
    retained.runtimeAccessEventId,
  );
});
