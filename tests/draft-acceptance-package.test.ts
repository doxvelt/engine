import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acceptActorTurnDraft, generateActorTurnDraft } from "../src/core/draft-lifecycle.ts";
import { commitManualTurn, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { fingerprintCommand } from "../src/core/domain-rules.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import {
  exportSimulationPackage,
  importSimulationPackage,
  publishImportTargets,
} from "../src/store/portable.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";

const workspace = path.resolve("examples/executive-interviews");

async function absent(target: string, label: string) {
  const result = await lstat(target).then(() => null, (error) => error as NodeJS.ErrnoException);
  assert.equal(result?.code, "ENOENT", `import target must not exist: ${label}`);
}

async function packageFixture(t: test.TestContext, generated: boolean, finalText?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-accept-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "runtime.sqlite");
  const simulationId = generated ? "generated" : "manual";
  const store = await openBranchStore(dbPath).open();
  try {
    const started = await startBranchSimulation(store, {
      ownerScope: "local", simulationId, commandId: "start", workspacePath: workspace,
      scenarioId: "executive-interviews", branchId: "main",
    });
    if (!generated) commitManualTurn(store, {
      ownerScope: "local", simulationId, branchId: "main", expectedHead: started.root.id,
      commandId: "turn", payload: { actorId: "ceo", text: "Portable manual turn.", audience: ["cfo"] },
    });
    else {
      const draft = await generateActorTurnDraft(store, new DeterministicFakeRuntime([
        { type: "completed", text: "Portable generated artifact.", usage: { inputTokens: 2, outputTokens: 3 } },
      ]), {
        ownerScope: "local", simulationId, branchId: "main", expectedHead: started.root.id,
        commandId: "generate", payload: {
          actorId: "ceo", audience: ["cfo"], stageWhisperIds: [],
          runtimeProfile: { id: "character", version: "v1" }, promptPolicy: { id: "default", version: "v1" },
          outputSchema: { id: "screenplay", digest: "schema-v1" }, skillDigests: [],
        },
      });
      acceptActorTurnDraft(store, {
        ownerScope: "local", simulationId, draftId: draft.draft.id, commandId: "accept",
        ...(finalText === undefined ? {} : { finalText }),
      });
    }
  } finally { store.close(); }
  const packageDir = path.join(root, "package");
  await exportSimulationPackage({ dbPath, simulationId, targetDir: packageDir });
  return { root, packageDir, simulationId };
}

test("v6 generated edited and verbatim packages replay without draft rows or raw context", async (t) => {
  for (const finalText of [undefined, "Edited portable artifact."]) {
    const { root, packageDir, simulationId } = await packageFixture(t, true, finalText);
    const json = await readFile(path.join(packageDir, "simulation.json"), "utf8");
    const acceptance = JSON.parse(json).commandResults.find((item: any) => item.commandId === "accept");
    assert.equal(Object.hasOwn(acceptance.canonicalInput.payload, "prompt"), false);
    assert.equal(Object.hasOwn(acceptance.canonicalInput.payload, "context"), false);
    assert.equal(json.includes("sk_live_seeded_secret"), false);
    assert.equal(json.includes("Portable generated artifact."), true);
    const db = path.join(root, `import-${finalText ? "edited" : "verbatim"}.sqlite`);
    await importSimulationPackage({ packageDir, targetSourceDir: `${db}-source`, targetDbPath: db });
    const store = await openBranchStore(db).open();
    try {
      const archive = store.exportSimulation("local", simulationId);
      validateSimulationArchive(archive);
      const receipt = archive.commandResults.find((item) => item.commandId === "accept");
      assert.ok(receipt?.canonicalInput.kind === "accept_draft", "acceptance receipt must exist");
      if (receipt?.canonicalInput.kind !== "accept_draft") continue;
      assert.equal(store.getActorTurnDraft("local", simulationId, receipt.canonicalInput.payload.draftId), null);
      assert.equal(acceptActorTurnDraft(store, {
        ownerScope: "local", simulationId, draftId: receipt.canonicalInput.payload.draftId,
        commandId: "accept", ...(finalText === undefined ? {} : { finalText }),
      }).replayed, true);
    } finally { store.close(); }
  }
});

