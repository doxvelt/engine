import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { compileWorld } from "../src/core/compiler.ts";
import { assembleActorContext } from "../src/core/context.ts";
import { initWorld } from "../src/core/init.ts";
import type { EntityRecord } from "../src/core/types.ts";
import { openRuntimeStore } from "../src/store/sqlite.ts";

const root = path.resolve(".doxvelt", "smoke-runs");
await mkdir(root, { recursive: true });

const runRoot = await mkdtemp(path.join(root, "run-"));
const worldPath = path.join(runRoot, "world");
const dbPath = path.join(runRoot, "runtime.sqlite");

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
  if (actors.length !== 3) {
    throw new Error(`Expected 3 actors, found ${actors.length}.`);
  }

  store.appendTurn({
    simulationId: "default",
    actorId: "ceo",
    text: "We need to understand what is really going on.",
    audience: ["ceo", "student-team"]
  });

  const simulation = store.getSimulation("default");
  if (!simulation) throw new Error("Expected simulation to exist.");

  const actor = store.getCompiledRecord<EntityRecord>("default", "entity", "ceo");
  if (!actor) throw new Error("Expected actor to exist.");

  const context = assembleActorContext({
    simulation,
    actor,
    worlds: store.listCompiledRecords("default", "world"),
    scenario: store.getCompiledRecord("default", "scenario", "executive-interviews"),
    formats: store.listCompiledRecords("default", "format"),
    beliefs: store.listBeliefs("default"),
    turns: store.listAccessibleTurns("default", "ceo")
  });

  if (!context.promptPreview.includes("We need to understand what is really going on.")) {
    throw new Error("Expected context preview to include the accessible manual turn.");
  }
} finally {
  store.close();
}

console.log(`smoke ok (${path.relative(process.cwd(), runRoot).replaceAll("\\", "/")})`);
