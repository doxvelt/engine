import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { SimulationArchive } from "../core/ports.ts";
import { DomainValidationError } from "../core/ports.ts";
import { fingerprintCommand } from "../core/branch-kernel.ts";
import { validateSimulationArchive } from "../core/archive-verifier.ts";
import { openBranchStore } from "./branch-sqlite.ts";

export type ExportSimulationPackageOptions = {
  dbPath: string;
  ownerScope?: string;
  simulationId?: string;
  targetDir: string;
};
export type ImportSimulationPackageOptions = {
  packageDir: string;
  targetSourceDir: string;
  targetDbPath: string;
  expectedOwnerScope?: string;
};
export type SimulationPackageManifest = {
  doxveltVersion: string;
  schemaVersion: 5;
  exportedAt: string;
  ownerScope: string;
  simulationId: string;
  scenarioId: string | null;
  sourceRootName: string;
  files: { source: "source"; runtime: "simulation.json" };
};

export async function exportSimulationPackage({
  dbPath,
  ownerScope = "local",
  simulationId = "default",
  targetDir,
}: ExportSimulationPackageOptions): Promise<{
  manifest: SimulationPackageManifest;
  targetDir: string;
}> {
  const store = await openBranchStore(dbPath).open();
  let archive: SimulationArchive;
  try {
    archive = store.exportSimulation(ownerScope, simulationId);
  } finally {
    store.close();
  }
  const oldSourceRoot = archive.simulation.sourceRoot;
  const portableArchive = structuredClone(archive);
  rewriteArchiveSourceRoot(portableArchive, oldSourceRoot, "source");
  for (const command of portableArchive.commandResults)
    command.fingerprint = fingerprintCommand(command.canonicalInput);
  validateSimulationArchive(portableArchive);
  const runtimeJson = `${JSON.stringify(portableArchive, null, 2)}\n`;
  if (runtimeJson.includes(oldSourceRoot))
    throw new DomainValidationError(
      "Portable simulation contains an absolute source path.",
    );
  const resolvedTarget = path.resolve(targetDir);
  const manifest: SimulationPackageManifest = {
    doxveltVersion: "0.0.0",
    schemaVersion: 5,
    exportedAt: new Date().toISOString(),
    ownerScope,
    simulationId,
    scenarioId: portableArchive.simulation.scenarioId,
    sourceRootName: path.basename(oldSourceRoot),
    files: { source: "source", runtime: "simulation.json" },
  };
  await mkdir(resolvedTarget, { recursive: false });
  await copySanitizedSource(
    oldSourceRoot,
    path.join(resolvedTarget, manifest.files.source),
  );
  await writeFile(
    path.join(resolvedTarget, manifest.files.runtime),
    runtimeJson,
  );
  await writeFile(
    path.join(resolvedTarget, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { manifest, targetDir: resolvedTarget };
}

export async function importSimulationPackage({
  packageDir,
  targetSourceDir,
  targetDbPath,
  expectedOwnerScope,
}: ImportSimulationPackageOptions): Promise<{
  manifest: SimulationPackageManifest;
  sourceRoot: string;
  dbPath: string;
}> {
  const resolvedPackage = path.resolve(packageDir);
  const packageStats = await lstat(resolvedPackage);
  if (packageStats.isSymbolicLink() || !packageStats.isDirectory())
    throw new DomainValidationError("Package path must be a real directory.");
  const manifest = JSON.parse(
    await readFile(path.join(resolvedPackage, "manifest.json"), "utf8"),
  ) as SimulationPackageManifest;
  validateManifest(manifest);
  const archive = JSON.parse(
    await readFile(path.join(resolvedPackage, manifest.files.runtime), "utf8"),
  ) as SimulationArchive;
  validateSimulationArchive(archive);
  if (
    manifest.ownerScope !== archive.simulation.ownerScope ||
    (expectedOwnerScope !== undefined &&
      archive.simulation.ownerScope !== expectedOwnerScope)
  )
    throw new DomainValidationError(
      "Imported package owner scope does not match the trusted local scope.",
    );
  const sourceRoot = path.resolve(targetSourceDir);
  const dbPath = path.resolve(targetDbPath);
  const oldSourceRoot = archive.simulation.sourceRoot;
  if (oldSourceRoot !== manifest.files.source)
    throw new DomainValidationError(
      "Imported simulation must use the logical package source reference.",
    );
  rewriteArchiveSourceRoot(archive, oldSourceRoot, sourceRoot);
  for (const command of archive.commandResults)
    command.fingerprint = fingerprintCommand(command.canonicalInput);
  validateSimulationArchive(archive);
  await assertImportTargetAbsent(sourceRoot);
  await assertImportTargetAbsent(dbPath);
  let sourceStageRoot: string | null = null;
  let dbStageRoot: string | null = null;
  let sourceMoved = false;
  let dbMoved = false;
  try {
    await mkdir(path.dirname(sourceRoot), { recursive: true });
    await mkdir(path.dirname(dbPath), { recursive: true });
    sourceStageRoot = await mkdtemp(
      path.join(path.dirname(sourceRoot), `.${path.basename(sourceRoot)}-import-`),
    );
    dbStageRoot = await mkdtemp(
      path.join(path.dirname(dbPath), `.${path.basename(dbPath)}-import-`),
    );
    const stagedSource = path.join(sourceStageRoot, "source");
    const stagedDb = path.join(dbStageRoot, "runtime.sqlite");
    await copyVerifiedSource(
      path.join(resolvedPackage, manifest.files.source),
      stagedSource,
    );
    const store = await openBranchStore(stagedDb).open();
    try {
      store.importSimulation(archive);
    } finally {
      store.close();
    }
    await rename(stagedSource, sourceRoot);
    sourceMoved = true;
    await rename(stagedDb, dbPath);
    dbMoved = true;
  } catch (error) {
    if (sourceMoved) await rm(sourceRoot, { recursive: true, force: true });
    if (dbMoved) await rm(dbPath, { force: true });
    throw error;
  } finally {
    if (sourceStageRoot)
      await rm(sourceStageRoot, { recursive: true, force: true });
    if (dbStageRoot)
      await rm(dbStageRoot, { recursive: true, force: true });
  }
  return { manifest, sourceRoot, dbPath };
}

async function assertImportTargetAbsent(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Import target already exists: ${target}`);
}

async function copySanitizedSource(sourceRoot: string, targetRoot: string) {
  await mkdir(targetRoot, { recursive: false });
  await copySanitizedDirectory(sourceRoot, targetRoot);
}
async function copySanitizedDirectory(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (skip(entry)) continue;
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(target, { recursive: false });
      await copySanitizedDirectory(source, target);
    } else if (entry.isFile()) {
      if (/\.(md|markdown|ya?ml|json|txt)$/i.test(entry.name))
        await writeFile(
          target,
          (await readFile(source, "utf8")).replace(
            /^(\s*api[_-]?key\s*:\s*).+$/gim,
            "$1[redacted]",
          ),
        );
      else await cp(source, target, { errorOnExist: true, force: false });
    }
  }
}

async function copyVerifiedSource(sourceRoot: string, targetRoot: string) {
  const rootStats = await lstat(sourceRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
    throw new DomainValidationError("Package source must be a real directory.");
  const trustedRoot = await realpath(sourceRoot);
  await mkdir(targetRoot, { recursive: false });
  await copyVerifiedDirectory(sourceRoot, targetRoot, trustedRoot);
}

async function copyVerifiedDirectory(
  sourceDir: string,
  targetDir: string,
  trustedRoot: string,
): Promise<void> {
  assertContained(trustedRoot, await realpath(sourceDir));
  for (const name of await readdir(sourceDir)) {
    const source = path.join(sourceDir, name);
    const target = path.join(targetDir, name);
    const stats = await lstat(source);
    if (stats.isSymbolicLink())
      throw new DomainValidationError("Package source may not contain symlinks.");
    assertContained(trustedRoot, await realpath(source));
    if (stats.isDirectory()) {
      await mkdir(target, { recursive: false });
      await copyVerifiedDirectory(source, target, trustedRoot);
    } else if (stats.isFile()) {
      await copyRegularFileNoFollow(source, target, stats.mode);
    } else {
      throw new DomainValidationError(
        "Package source may contain only regular files and directories.",
      );
    }
  }
}

async function copyRegularFileNoFollow(
  source: string,
  target: string,
  mode: number,
): Promise<void> {
  const sourceHandle = await open(
    source,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0),
  );
  try {
    const stats = await sourceHandle.stat();
    if (!stats.isFile() || stats.nlink > 1)
      throw new DomainValidationError("Package source entry changed during copy.");
    const targetHandle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode & 0o777,
    );
    try {
      await targetHandle.writeFile(await sourceHandle.readFile());
    } finally {
      await targetHandle.close();
    }
  } finally {
    await sourceHandle.close();
  }
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
    return;
  throw new DomainValidationError("Package source escapes its source directory.");
}
function skip(entry: Dirent) {
  const name = entry.name.toLowerCase();
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name.endsWith(".key") ||
    name.endsWith(".pem")
  );
}
function validateManifest(manifest: SimulationPackageManifest) {
  if (
    ![4, 5].includes(manifest.schemaVersion) ||
    manifest.files.source !== "source" ||
    manifest.files.runtime !== "simulation.json"
  )
    throw new Error("Unsupported Doxvelt package schema or file layout.");
}
function rewriteArchiveSourceRoot(
  archive: SimulationArchive,
  before: string,
  after: string,
): void {
  if (archive.simulation.sourceRoot !== before)
    throw new DomainValidationError("Simulation source reference is invalid.");
  archive.simulation.sourceRoot = after;
  if (archive.contentRevision.compiled.sourceRoot === before)
    archive.contentRevision.compiled.sourceRoot = after;
  for (const command of archive.commandResults) {
    if (command.canonicalInput.kind === "start") {
      if (command.canonicalInput.sourceRoot !== before)
        throw new DomainValidationError("Start command source reference is invalid.");
      command.canonicalInput.sourceRoot = after;
      if (
        "compiled" in command.canonicalInput &&
        command.canonicalInput.compiled.sourceRoot === before
      )
        command.canonicalInput.compiled.sourceRoot = after;
    }
    if (command.result.kind !== "start") continue;
    if (command.result.simulation.sourceRoot !== before)
      throw new DomainValidationError("Start outcome source reference is invalid.");
    command.result.simulation.sourceRoot = after;
    if (command.result.contentRevision?.compiled.sourceRoot === before)
      command.result.contentRevision.compiled.sourceRoot = after;
  }
}