test("manual current and v4/v5 packages import then re-export v6", async (t) => {
  const { root, packageDir, simulationId } = await packageFixture(t, false);
  const runtimePath = path.join(packageDir, "simulation.json");
  const manifestPath = path.join(packageDir, "manifest.json");
  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const version of [6, 4, 5]) {
    const r = structuredClone(runtime); const m = structuredClone(manifest);
    r.schemaVersion = version; m.schemaVersion = version;
    await writeFile(runtimePath, `${JSON.stringify(r)}\n`); await writeFile(manifestPath, `${JSON.stringify(m)}\n`);
    const db = path.join(root, `v${version}.sqlite`); const output = path.join(root, `v${version}-out`);
    await importSimulationPackage({ packageDir, targetSourceDir: `${db}-source`, targetDbPath: db });
    await exportSimulationPackage({ dbPath: db, simulationId, targetDir: output });
    const exported = JSON.parse(await readFile(path.join(output, "simulation.json"), "utf8"));
    assert.equal(exported.schemaVersion, 6);
    assert.equal(exported.commandResults.some((item: any) => item.canonicalInput.kind === "accept_draft"), false);
  }
});

test("package preflight rejects schema, identity, layout, and malformed runtime before targets", async (t) => {
  const { root, packageDir } = await packageFixture(t, false);
  const runtimePath = path.join(packageDir, "simulation.json"); const manifestPath = path.join(packageDir, "manifest.json");
  const runtime = JSON.parse(await readFile(runtimePath, "utf8")); const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const cases: Array<[string, (m: any, r: any) => void, RegExp, string?]> = [
    ["schema", (m) => { m.schemaVersion = 5; }, /schema or identity/],
    ["owner", (m) => { m.ownerScope = "other"; }, /schema or identity/, "local"],
    ["expected-owner", () => {}, /trusted local scope/, "other"],
    ["simulation", (m) => { m.simulationId = "other"; }, /schema or identity/],
    ["scenario", (m) => { m.scenarioId = "other"; }, /schema or identity/],
    ["layout", (m) => { m.files = { source: "wrong", runtime: "simulation.json" }; }, /schema or file layout/],
    ["missing-layout", (m) => { delete m.files; }, /schema or file layout/],
    ["extra", (m) => { m.extra = true; }, /schema or file layout/],
    ["runtime", (_m, r) => { r.commandResults[0].result = { forged: true }; }, /command result is invalid/],
  ];
  for (const [label, mutate, expected, expectedOwnerScope] of cases) {
    const m = structuredClone(manifest); const r = structuredClone(runtime); mutate(m, r);
    await writeFile(manifestPath, `${JSON.stringify(m)}\n`); await writeFile(runtimePath, `${JSON.stringify(r)}\n`);
    const db = path.join(root, `import-${label}.sqlite`); const source = `${db}-source`;
    await assert.rejects(importSimulationPackage({ packageDir, targetSourceDir: source, targetDbPath: db,
      ...(expectedOwnerScope === undefined ? {} : { expectedOwnerScope }) }), expected);
    await absent(source, `${label} source`); await absent(db, `${label} database`);
  }
});

test("malformed acceptance receipt package rejects before import targets", async (t) => {
  const { root, packageDir } = await packageFixture(t, true, "Edited portable artifact.");
  const runtimePath = path.join(packageDir, "simulation.json");
  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  const command = runtime.commandResults.find(
    (item: any) => item.canonicalInput.kind === "accept_draft",
  );
  assert.ok(command, "acceptance receipt must exist");
  command.canonicalInput.payload.generatedArtifact.digest = "0".repeat(64);
  command.fingerprint = fingerprintCommand(command.canonicalInput);
  await writeFile(runtimePath, `${JSON.stringify(runtime)}\n`);
  const db = path.join(root, "malformed-acceptance.sqlite");
  const source = `${db}-source`;
  await assert.rejects(
    importSimulationPackage({
      packageDir,
      targetSourceDir: source,
      targetDbPath: db,
    }),
    /input structure mismatch|accepted draft receipt is invalid/,
  );
  await absent(source, "malformed acceptance source");
  await absent(db, "malformed acceptance database");
});

test("overlapping source and database targets reject before filesystem writes", async (t) => {
  const { root, packageDir } = await packageFixture(t, false);
  const cases = [
    {
      source: path.join(root, "overlap-source"),
      db: path.join(root, "overlap-source", "runtime.sqlite"),
    },
    {
      db: path.join(root, "overlap-database.sqlite"),
      source: path.join(root, "overlap-database.sqlite", "source"),
    },
  ];
  for (const [index, targets] of cases.entries()) {
    await assert.rejects(
      importSimulationPackage({
        packageDir,
        targetSourceDir: targets.source,
        targetDbPath: targets.db,
      }),
      /must not overlap/,
    );
    await absent(targets.source, `overlap ${index} source`);
    await absent(targets.db, `overlap ${index} database`);
  }
});

