import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { openRuntimeStore } from "../store/sqlite.ts";

export type ExportSimulationPackageOptions = {
  dbPath: string;
  simulationId?: string;
  targetDir: string;
};

export type ImportSimulationPackageOptions = {
  packageDir: string;
  targetSourceDir: string;
  targetDbPath: string;
};

export type SimulationPackageManifest = {
  doxveltVersion: string;
  schemaVersion: 1;
  exportedAt: string;
  simulationId: string;
  scenarioId: string | null;
  sourceRootName: string;
  files: {
    source: "source";
    runtime: "runtime.sqlite";
  };
};

export async function exportSimulationPackage({
  dbPath,
  simulationId = "default",
  targetDir
}: ExportSimulationPackageOptions): Promise<{ manifest: SimulationPackageManifest; targetDir: string }> {
  const resolvedTarget = path.resolve(targetDir);
  const store = await openRuntimeStore(dbPath).open();
  const simulation = store.getSimulation(simulationId);
  store.close();

  if (!simulation) throw new Error(`Simulation not found: ${simulationId}`);

  const manifest: SimulationPackageManifest = {
    doxveltVersion: "0.0.0",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    simulationId: simulation.id,
    scenarioId: simulation.scenarioId,
    sourceRootName: path.basename(simulation.sourceRoot),
    files: {
      source: "source",
      runtime: "runtime.sqlite"
    }
  };

  await mkdir(resolvedTarget, { recursive: false });
  await copySanitizedSource(simulation.sourceRoot, path.join(resolvedTarget, manifest.files.source));
  await cp(path.resolve(dbPath), path.join(resolvedTarget, manifest.files.runtime), {
    errorOnExist: true,
    force: false
  });
  await writeFile(path.join(resolvedTarget, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return { manifest, targetDir: resolvedTarget };
}

async function copySanitizedSource(sourceRoot: string, targetRoot: string): Promise<void> {
  await mkdir(targetRoot, { recursive: false });
  await copySanitizedDirectory(sourceRoot, targetRoot);
}

async function copySanitizedDirectory(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldSkipExportEntry(entry)) continue;

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: false });
      await copySanitizedDirectory(sourcePath, targetPath);
      continue;
    }

    if (!entry.isFile()) continue;

    if (isTextSourceFile(entry.name)) {
      const text = await readFile(sourcePath, "utf8");
      await writeFile(targetPath, redactExportedSourceText(text));
    } else {
      await cp(sourcePath, targetPath, {
        errorOnExist: true,
        force: false
      });
    }
  }
}

function shouldSkipExportEntry(entry: Dirent): boolean {
  const name = entry.name.toLowerCase();
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".key") || name.endsWith(".pem");
}

function isTextSourceFile(filename: string): boolean {
  return /\.(md|markdown|ya?ml|json|txt)$/i.test(filename);
}

function redactExportedSourceText(text: string): string {
  return text.replace(/^(\s*api[_-]?key\s*:\s*).+$/gim, "$1[redacted]");
}

export async function importSimulationPackage({
  packageDir,
  targetSourceDir,
  targetDbPath
}: ImportSimulationPackageOptions): Promise<{ manifest: SimulationPackageManifest; sourceRoot: string; dbPath: string }> {
  const resolvedPackage = path.resolve(packageDir);
  const manifest = JSON.parse(
    await readFile(path.join(resolvedPackage, "manifest.json"), "utf8")
  ) as SimulationPackageManifest;
  const sourceRoot = path.resolve(targetSourceDir);
  const dbPath = path.resolve(targetDbPath);

  validateManifest(manifest);
  await mkdir(path.dirname(sourceRoot), { recursive: true });
  await mkdir(path.dirname(dbPath), { recursive: true });
  await cp(path.join(resolvedPackage, manifest.files.source), sourceRoot, {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  await cp(path.join(resolvedPackage, manifest.files.runtime), dbPath, {
    errorOnExist: true,
    force: false
  });

  return { manifest, sourceRoot, dbPath };
}

function validateManifest(manifest: SimulationPackageManifest): void {
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported Doxvelt package schema version: ${String(manifest.schemaVersion)}`);
  }
  if (manifest.files.source !== "source" || manifest.files.runtime !== "runtime.sqlite") {
    throw new Error("Unsupported Doxvelt package file layout.");
  }
}
