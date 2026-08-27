import assert from "node:assert/strict";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compileWorkspace } from "../src/core/compiler.ts";
import {
  decodeRecordedCommand,
  decodeRecordedOutcome,
} from "../src/core/recorded-codec.ts";
import {
  startBranchSimulation,
  startBranchSimulationFromCompiled,
} from "../src/core/branch-kernel.ts";
import { readSourceText, writeSourceText } from "../src/core/source.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import {
  exportSimulationPackage,
  importSimulationPackage,
} from "../src/store/portable.ts";

const workspace = path.resolve("examples/executive-interviews");

async function missing(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

test("malformed persisted start outcomes cannot replay or export", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-db-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(dbPath).open();
  const started = await startBranchSimulation(store, {
    ownerScope: "local",
    simulationId: "tampered-replay",
    commandId: "tampered-start",
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
  });
  const validOutcome = store.exportSimulation(
    "local",
    "tampered-replay",
  ).commandResults[0]!.result;
  store.close();
  const forgedIdentity = structuredClone(validOutcome);
  if (forgedIdentity.kind !== "start") throw new Error("Missing start outcome");
  forgedIdentity.simulation.id = "forged-simulation-id";
  const variants = [
    JSON.stringify({ kind: "start", simulation: started.simulation }),
    JSON.stringify(forgedIdentity),
  ];
  for (const resultJson of variants) {
    const database = new DatabaseSync(dbPath);
    database.prepare(
      "UPDATE command_results SET result_json = ? WHERE command_id = ?",
    ).run(resultJson, "tampered-start");
    database.close();
    const reopened = await openBranchStore(dbPath).open();
    await assert.rejects(startBranchSimulation(reopened, {
      ownerScope: "local",
      simulationId: "tampered-replay",
      commandId: "tampered-start",
      workspacePath: workspace,
      scenarioId: "executive-interviews",
      branchId: "main",
    }));
    assert.throws(() => reopened.exportSimulation("local", "tampered-replay"));
    reopened.close();
  }
});

test("recorded decoders reject unknown, missing, and malformed nested data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-codec-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  t.after(() => store.close());
  await startBranchSimulation(store, {
    ownerScope: "local",
    simulationId: "codec-shapes",
    commandId: "codec-start",
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
  });
  const archive = store.exportSimulation("local", "codec-shapes");
  const command = archive.commandResults[0]!;
  const commandVariants: unknown[] = [
    { ...command.canonicalInput, unknown: true },
    { ...command.canonicalInput, kind: "unknown" },
    { ownerScope: "local" },
  ];
  for (const value of commandVariants)
    assert.throws(() => decodeRecordedCommand(value));
  if (command.result.kind !== "start") throw new Error("Missing start outcome");
  const outcomeVariants: unknown[] = [
    { ...command.result, unknown: true },
    { ...command.result, kind: "unknown" },
    { ...command.result, branch: { ...command.result.branch, origin: {} } },
  ];
  for (const value of outcomeVariants)
    assert.throws(() => decodeRecordedOutcome(value));
});

test("SQLite export rejects a persisted command fingerprint mismatch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-db-fingerprint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(dbPath).open();
  await startBranchSimulation(store, {
    ownerScope: "local",
    simulationId: "tampered-fingerprint",
    commandId: "fingerprint-start",
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
  });
  store.close();
  const database = new DatabaseSync(dbPath);
  database.prepare(
    "UPDATE command_results SET fingerprint = ? WHERE command_id = ?",
  ).run("forged", "fingerprint-start");
  database.close();
  const reopened = await openBranchStore(dbPath).open();
  t.after(() => reopened.close());
  assert.throws(
    () => reopened.exportSimulation("local", "tampered-fingerprint"),
    /Command identity/,
  );
});

test("portable runtime archives contain no absolute source root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-portable-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(dbPath).open();
  await startBranchSimulation(store, {
    ownerScope: "local",
    simulationId: "logical-source",
    commandId: "logical-start",
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
  });
  store.close();
  const packageDir = path.join(root, "package");
  await exportSimulationPackage({
    dbPath,
    simulationId: "logical-source",
    targetDir: packageDir,
  });
  const runtimeText = await readFile(
    path.join(packageDir, "simulation.json"),
    "utf8",
  );
  assert.equal(runtimeText.includes(workspace), false);
  const runtime = JSON.parse(runtimeText) as {
    simulation: { sourceRoot: string };
  };
  assert.equal(runtime.simulation.sourceRoot, "source");
});

