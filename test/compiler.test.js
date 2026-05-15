import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compileWorld } from "../src/core/compiler.js";
import { initWorld } from "../src/core/init.js";
import { openRuntimeStore } from "../src/store/sqlite.js";

test("initWorld creates a compilable demo source", async () => {
  const root = await createRepoLocalRunRoot();
  const worldPath = path.join(root, "world");

  await initWorld(worldPath);
  const compiled = await compileWorld(worldPath);

  assert.equal(compiled.entities.length, 3);
  assert.equal(compiled.scenarios[0].id, "executive-interviews");
  assert.ok(compiled.beliefs.length >= 5);
  assert.ok(compiled.beliefs[0].sourceSpan.file);
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
    assert.deepEqual(
      actors.map((actor) => actor.id),
      ["ceo", "coo", "student-team"]
    );

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

async function createRepoLocalRunRoot() {
  const root = path.resolve(".doxvelt", "test-runs");
  await mkdir(root, { recursive: true });
  return await mkdtemp(path.join(root, "run-"));
}
