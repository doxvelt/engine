import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compileWorld } from "../src/core/compiler.ts";
import { assembleActorContext } from "../src/core/context.ts";
import { closeEpisode } from "../src/core/episode.ts";
import { initWorld } from "../src/core/init.ts";
import { loadModelRecord } from "../src/core/models.ts";
import type { AssetRecord, EntityRecord } from "../src/core/types.ts";
import { openRuntimeStore } from "../src/store/sqlite.ts";

test("initWorld creates a sparse compilable scaffold", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");

  await initWorld(worldPath);
  const compiled = await compileWorld(worldPath);

  assert.equal(compiled.entities.length, 1);
  assert.equal(compiled.scenarios.at(0)?.id, "scenario");
  assert.ok(compiled.models.some((model) => model.id === "local-openai-compatible"));
  assert.ok(compiled.beliefs.length >= 1);
  assert.ok(compiled.beliefs.at(0)?.sourceSpan.file);
});

test("initWorld can seed the executive interviews example", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);

  assert.equal(compiled.entities.length, 3);
  assert.equal(compiled.scenarios.at(0)?.id, "executive-interviews");
  assert.ok(compiled.models.some((model) => model.id === "local-openai-compatible"));
  assert.ok(compiled.beliefs.length >= 5);
  assert.ok(compiled.beliefs.at(0)?.sourceSpan.file);
});

test("initWorld template lookup works outside the repository root", async (context) => {
  const previousCwd = process.cwd();
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");

  try {
    process.chdir(root);
    await initWorld(worldPath, { template: "executive-interviews" });
  } finally {
    process.chdir(previousCwd);
  }

  const compiled = await compileWorld(worldPath);
  assert.equal(compiled.entities.length, 3);
});

test("initWorld rejects unknown templates", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");

  await assert.rejects(
    () => initWorld(worldPath, { template: "missing-template" }),
    /Unknown Doxvelt init template/
  );
});

test("compiled example source is inspectable without running init", async () => {
  const compiled = await compileWorld("examples/executive-interviews");

  assert.equal(compiled.entities.length, 3);
  assert.equal(compiled.scenarios.at(0)?.id, "executive-interviews");
});

test("runtime store saves compiled actors and manual turns", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });

    const actors = store.listActors("default");
    assert.deepEqual(
      actors.map((actor) => actor.id),
      ["ceo", "coo", "student-team"]
    );
    assert.deepEqual(store.listCompiledRecords<AssetRecord>("default", "model"), []);

    const model = await loadModelRecord(compiled.sourceRoot, "local-openai-compatible");
    assert.equal(model?.metadata.provider, "openai-compatible");

    const turn = store.appendTurn({
      simulationId: "default",
      actorId: "ceo",
      text: "The market is changing faster than our organization.",
      audience: ["ceo", "student-team"]
    });

    assert.equal(turn.actorId, "ceo");
    assert.equal(turn.audience.length, 2);
  } finally {
    store.close();
  }
});

test("actor context includes subjective beliefs and accessible transcript only", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });

    store.appendTurn({
      simulationId: "default",
      actorId: "ceo",
      text: "The board is worried about strategy drift.",
      audience: ["ceo", "student-team"]
    });

    store.appendTurn({
      simulationId: "default",
      actorId: "coo",
      text: "The supplier situation is worse than we are saying.",
      audience: ["coo"]
    });

    const simulation = store.getSimulation("default");
    assert.ok(simulation);

    const actor = store.getCompiledRecord<EntityRecord>("default", "entity", "ceo");
    assert.ok(actor);

    const context = assembleActorContext({
      simulation,
      actor,
      worlds: store.listCompiledRecords("default", "world"),
      scenario: store.getCompiledRecord("default", "scenario", "executive-interviews"),
      formats: store.listCompiledRecords("default", "format"),
      beliefs: store.listBeliefs("default"),
      turns: store.listAccessibleTurns("default", "ceo")
    });

    assert.equal(context.actor.id, "ceo");
    assert.ok(context.subjective.beliefs.every((belief) => belief.holder === "ceo"));
    assert.equal(context.subjective.transcript.length, 1);
    assert.match(context.promptPreview, /The board is worried/);
    assert.doesNotMatch(context.promptPreview, /supplier situation is worse/);
  } finally {
    store.close();
  }
});

test("episode closure writes deterministic memories from accessible turns", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });

    store.appendTurn({
      simulationId: "default",
      actorId: "ceo",
      text: "The board is worried about strategy drift.",
      audience: ["ceo", "student-team"]
    });

    store.appendTurn({
      simulationId: "default",
      actorId: "coo",
      text: "The supplier situation is worse than we are saying.",
      audience: ["coo"]
    });

    const closure = await closeEpisode({ store, simulationId: "default", label: "Opening interviews" });
    const ceoMemory = closure.memories.find((memory) => memory.actorId === "ceo");
    const cooMemory = closure.memories.find((memory) => memory.actorId === "coo");

    assert.equal(closure.episode.label, "Opening interviews");
    assert.ok(ceoMemory);
    assert.ok(cooMemory);
    assert.match(ceoMemory.text, /board is worried/);
    assert.doesNotMatch(ceoMemory.text, /supplier situation is worse/);
    assert.match(cooMemory.text, /supplier situation is worse/);
    assert.equal(store.listEpisodeMemories("default").length, 2);
    assert.equal(closure.extractedBeliefs.length, 2);
    assert.equal(store.listExtractedBeliefs("default").length, 2);
    assert.ok(
      closure.extractedBeliefs.some((belief) => {
        return belief.holder === "ceo" && belief.propositionText.includes("accessible turn");
      })
    );
  } finally {
    store.close();
  }
});

test("episode closure can use injected AI-style generation", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });

    store.appendTurn({
      simulationId: "default",
      actorId: "ceo",
      text: "The board is worried about strategy drift.",
      audience: ["ceo", "student-team"]
    });

    const closure = await closeEpisode({
      store,
      simulationId: "default",
      label: "Opening interviews",
      generator: {
        writeMemory({ actor, context }) {
          assert.equal(context.actor.id, actor.id);
          assert.match(context.promptPreview, /The board is worried/);
          return `I am ${actor.id}, and I now think the board pressure matters.`;
        },
        extractBeliefs({ actor, memory }) {
          return [
            {
              strength: 3,
              propositionText: `@${actor.id} treats board pressure as important after memory ${memory.id}.`
            },
            {
              strength: 99,
              propositionText: `@${actor.id} has an overconfident normalized belief.`
            }
          ];
        }
      }
    });

    assert.equal(closure.memories.length, 1);
    assert.equal(closure.extractedBeliefs.length, 2);
    assert.ok(closure.memories.every((memory) => memory.text.includes("board pressure matters")));
    assert.ok(closure.extractedBeliefs.every((belief) => belief.strength === 3));
    assert.equal(store.listBeliefHistory("default").length, compiled.beliefs.length + 2);
  } finally {
    store.close();
  }
});

async function createRepoLocalRunRoot(context: test.TestContext) {
  const root = path.resolve(".doxvelt", "test-runs");
  await mkdir(root, { recursive: true });
  const runRoot = await mkdtemp(path.join(root, "run-"));
  context.after(async () => {
    await rm(runRoot, { recursive: true, force: true });
  });
  return runRoot;
}
