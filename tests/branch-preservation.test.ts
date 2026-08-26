import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeBranchEpisode } from "../src/core/branch-episode.ts";
import {
  commitManualTurn,
  inspectActorContext,
  projectBranch,
  startBranchSimulation,
} from "../src/core/branch-kernel.ts";
import { exportSimulationPackage } from "../src/store/portable.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { initWorkspace } from "../src/core/init.ts";
import { compileWorkspace } from "../src/core/compiler.ts";

const workspace = path.resolve("examples/executive-interviews");
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-preserve-"));
  const db = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(db).open();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const started = await startBranchSimulation(store, {
    ownerScope: "local",
    simulationId: "default",
    commandId: "start",
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
  });
  return { root, db, store, started };
}

test("hidden authored scenario lines remain isolated by actor", async (t) => {
  const { store } = await fixture(t);
  const ceo = inspectActorContext(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    actorId: "ceo",
  });
  const coo = inspectActorContext(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    actorId: "coo",
  });
  assert.match(
    ceo.assets.scenario?.body || "",
    /board is worried about strategy drift/,
  );
  assert.doesNotMatch(
    coo.assets.scenario?.body || "",
    /board is worried about strategy drift/,
  );
  assert.match(coo.assets.scenario?.body || "", /supplier reliability problem/);
  assert.doesNotMatch(
    ceo.assets.scenario?.body || "",
    /supplier reliability problem/,
  );
  assert.doesNotMatch(ceo.assets.scenario?.body || "", /may replace @ceo/);
});

test("transitive membership exposes beliefs with complete provenance paths", async (t) => {
  const { store, started } = await fixture(t);
  const granted = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "nested-grant",
    payload: {
      actorId: "ceo",
      text: "Grant nested access.",
      audience: [],
      accessChanges: [
        { action: "grant", member: "student-team", container: "cfo" },
      ],
    },
  });
  const context = inspectActorContext(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    head: granted.commit.id,
    actorId: "student-team",
  });
  assert.ok(
    context.subjective.beliefAccess.some(
      (item) =>
        item.provenance.sourceHolder === "ceo" &&
        item.provenance.accessPath.join("/") === "student-team/cfo/ceo",
    ),
  );
});

test("successive episode closures process only turns after the prior closure", async (t) => {
  const { store, started } = await fixture(t);
  const firstTurn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "first-turn",
    payload: { actorId: "ceo", text: "First episode concern.", audience: [] },
  });
  const first = await closeBranchEpisode(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: firstTurn.commit.id,
    commandId: "first-close",
    payload: { label: "First" },
  });
  const secondTurn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: first.commit.id,
    commandId: "second-turn",
    payload: { actorId: "ceo", text: "Second episode concern.", audience: [] },
  });
  const second = await closeBranchEpisode(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: secondTurn.commit.id,
    commandId: "second-close",
    payload: { label: "Second" },
  });
  assert.match(second.closure.memories[0]?.text || "", /Second episode/);
  assert.doesNotMatch(second.closure.memories[0]?.text || "", /First episode/);
  assert.equal(second.closure.memories[0]?.sourceTurnIds.length, 1);
});

test("injected closure generation writes long-term memory and normalized beliefs", async (t) => {
  const { store, started } = await fixture(t);
  const turn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "custom-turn",
    payload: { actorId: "ceo", text: "Board pressure matters.", audience: [] },
  });
  const closed = await closeBranchEpisode(
    store,
    {
      ownerScope: "local",
      simulationId: "default",
      branchId: "main",
      expectedHead: turn.commit.id,
      commandId: "custom-close",
      payload: {},
    },
    {
      writeMemory({ context }) {
        assert.match(context.promptPreview, /Board pressure matters/);
        return "I now think board pressure matters.";
      },
      writeLongTermMemory() {
        return "I should remember board pressure.";
      },
      extractBeliefs({ actor }) {
        return [
          {
            strength: 99,
            propositionText: `@${actor.id} treats board pressure as important.`,
          },
        ];
      },
    },
  );
  assert.equal(closed.closure.longTermMemories.length, 1);
  assert.equal(closed.closure.extractedBeliefs[0]?.strength, 3);
  assert.match(
    inspectActorContext(store, {
      ownerScope: "local",
      simulationId: "default",
      branchId: "main",
      actorId: "ceo",
    }).promptPreview,
    /I should remember board pressure/,
  );
});

test("retried closure commands replay without invoking the memory writer again", async (t) => {
  const { store, started } = await fixture(t);
  const turn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "retry-turn",
    payload: { actorId: "ceo", text: "One closure only.", audience: [] },
  });
  let calls = 0;
  const command = {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: turn.commit.id,
    commandId: "retry-close",
    payload: { label: "Retry" },
  };
  const generator = {
    writeMemory() {
      calls += 1;
      return "One memory.";
    },
    extractBeliefs() {
      return [];
    },
  };
  const first = await closeBranchEpisode(store, command, generator);
  const second = await closeBranchEpisode(store, command, generator);
  assert.equal(calls, 1);
  assert.equal(second.commit.id, first.commit.id);
  assert.equal(
    projectBranch(store, {
      ownerScope: "local",
      simulationId: "default",
      branchId: "main",
    }).episodeClosures.length,
    1,
  );
});