test("symlinked parent aliases cannot bypass overlap preflight", async (t) => {
  const { root, packageDir } = await packageFixture(t, false);
  const realParent = path.join(root, "real-target-parent");
  const aliasParent = path.join(root, "target-parent-alias");
  await mkdir(realParent, { recursive: true });
  await symlink(
    realParent,
    aliasParent,
    process.platform === "win32" ? "junction" : "dir",
  );
  const cases = [
    {
      source: path.join(realParent, "source-target"),
      db: path.join(aliasParent, "source-target", "runtime.sqlite"),
    },
    {
      db: path.join(realParent, "database-target"),
      source: path.join(aliasParent, "database-target", "source"),
    },
  ];
  for (const [index, targets] of cases.entries()) {
    await assert.rejects(
      importSimulationPackage({
        packageDir,
        targetSourceDir: targets.source,
        targetDbPath: targets.db,
      }),
      /symbolic links/,
    );
    await absent(targets.source, `symlink overlap ${index} source`);
    await absent(targets.db, `symlink overlap ${index} database`);
  }
});

test("exclusive publication preserves external targets and cleans owned claims", async (t) => {
  const { root, packageDir } = await packageFixture(t, false);
  const stagedSource = path.join(packageDir, "source");
  const stagedDb = path.join(root, "runtime.sqlite");
  const source = path.join(root, "claimed-source");
  const db = path.join(root, "claimed.sqlite");

  await mkdir(source);
  await writeFile(path.join(source, "sentinel"), "source sentinel");
  await assert.rejects(
    publishImportTargets(stagedSource, stagedDb, source, db),
    /already exists/,
  );
  assert.equal(
    await readFile(path.join(source, "sentinel"), "utf8"),
    "source sentinel",
  );
  await absent(db, "source collision database");
  await rm(source, { recursive: true, force: true });

  await writeFile(db, "database sentinel");
  await assert.rejects(
    publishImportTargets(stagedSource, stagedDb, source, db),
    /already exists/,
  );
  assert.equal(await readFile(db, "utf8"), "database sentinel");
  await absent(source, "database collision source cleanup");
  await rm(db, { force: true });

  const invalidSource = path.join(root, "invalid-staged-source");
  await mkdir(invalidSource);
  await symlink(
    stagedSource,
    path.join(invalidSource, "forbidden-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    publishImportTargets(invalidSource, stagedDb, source, db),
    /symlinks/,
  );
  await absent(source, "source-copy failure source cleanup");
  await absent(db, "source-copy failure database cleanup");

  const invalidDb = path.join(root, "invalid-staged-database");
  await mkdir(invalidDb);
  await assert.rejects(
    publishImportTargets(stagedSource, invalidDb, source, db),
    /EISDIR|illegal operation on a directory/,
  );
  await absent(source, "database-write failure source cleanup");
  await absent(db, "database-write failure database cleanup");
});

test("post-claim source replacement receives no package files", async (t) => {
  const { root, packageDir } = await packageFixture(t, false);
  const stagedSource = path.join(packageDir, "source");
  const stagedDb = path.join(root, "runtime.sqlite");
  const source = path.join(root, "replacement-source");
  const displaced = path.join(root, "displaced-owned-source");
  const db = path.join(root, "replacement.sqlite");
  const publication = publishImportTargets(stagedSource, stagedDb, source, db);
  let markerFound = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      markerFound = (await readdir(source)).some((name) =>
        name.startsWith(".doxvelt-import-"),
      );
    } catch {
      markerFound = false;
    }
    if (markerFound) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(markerFound, true, "source claim marker must become observable");
  await rename(source, displaced);
  await mkdir(source);
  await writeFile(path.join(source, "sentinel"), "foreign sentinel");
  await assert.rejects(publication, /ownership was lost/);
  assert.deepEqual(await readdir(source), ["sentinel"]);
  assert.equal(await readFile(path.join(source, "sentinel"), "utf8"), "foreign sentinel");
  await absent(displaced, "displaced owned claim cleanup");
  await absent(db, "replacement race database cleanup");
});
