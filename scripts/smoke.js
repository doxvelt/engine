import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { compileWorld } from "../src/core/compiler.js";
import { initWorld } from "../src/core/init.js";
import { openRuntimeStore } from "../src/store/sqlite.js";

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
} finally {
  store.close();
}

console.log(`smoke ok (${path.relative(process.cwd(), runRoot).replaceAll("\\", "/")})`);