test("logical export sanitizes source credentials and excludes key files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-secrets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await initWorkspace(source);
  await writeFile(
    path.join(source, "models", "secret.yaml"),
    "---\nid: secret\nprovider: gateway\nmodel: hosted\napi_key: sk-secret\napi_key_env: HOSTED_KEY\n---\n",
  );
  await writeFile(path.join(source, ".env"), "HOSTED_KEY=secret\n");
  await writeFile(path.join(source, "private.pem"), "secret\n");
  const db = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(db).open();
  try {
    await startBranchSimulation(store, {
      ownerScope: "local",
      simulationId: "default",
      commandId: "secret-start",
      workspacePath: source,
      branchId: "main",
    });
  } finally {
    store.close();
  }
  const target = path.join(root, "package");
  await exportSimulationPackage({ dbPath: db, targetDir: target });
  const text = await readFile(
    path.join(target, "source", "models", "secret.yaml"),
    "utf8",
  );
  assert.doesNotMatch(text, /sk-secret/);
  assert.match(text, /api_key: \[redacted\]/);
  await assert.rejects(
    readFile(path.join(target, "source", ".env"), "utf8"),
    /ENOENT/,
  );
  await assert.rejects(
    readFile(path.join(target, "source", "private.pem"), "utf8"),
    /ENOENT/,
  );
});

test("context projection never creates a first impression until an accepted observing turn", async (t) => {
  const { store, started } = await fixture(t);
  const before = store.exportSimulation("local", "default").commits.length;
  inspectActorContext(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    actorId: "ceo",
  });
  inspectActorContext(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    actorId: "ceo",
  });
  assert.equal(
    store.exportSimulation("local", "default").commits.length,
    before,
  );
  const turn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "observe",
    payload: { actorId: "ceo", text: "I see the CFO.", audience: ["cfo"] },
  });
  const second = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: turn.commit.id,
    commandId: "observe-again",
    payload: {
      actorId: "ceo",
      text: "We still see each other.",
      audience: ["cfo"],
    },
  });
  assert.equal(
    projectBranch(store, {
      ownerScope: "local",
      simulationId: "default",
      branchId: "main",
    }).firstImpressions.length,
    2,
  );
  assert.equal(
    second.commit.events.some(
      (item) => item.type === "first_impression_formed",
    ),
    false,
  );
  assert.ok(
    turn.commit.events.some((item) => item.type === "first_impression_formed"),
  );
});

test("source edits create a new immutable revision without rewriting a running simulation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-revision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await initWorkspace(source);
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  try {
    const started = await startBranchSimulation(store, {
      ownerScope: "local",
      simulationId: "pinned",
      commandId: "pin-start",
      workspacePath: source,
      branchId: "main",
    });
    const scenarioPath = path.join(source, "scenarios", "scenario.md");
    await writeFile(
      scenarioPath,
      `${await readFile(scenarioPath, "utf8")}\nThe edited source is only for future revisions. :canonical\n`,
    );
    const edited = store.createContentRevision({
      ownerScope: "local",
      compiled: await compileWorkspace(source),
    });
    assert.notEqual(edited.id, started.contentRevision.id);
    assert.equal(
      store.getSimulation("local", "pinned")?.contentRevisionId,
      started.contentRevision.id,
    );
    assert.doesNotMatch(
      store.getContentRevision("local", started.contentRevision.id)?.compiled
        .scenarios[0]?.body || "",
      /only for future revisions/,
    );
  } finally {
    store.close();
  }
});

test("closure retains provenance from runtime-granted access after branch-local revocation", async (t) => {
  const { store, started } = await fixture(t);
  const granted = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "runtime-grant",
    payload: {
      actorId: "coo",
      text: "I can review CEO context now.",
      audience: [],
      accessChanges: [{ action: "grant", member: "coo", container: "ceo" }],
    },
  });
  const revoked = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: granted.commit.id,
    commandId: "runtime-revoke",
    payload: {
      actorId: "coo",
      text: "That access is gone.",
      audience: [],
      accessChanges: [{ action: "revoke", member: "coo", container: "ceo" }],
    },
  });
  const noopRevoke = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: revoked.commit.id,
    commandId: "runtime-noop-revoke",
    payload: {
      actorId: "coo",
      text: "That access is still gone.",
      audience: [],
      accessChanges: [{ action: "revoke", member: "coo", container: "ceo" }],
    },
  });
  const closed = await closeBranchEpisode(store, {
    ownerScope: "local",
    simulationId: "default",
    branchId: "main",
    expectedHead: noopRevoke.commit.id,
    commandId: "runtime-retain",
    payload: {},
  });
  const retained = closed.closure.retainedBeliefs.find(
    (item) =>
      item.holder === "coo" &&
      item.sourceHolder === "ceo" &&
      item.accessPath.join("/") === "coo/ceo",
  );
  assert.ok(retained);
  assert.equal(retained.runtimeAccessEventId, `${revoked.commit.id}:event:1`);
});
