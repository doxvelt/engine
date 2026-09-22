import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rmdir,
  unlink,
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
  schemaVersion: 6 | 7;
  exportedAt: string;
  ownerScope: string;
  simulationId: string;
  scenarioId: string | null;
  sourceRootName: string;
  files: { source: "source"; runtime: "simulation.json" };
};


export type ImportedSimulationPackageManifest = Omit<
  SimulationPackageManifest,
  "schemaVersion"
> & {
  schemaVersion: 4 | 5 | 6 | 7;
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
    schemaVersion: archive.schemaVersion as 6 | 7,
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
  manifest: ImportedSimulationPackageManifest;
  sourceRoot: string;
  dbPath: string;
}> {
  const resolvedPackage = path.resolve(packageDir);
  const packageStats = await lstat(resolvedPackage);
  if (packageStats.isSymbolicLink() || !packageStats.isDirectory())
    throw new DomainValidationError("Package path must be a real directory.");
  const manifest = JSON.parse(
    await readFile(path.join(resolvedPackage, "manifest.json"), "utf8"),
  ) as ImportedSimulationPackageManifest;
  validateManifest(manifest);
  const archive = JSON.parse(
    await readFile(path.join(resolvedPackage, manifest.files.runtime), "utf8"),
  ) as SimulationArchive;
  validateImportedManifestRuntimeBinding(manifest, archive);
  validateSimulationArchive(archive);
  if (
    expectedOwnerScope !== undefined &&
    archive.simulation.ownerScope !== expectedOwnerScope
  )
    throw new DomainValidationError(
      "Imported package owner scope does not match the trusted local scope.",
    );
  const sourceRoot = path.resolve(targetSourceDir);
  const dbPath = path.resolve(targetDbPath);
  await assertNoSymlinkPathComponents(sourceRoot);
  await assertNoSymlinkPathComponents(dbPath);
  assertDisjointImportTargets(sourceRoot, dbPath);
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
  try {
    await mkdir(path.dirname(sourceRoot), { recursive: true });
    await mkdir(path.dirname(dbPath), { recursive: true });
    sourceStageRoot = await mkdtemp(
      path.join(path.dirname(sourceRoot), ".import-source-"),
    );
    dbStageRoot = await mkdtemp(
      path.join(path.dirname(dbPath), ".import-database-"),
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
    await publishImportTargets(stagedSource, stagedDb, sourceRoot, dbPath);
  } finally {
    if (sourceStageRoot)
      await rm(sourceStageRoot, { recursive: true, force: true });
    if (dbStageRoot)
      await rm(dbStageRoot, { recursive: true, force: true });
  }
  return { manifest, sourceRoot, dbPath };
}

type FileIdentity = { dev: number; ino: number };
type SourceTargetClaim = {
  target: string;
  identity: FileIdentity;
  marker: string;
  token: string;
};
type DatabaseTargetClaim = {
  target: string;
  identity: FileIdentity;
  handle: Awaited<ReturnType<typeof open>> | null;
};

export async function publishImportTargets(
  stagedSource: string,
  stagedDb: string,
  sourceRoot: string,
  dbPath: string,
): Promise<void> {
  let sourceClaim: SourceTargetClaim | null = null;
  let databaseClaim: DatabaseTargetClaim | null = null;
  try {
    sourceClaim = await claimSourceTarget(sourceRoot);
    databaseClaim = await claimDatabaseTarget(dbPath);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assertOwnedSourceTarget(sourceClaim);
    await copyVerifiedDirectory(
      stagedSource,
      sourceClaim.target,
      await realpath(stagedSource),
      sourceClaim,
    );
    await assertOwnedDatabaseTarget(databaseClaim);
    const databaseHandle = databaseClaim.handle;
    if (!databaseHandle)
      throw new DomainValidationError(
        "Import database target claim is unavailable.",
      );
    await databaseHandle.writeFile(await readFile(stagedDb));
    await databaseHandle.sync();
    await assertOwnedDatabaseTarget(databaseClaim);
    await databaseHandle.close();
    databaseClaim.handle = null;
    await removeSourceClaimMarker(sourceClaim);
  } catch (error) {
    await cleanupDatabaseTargetClaim(databaseClaim);
    await cleanupSourceTargetClaim(sourceClaim);
    throw error;
  } finally {
    if (databaseClaim?.handle) await databaseClaim.handle.close();
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function claimSourceTarget(target: string): Promise<SourceTargetClaim> {
  try {
    await mkdir(target, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Import target already exists: " + target);
    throw error;
  }
  let marker: string | null = null;
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new DomainValidationError("Import source target claim is invalid.");
    const token = randomUUID();
    marker = path.join(target, ".doxvelt-import-" + token);
    await writeFile(marker, token, { flag: "wx", mode: 0o600 });
    return {
      target,
      identity: { dev: stats.dev, ino: stats.ino },
      marker,
      token,
    };
  } catch (error) {
    if (marker) await unlink(marker).catch(() => undefined);
    await rmdir(target).catch(() => undefined);
    throw error;
  }
}

async function ownsSourceTargetClaim(claim: SourceTargetClaim): Promise<boolean> {
  try {
    const target = await lstat(claim.target);
    if (
      target.isSymbolicLink() ||
      !target.isDirectory() ||
      !sameIdentity(claim.identity, target)
    ) return false;
    const marker = await lstat(claim.marker);
    return marker.isFile() && (await readFile(claim.marker, "utf8")) === claim.token;
  } catch {
    return false;
  }
}

async function assertOwnedSourceTarget(claim: SourceTargetClaim): Promise<void> {
  if (!await ownsSourceTargetClaim(claim))
    throw new DomainValidationError("Import source target ownership was lost.");
}

async function removeSourceClaimMarker(claim: SourceTargetClaim): Promise<void> {
  await assertOwnedSourceTarget(claim);
  await unlink(claim.marker);
}

async function cleanupSourceTargetClaim(
  claim: SourceTargetClaim | null,
): Promise<void> {
  if (!claim) return;
  const ownedPath = await findOwnedSourceClaimPath(claim);
  if (ownedPath) await rm(ownedPath, { recursive: true, force: false });
}

async function findOwnedSourceClaimPath(
  claim: SourceTargetClaim,
): Promise<string | null> {
  if (await ownsSourceTargetClaim(claim)) return claim.target;
  const parent = path.dirname(claim.target);
  try {
    for (const name of await readdir(parent)) {
      const candidate = path.join(parent, name);
      const stats = await lstat(candidate);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        !sameIdentity(claim.identity, stats)
      ) continue;
      const marker = path.join(candidate, path.basename(claim.marker));
      try {
        if ((await readFile(marker, "utf8")) === claim.token) return candidate;
      } catch {
        // Not the claimed directory.
      }
    }
  } catch {
    // Parent disappeared or is unreadable; nothing can be safely removed.
  }
  return null;
}

async function claimDatabaseTarget(target: string): Promise<DatabaseTargetClaim> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(target, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Import target already exists: " + target);
    throw error;
  }
  const stats = await handle.stat();
  return {
    target,
    identity: { dev: stats.dev, ino: stats.ino },
    handle,
  };
}

async function ownsDatabaseTargetClaim(
  claim: DatabaseTargetClaim,
): Promise<boolean> {
  try {
    const stats = await lstat(claim.target);
    return stats.isFile() && !stats.isSymbolicLink() && sameIdentity(claim.identity, stats);
  } catch {
    return false;
  }
}

async function assertOwnedDatabaseTarget(
  claim: DatabaseTargetClaim,
): Promise<void> {
  if (!await ownsDatabaseTargetClaim(claim))
    throw new DomainValidationError("Import database target ownership was lost.");
}

async function cleanupDatabaseTargetClaim(
  claim: DatabaseTargetClaim | null,
): Promise<void> {
  if (!claim) return;
  if (claim.handle) {
    await claim.handle.close();
    claim.handle = null;
  }
  if (await ownsDatabaseTargetClaim(claim))
    await rm(claim.target, { force: false });
}
async function assertNoSymlinkPathComponents(target: string): Promise<void> {
  const root = path.parse(target).root;
  let cursor = root;
  for (const segment of target.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink())
        throw new DomainValidationError(
          "Import target paths may not contain symbolic links.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function assertDisjointImportTargets(sourceRoot: string, dbPath: string): void {
  if (isSameOrContained(sourceRoot, dbPath) || isSameOrContained(dbPath, sourceRoot))
    throw new DomainValidationError(
      "Import source and database targets must not overlap.",
    );
}

function isSameOrContained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
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
  targetClaim?: SourceTargetClaim,
): Promise<void> {
  if (targetClaim) await assertOwnedSourceTarget(targetClaim);
  assertContained(trustedRoot, await realpath(sourceDir));
  for (const name of await readdir(sourceDir)) {
    if (targetClaim) await assertOwnedSourceTarget(targetClaim);
    const source = path.join(sourceDir, name);
    const target = path.join(targetDir, name);
    const stats = await lstat(source);
    if (stats.isSymbolicLink())
      throw new DomainValidationError("Package source may not contain symlinks.");
    assertContained(trustedRoot, await realpath(source));
    if (stats.isDirectory()) {
      await mkdir(target, { recursive: false });
      await copyVerifiedDirectory(source, target, trustedRoot, targetClaim);
    } else if (stats.isFile()) {
      await copyRegularFileNoFollow(source, target, stats.mode);
    } else {
      throw new DomainValidationError(
        "Package source may contain only regular files and directories.",
      );
    }
    if (targetClaim) await assertOwnedSourceTarget(targetClaim);
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
function validateManifest(
  manifest: ImportedSimulationPackageManifest,
): void {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    ![4, 5, 6, 7].includes(manifest.schemaVersion) ||
    Object.keys(manifest).length !== 8 ||
    !Object.hasOwn(manifest, "doxveltVersion") ||
    !Object.hasOwn(manifest, "exportedAt") ||
    !Object.hasOwn(manifest, "ownerScope") ||
    !Object.hasOwn(manifest, "simulationId") ||
    !Object.hasOwn(manifest, "scenarioId") ||
    !Object.hasOwn(manifest, "sourceRootName") ||
    !Object.hasOwn(manifest, "files") ||
    typeof manifest.doxveltVersion !== "string" ||
    typeof manifest.exportedAt !== "string" ||
    typeof manifest.ownerScope !== "string" ||
    typeof manifest.simulationId !== "string" ||
    (manifest.scenarioId !== null && typeof manifest.scenarioId !== "string") ||
    typeof manifest.sourceRootName !== "string" ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Object.keys(manifest.files).length !== 2 ||
    manifest.files.source !== "source" ||
    manifest.files.runtime !== "simulation.json"
  )
    throw new Error("Unsupported Doxvelt package schema or file layout.");
}

function validateImportedManifestRuntimeBinding(
  manifest: ImportedSimulationPackageManifest,
  archive: SimulationArchive,
): void {
  if (
    archive.schemaVersion !== manifest.schemaVersion ||
    !archive.simulation ||
    typeof archive.simulation !== "object" ||
    archive.simulation.ownerScope !== manifest.ownerScope ||
    archive.simulation.id !== manifest.simulationId ||
    archive.simulation.scenarioId !== manifest.scenarioId
  )
    throw new DomainValidationError(
      "Imported package schema or identity does not match its runtime archive.",
    );
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
