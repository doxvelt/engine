import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeBranchEpisode } from "../src/core/branch-episode.ts";
import {
  commitManualTurn,
  editAcceptedMessage,
  forkBranch,
  projectBranch,
  regenerateAcceptedResponse,
  startBranchSimulation,
} from "../src/core/branch-kernel.ts";
import {
  CommandIdentityError,
  DomainNotFoundError,
  DomainValidationError,
} from "../src/core/ports.ts";
import { initWorkspace } from "../src/core/init.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import {
  exportSimulationPackage,
  importSimulationPackage,
} from "../src/store/portable.ts";

const exampleWorkspace = path.resolve("examples/executive-interviews");

async function fixture(t: test.TestContext, simulationId = "default") {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-corrections-"));
  const dbPath = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(dbPath).open();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const started = await startBranchSimulation(store, {
    ownerScope: "local",
    simulationId,
    commandId: `${simulationId}-start`,
    workspacePath: exampleWorkspace,
    scenarioId: "executive-interviews",
    branchId: "main",
  });
  return { root, dbPath, store, started };
}

test("edit and regenerate reject a source commit from a sibling branch", async (t) => {
  const { store, started } = await fixture(t, "cross-branch");
  const original = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "cross-branch",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "original",
    payload: { actorId: "ceo", text: "Original", audience: [] },
  });
  const sibling = editAcceptedMessage(store, {
    ownerScope: "local",
    simulationId: "cross-branch",
    sourceBranchId: "main",
    expectedHead: original.commit.id,
    sourceCommitId: original.commit.id,
    branchId: "sibling",
    commandId: "sibling-edit",
    payload: { actorId: "ceo", text: "Sibling", audience: [] },
  });

  const crossBranchInput = {
    ownerScope: "local",
    simulationId: "cross-branch",
    sourceBranchId: "main",
    expectedHead: original.commit.id,
    sourceCommitId: sibling.commit.id,
    payload: { actorId: "ceo", text: "Invalid", audience: [] },
  };
  assert.throws(
    () =>
      editAcceptedMessage(store, {
        ...crossBranchInput,
        branchId: "invalid-edit",
        commandId: "invalid-edit",
      }),
    /not on source branch/,
  );
  assert.throws(
    () =>
      regenerateAcceptedResponse(store, {
        ...crossBranchInput,
        branchId: "invalid-regenerate",
        commandId: "invalid-regenerate",
      }),
    /not on source branch/,
  );
  assert.equal(store.getBranch("local", "cross-branch", "invalid-edit"), null);
  assert.equal(
    store.getBranch("local", "cross-branch", "invalid-regenerate"),
    null,
  );
});

test("fork failures use typed domain errors", async (t) => {
  const { store, started } = await fixture(t, "typed-forks");
  assert.throws(() => forkBranch(store, {
    ownerScope: "local", simulationId: "typed-forks", sourceBranchId: "missing",
    expectedHead: started.root.id, atCommitId: started.root.id,
    branchId: "missing-fork", commandId: "missing-fork",
  }), DomainNotFoundError);
  assert.throws(() => forkBranch(store, {
    ownerScope: "local", simulationId: "typed-forks", sourceBranchId: "main",
    expectedHead: started.root.id, atCommitId: "outside-ancestry",
    branchId: "invalid-fork", commandId: "invalid-fork",
  }), DomainValidationError);
});

test("stage-whisper consumption follows each alternative causal branch", async (t) => {
  const { store, started } = await fixture(t, "whisper-branches");
  const whisper = store.createStageWhisper({
    ownerScope: "local",
    simulationId: "whisper-branches",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "stage-whisper",
    targetActorId: "ceo",
    text: "Private direction",
  });
  const original = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "whisper-branches",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "original-turn",
    payload: { actorId: "ceo", text: "Original", audience: [] },
  });
  const edited = editAcceptedMessage(store, {
    ownerScope: "local",
    simulationId: "whisper-branches",
    sourceBranchId: "main",
    expectedHead: original.commit.id,
    sourceCommitId: original.commit.id,
    branchId: "edited",
    commandId: "edited-turn",
    payload: { actorId: "ceo", text: "Edited", audience: [] },
  });
  const regenerated = regenerateAcceptedResponse(store, {
    ownerScope: "local",
    simulationId: "whisper-branches",
    sourceBranchId: "main",
    expectedHead: original.commit.id,
    sourceCommitId: original.commit.id,
    branchId: "regenerated",
    commandId: "regenerated-turn",
    payload: { actorId: "ceo", text: "Regenerated", audience: [] },
  });

  for (const result of [original, edited, regenerated]) {
    assert.ok(
      result.commit.events.some(
        (event) =>
          event.type === "stage_whisper_consumed" &&
          event.whisperId === whisper.id,
      ),
    );
  }
  assert.equal(
    store.listPendingStageWhispers(
      "local",
      "whisper-branches",
      "main",
      original.commit.id,
      "ceo",
    ).length,
    0,
  );
  const next = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "whisper-branches",
    branchId: "main",
    expectedHead: original.commit.id,
    commandId: "next-turn",
    payload: { actorId: "ceo", text: "Next", audience: [] },
  });
  assert.equal(
    next.commit.events.some((event) => event.type === "stage_whisper_consumed"),
    false,
  );
});

