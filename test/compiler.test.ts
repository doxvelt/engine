import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compileWorld } from "../src/core/compiler.ts";
import { assembleActorContext } from "../src/core/context.ts";
import { initWorld } from "../src/core/init.ts";
import type { AssetRecord, EntityRecord } from "../src/core/types.ts";
import { openRuntimeStore } from "../src/store/sqlite.ts";

test("initWorld creates a compilable demo source", async () => {
  const root = await createRepoLocalRunRoot();
  const worldPath = path.join(root, "world");

  await initWorld(worldPath);
  const compiled = await compileWorld(worldPath);

  assert.equal(compiled.entities.length, 3);
  assert.equal(compiled.scenarios.at(0)?.id, "executive-interviews");
  assert.ok(compiled.models.some((model) => model.id === "local-openai-compatible"));
  assert.ok(compiled.beliefs.length >= 5);
  assert.ok(compiled.beliefs.at(0)?.sourceSpan.file);
});

test("runtime store saves compiled actors and manual turns", async () => {
  const root = await createRepoLocalRunRoot();
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath);
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
    const models = store.listCompiledRecords<AssetRecord>("default", "model");

    assert.deepEqual(
      actors.map((actor) => actor.id),
      ["ceo", "coo", "student-team"]
    );
    assert.ok(models.some((model) => model.id === "local-openai-compatible"));

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

test("actor context includes subjective beliefs and accessible transcript only", async () => {
  const root = await createRepoLocalRunRoot();
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath);
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

async function createRepoLocalRunRoot() {
  const root = path.resolve(".doxvelt", "test-runs");
  await mkdir(root, { recursive: true });
  return await mkdtemp(path.join(root, "run-"));
}
