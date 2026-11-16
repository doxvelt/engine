import assert from "node:assert/strict";
import { cp, link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { commitManualTurn, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { exportSimulationPackage, importSimulationPackage } from "../src/store/portable.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";

for (const exporting of ["native", "typescript"]) {
  test(`native package transport interoperates with reference history and source rebinding (${exporting} export)`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-package-"));
    const database = path.join(root, "story.sqlite");
    const source = path.join(root, "authored");
    await cp(path.resolve("examples/last-crossing"), source, { recursive: true });
    await writeFile(path.join(source, ".env"), "PRIVATE-ENV");
    await writeFile(path.join(source, "secret.pem"), "PRIVATE-KEY");
    await writeFile(path.join(source, "notes.txt"), "api-key: PRIVATE-CREDENTIAL\nordinary: content\n");
    const store = await openBranchStore(database).open();
    try {
      const base = { ownerScope: "local", simulationId: "sim", branchId: "main" };
      const started = await startBranchSimulation(store, { ...base, commandId: "start", workspacePath: source });
      const command = { ...base, expectedHead: started.root.id, commandId: "turn", payload: { actorId: "corin", text: "A portable occurrence.", audience: ["mara"], knowledgePolicy: "actor-knowledge-v1" as const, stageWhisper: null, stageWhisperIds: [], audienceChanges: [], accessChanges: [] } };
      const accepted = commitManualTurn(store, command);
      const packageDir = path.join(root, "package");
      const exported = exporting === "native"
        ? await nativeRequest("/packages/export", { simulationId: "sim", targetDir: packageDir }, database)
        : await exportSimulationPackage({ dbPath: database, simulationId: "sim", targetDir: packageDir });
      const entries = await readdir(path.join(packageDir, "source"));
      assert.ok(!entries.includes(".env") && !entries.includes("secret.pem"));
      assert.equal(await readFile(path.join(packageDir, "source/notes.txt"), "utf8"), "api-key: [redacted]\nordinary: content\n");
      const logical = JSON.parse(await readFile(path.join(packageDir, "simulation.json"), "utf8"));
      assert.equal(logical.simulation.sourceRoot, "source"); validateSimulationArchive(logical);
      const targetSourceDir = path.join(root, "imported-source");
      const targetDbPath = path.join(root, "imported.sqlite");
      const imported = exporting === "native"
        ? await importSimulationPackage({ packageDir, targetSourceDir, targetDbPath, expectedOwnerScope: "local" })
        : await nativeRequest("/packages/import", { packageDir, targetSourceDir }, targetDbPath);
      assert.deepEqual(imported, { manifest: exported.manifest, sourceRoot: targetSourceDir, dbPath: targetDbPath });
      const replay = await nativeRequest("/simulations/sim/turns", { branchId: "main", expectedHead: started.root.id, commandId: "turn", ...command.payload, manualText: command.payload.text }, targetDbPath);
      assert.equal(replay.replayed, true); assert.equal(replay.commit.id, accepted.commit.id);
      const reader = await openBranchStore(targetDbPath).open();
      try { const archive = reader.exportSimulation("local", "sim"); validateSimulationArchive(archive); assert.equal(archive.simulation.sourceRoot, targetSourceDir); }
      finally { reader.close(); }
      await nativeRequest("/packages/import", { packageDir, targetSourceDir, targetDbPath }, database, 500);
      const outside = path.join(root, "outside.md"); await writeFile(outside, "PRIVATE-EXTERNAL");
      await link(outside, path.join(packageDir, "source/hardlink.md"));
      await nativeRequest("/packages/import", { packageDir, targetSourceDir: path.join(root, "rejected-source"), targetDbPath: path.join(root, "rejected.sqlite") }, database, 400);
      assert.ok(!(await readdir(root)).some(name => name.startsWith(".import-") || name.startsWith("rejected")));
      assert.equal(await readFile(outside, "utf8"), "PRIVATE-EXTERNAL");
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
}