test("logical import preserves a pending whisper and its command identity", async (t) => {
  const { root, dbPath, store, started } = await fixture(t, "pending-export");
  const whisperInput = {
    ownerScope: "local",
    simulationId: "pending-export",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "pending-whisper",
    targetActorId: "ceo",
    text: "Portable private direction",
  };
  const whisper = store.createStageWhisper(whisperInput);
  const advanced = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "pending-export",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "advance-without-consuming",
    payload: { actorId: "cfo", text: "Advance the branch", audience: [] },
  });
  forkBranch(store, {
    ownerScope: "local",
    simulationId: "pending-export",
    sourceBranchId: "main",
    expectedHead: advanced.commit.id,
    atCommitId: started.root.id,
    branchId: "other",
    commandId: "other-branch",
  });

  const packageDir = path.join(root, "package");
  await exportSimulationPackage({
    dbPath,
    simulationId: "pending-export",
    targetDir: packageDir,
  });
  const importedDb = path.join(root, "imported.sqlite");
  await importSimulationPackage({
    packageDir,
    targetSourceDir: path.join(root, "imported-source"),
    targetDbPath: importedDb,
  });
  const imported = await openBranchStore(importedDb).open();
  try {
    assert.deepEqual(
      imported.listPendingStageWhispers(
        "local",
        "pending-export",
        "main",
        started.root.id,
        "ceo",
      ),
      [whisper],
    );
    assert.equal(
      imported.listPendingStageWhispers(
        "local",
        "pending-export",
        "main",
        advanced.commit.id,
        "ceo",
      ).length,
      0,
    );
    assert.equal(
      imported.listPendingStageWhispers(
        "local",
        "pending-export",
        "main",
        started.root.id,
        "cfo",
      ).length,
      0,
    );
    assert.equal(
      imported.listPendingStageWhispers(
        "local",
        "pending-export",
        "other",
        started.root.id,
        "ceo",
      ).length,
      0,
    );
    assert.deepEqual(imported.createStageWhisper(whisperInput), whisper);
    assert.throws(
      () => imported.createStageWhisper({ ...whisperInput, text: "Changed" }),
      CommandIdentityError,
    );
  } finally {
    imported.close();
  }
});

test("episode projection labels closed turns independently across closures and branches", async (t) => {
  const { store, started } = await fixture(t, "episodes");
  const firstTurn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "episodes",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "first-turn",
    payload: { actorId: "ceo", text: "First episode", audience: [] },
  });
  const firstClose = await closeBranchEpisode(store, {
    ownerScope: "local",
    simulationId: "episodes",
    branchId: "main",
    expectedHead: firstTurn.commit.id,
    commandId: "first-close",
    payload: {},
  });
  const secondTurn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "episodes",
    branchId: "main",
    expectedHead: firstClose.commit.id,
    commandId: "second-turn",
    payload: { actorId: "ceo", text: "Second episode", audience: [] },
  });
  forkBranch(store, {
    ownerScope: "local",
    simulationId: "episodes",
    sourceBranchId: "main",
    expectedHead: secondTurn.commit.id,
    atCommitId: secondTurn.commit.id,
    branchId: "open-fork",
    commandId: "open-fork",
  });
  const secondClose = await closeBranchEpisode(store, {
    ownerScope: "local",
    simulationId: "episodes",
    branchId: "main",
    expectedHead: secondTurn.commit.id,
    commandId: "second-close",
    payload: {},
  });

  assert.deepEqual(
    projectBranch(store, {
      ownerScope: "local",
      simulationId: "episodes",
      branchId: "main",
    }).transcript.map((turn) => turn.episodeId),
    [firstClose.closure.episode.id, secondClose.closure.episode.id],
  );
  assert.deepEqual(
    projectBranch(store, {
      ownerScope: "local",
      simulationId: "episodes",
      branchId: "open-fork",
    }).transcript.map((turn) => turn.episodeId),
    [firstClose.closure.episode.id, null],
  );
});