test("package import rejects source directory symlinks without target writes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-package-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(dbPath).open();
  await startBranchSimulation(store, {
    ownerScope: "local",
    simulationId: "linked-package",
    commandId: "linked-start",
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
  });
  store.close();
  const packageDir = path.join(root, "package");
  await exportSimulationPackage({
    dbPath,
    simulationId: "linked-package",
    targetDir: packageDir,
  });
  const packageAlias = path.join(root, "package-alias");
  await symlink(
    packageDir,
    packageAlias,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(importSimulationPackage({
    packageDir: packageAlias,
    targetSourceDir: path.join(root, "alias-source"),
    targetDbPath: path.join(root, "alias.sqlite"),
  }), /real directory/);
  const external = path.join(root, "external");
  await mkdir(external);
  await rm(path.join(packageDir, "source", "worlds"), {
    recursive: true,
    force: true,
  });
  await symlink(
    external,
    path.join(packageDir, "source", "worlds"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const targetSource = path.join(root, "imported-source");
  const targetDb = path.join(root, "imported.sqlite");
  await assert.rejects(importSimulationPackage({
    packageDir,
    targetSourceDir: targetSource,
    targetDbPath: targetDb,
  }), /symlink/);
  assert.equal(await missing(targetSource), true);
  assert.equal(await missing(targetDb), true);
});

test("workspace writes reject symlink path components", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-workspace-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  const external = path.join(root, "external");
  await mkdir(workspaceRoot);
  await mkdir(external);
  await symlink(
    external,
    path.join(workspaceRoot, "entities"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const escaped = path.join(external, "agent", "profile.md");
  await assert.rejects(
    writeSourceText(workspaceRoot, "entities/agent/profile.md", "escaped"),
    /symbolic links|unsafe/,
  );
  assert.equal(await missing(escaped), true);
});

test("workspace source operations reject hard-linked external files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-workspace-hardlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  const worlds = path.join(workspaceRoot, "worlds");
  await mkdir(worlds, { recursive: true });
  const external = path.join(root, "external.md");
  await writeFile(external, "external");
  await link(external, path.join(worlds, "linked.md"));
  await assert.rejects(
    readSourceText(workspaceRoot, "worlds/linked.md"),
    /private regular file/,
  );
  await assert.rejects(
    writeSourceText(workspaceRoot, "worlds/linked.md", "overwritten"),
    /private regular file/,
  );
  assert.equal(await readFile(external, "utf8"), "external");
});

test("compiled access cycles cause no repository writes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-compiled-cycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = await compileWorkspace(workspace);
  const span = original.accessLinks[0]!.sourceSpan;
  const variants = [
    [{ member: "ceo", container: "ceo", mode: "member" as const, sourceSpan: span }],
    [
      { member: "ceo", container: "cfo", mode: "member" as const, sourceSpan: span },
      { member: "cfo", container: "ceo", mode: "member" as const, sourceSpan: span },
    ],
  ];
  for (const [index, accessLinks] of variants.entries()) {
    const dbPath = path.join(root, `cycle-${index}.sqlite`);
    const store = await openBranchStore(dbPath).open();
    const compiled = structuredClone(original);
    compiled.accessLinks = accessLinks;
    assert.throws(() => startBranchSimulationFromCompiled(store, {
      ownerScope: "local",
      simulationId: `compiled-cycle-${index}`,
      commandId: `cycle-start-${index}`,
      scenarioId: "executive-interviews",
      branchId: "main",
      compiled,
    }), /cycle|itself/);
    assert.equal(store.getSimulation("local", `compiled-cycle-${index}`), null);
    store.close();
    const database = new DatabaseSync(dbPath, { readOnly: true });
    const revisions = database.prepare(
      "SELECT count(*) AS count FROM content_revisions",
    ).get() as { count: number };
    const simulations = database.prepare(
      "SELECT count(*) AS count FROM branch_simulations",
    ).get() as { count: number };
    database.close();
    assert.equal(revisions.count, 0);
    assert.equal(simulations.count, 0);
  }
});