test("memory-writer context contains only the actor-accessible open episode", async (t) => {
  const { store, started } = await fixture(t, "closure-context");
  const oldTurn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "closure-context",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "old-turn",
    payload: { actorId: "ceo", text: "OLD EPISODE UNIQUE TEXT", audience: [] },
  });
  const oldClose = await closeBranchEpisode(store, {
    ownerScope: "local",
    simulationId: "closure-context",
    branchId: "main",
    expectedHead: oldTurn.commit.id,
    commandId: "old-close",
    payload: {},
  });
  const currentTurn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "closure-context",
    branchId: "main",
    expectedHead: oldClose.commit.id,
    commandId: "current-turn",
    payload: {
      actorId: "ceo",
      text: "CURRENT EPISODE UNIQUE TEXT",
      audience: [],
    },
  });

  await closeBranchEpisode(
    store,
    {
      ownerScope: "local",
      simulationId: "closure-context",
      branchId: "main",
      expectedHead: currentTurn.commit.id,
      commandId: "current-close",
      payload: {},
    },
    {
      writeMemory({ context }) {
        assert.doesNotMatch(context.promptPreview, /OLD EPISODE UNIQUE TEXT/);
        assert.match(context.promptPreview, /CURRENT EPISODE UNIQUE TEXT/);
        return "Current memory";
      },
      extractBeliefs() {
        return [];
      },
    },
  );
});

test("persisted and exported compiled revisions contain no raw API keys", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "doxvelt-secret-revision-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await initWorkspace(source);
  await writeFile(
    path.join(source, "models", "secret.yaml"),
    "---\nid: secret\nprovider: gateway\nmodel: hosted\napi_key: sk-secret\napi_key_env: HOSTED_KEY\n---\n",
  );
  const dbPath = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(dbPath).open();
  let revisionId: string;
  try {
    const started = await startBranchSimulation(store, {
      ownerScope: "local",
      simulationId: "secret",
      commandId: "secret-start",
      workspacePath: source,
      branchId: "main",
    });
    revisionId = started.contentRevision.id;
    const stored = store.getContentRevision("local", revisionId);
    assert.ok(stored);
    assert.doesNotMatch(JSON.stringify(stored), /sk-secret/);
    const secretModel = stored.compiled.models.find(
      (model) => model.id === "secret",
    );
    assert.equal(secretModel?.metadata.api_key, undefined);
    assert.equal(secretModel?.metadata.api_key_env, "HOSTED_KEY");
  } finally {
    store.close();
  }

  const packageDir = path.join(root, "package");
  await exportSimulationPackage({
    dbPath,
    simulationId: "secret",
    targetDir: packageDir,
  });
  const simulationJson = await readFile(
    path.join(packageDir, "simulation.json"),
    "utf8",
  );
  assert.doesNotMatch(simulationJson, /sk-secret/);
  assert.doesNotMatch(simulationJson, /"api_key"/);
  assert.match(simulationJson, /"api_key_env": "HOSTED_KEY"/);
});

test("content identity deduplicates while simulations retain their own source roots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-source-roots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstSource = path.join(root, "first");
  const secondSource = path.join(root, "second");
  await cp(exampleWorkspace, firstSource, { recursive: true });
  await cp(exampleWorkspace, secondSource, { recursive: true });
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  try {
    const first = await startBranchSimulation(store, {
      ownerScope: "local",
      simulationId: "first",
      commandId: "first-start",
      workspacePath: firstSource,
      branchId: "main",
    });
    const second = await startBranchSimulation(store, {
      ownerScope: "local",
      simulationId: "second",
      commandId: "second-start",
      workspacePath: secondSource,
      branchId: "main",
    });
    assert.equal(first.contentRevision.id, second.contentRevision.id);
    assert.equal(first.simulation.sourceRoot, firstSource);
    assert.equal(second.simulation.sourceRoot, secondSource);
    assert.equal("sourceRoot" in second.contentRevision, false);
    assert.equal(second.contentRevision.compiled.sourceRoot, "");
  } finally {
    store.close();
  }
});

test("rejected reused start commands leave no partial content revision", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-start-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await initWorkspace(source);
  const dbPath = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(dbPath).open();
  try {
    await startBranchSimulation(store, {
      ownerScope: "local",
      simulationId: "atomic",
      commandId: "same-start",
      workspacePath: source,
      branchId: "main",
    });
    const scenarioPath = path.join(source, "scenarios", "scenario.md");
    await writeFile(
      scenarioPath,
      `${await readFile(scenarioPath, "utf8")}\nChanged content. :canonical\n`,
    );
    await assert.rejects(
      startBranchSimulation(store, {
        ownerScope: "local",
        simulationId: "atomic",
        commandId: "same-start",
        workspacePath: source,
        branchId: "main",
      }),
      CommandIdentityError,
    );
  } finally {
    store.close();
  }
  const database = new DatabaseSync(dbPath);
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM content_revisions")
      .get() as {
      count: number;
    };
    assert.equal(row.count, 1);
  } finally {
    database.close();
  }
});
