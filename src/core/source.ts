import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import type { EntityKind, EntitySource, EntitySourceFile, SourceFile, WorkspaceSource } from "./types.ts";

export const SOURCE_FOLDERS = [
  "models",
  "worlds",
  "scenarios",
  "formats",
  "entities",
  "connections"
];

const PROTECTED_REPOSITORY_FOLDERS = new Set([
  ".git",
  "design-system",
  "docs",
  "examples",
  "scripts",
  "src",
  "tests"
]);

export type SourceFileSummary = {
  id: string;
  name: string;
  path: string;
  kind: "model" | "world" | "scenario" | "format" | "entity-file" | "connection";
  entityId?: string;
  entityName?: string;
  entityKind?: EntityKind;
  section?: string;
};

export async function readWorkspaceSource(workspacePath: string): Promise<WorkspaceSource> {
  const root = path.resolve(workspacePath);

  return {
    root,
    models: await readFlatMarkdownLike(root, "models"),
    worlds: await readFlatMarkdownLike(root, "worlds"),
    scenarios: await readFlatMarkdownLike(root, "scenarios"),
    formats: await readFlatMarkdownLike(root, "formats"),
    entities: await readEntityFolders(root),
    connections: await readFlatMarkdownLike(root, "connections")
  };
}

export async function listWorkspaceSourceFiles(workspacePath: string): Promise<{ root: string; files: SourceFileSummary[] }> {
  const source = await readWorkspaceSource(workspacePath);
  const files: SourceFileSummary[] = [
    ...source.models.map((file) => summarizeFlatSourceFile(file, "model")),
    ...source.worlds.map((file) => summarizeFlatSourceFile(file, "world")),
    ...source.scenarios.map((file) => summarizeFlatSourceFile(file, "scenario")),
    ...source.formats.map((file) => summarizeFlatSourceFile(file, "format")),
    ...source.connections.map((file) => summarizeFlatSourceFile(file, "connection"))
  ];

  for (const entity of source.entities) {
    for (const file of entity.files) {
      files.push({
        id: `${entity.id}:${file.section}`,
        name: file.name,
        path: file.path,
        kind: "entity-file",
        entityId: entity.id,
        entityName: entity.name,
        entityKind: entity.kind,
        section: file.section
      });
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return { root: source.root, files };
}

export async function readSourceText(workspacePath: string, relativePath: string): Promise<{ root: string; path: string; text: string }> {
  const root = path.resolve(workspacePath);
  const absolutePath = resolveSourcePath(root, relativePath);
  const text = await readFile(absolutePath, "utf8");
  return {
    root,
    path: path.relative(root, absolutePath).replaceAll("\\", "/"),
    text
  };
}

export async function writeSourceText(
  workspacePath: string,
  relativePath: string,
  text: string
): Promise<{ root: string; path: string; text: string }> {
  const root = path.resolve(workspacePath);
  const absolutePath = resolveSourcePath(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text, "utf8");
  return {
    root,
    path: path.relative(root, absolutePath).replaceAll("\\", "/"),
    text
  };
}

export async function deleteWorkspaceSource(workspacePath: string): Promise<{ root: string; deleted: true }> {
  const root = path.resolve(workspacePath);
  const rootStats = await stat(root);
  if (!rootStats.isDirectory()) {
    throw new Error("Workspace path must be a directory.");
  }

  const missingFolders = [];
  for (const folder of SOURCE_FOLDERS) {
    try {
      const folderStats = await stat(path.join(root, folder));
      if (!folderStats.isDirectory()) missingFolders.push(folder);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        missingFolders.push(folder);
      } else {
        throw error;
      }
    }
  }

  if (missingFolders.length > 0) {
    throw new Error(`Path does not look like a Doxvelt workspace. Missing folders: ${missingFolders.join(", ")}.`);
  }

  if (root === path.parse(root).root || root === process.cwd()) {
    throw new Error("Refusing to delete this workspace path.");
  }

  const relativeToRepository = path.relative(process.cwd(), root);
  const isInsideRepository = relativeToRepository && !relativeToRepository.startsWith("..") && !path.isAbsolute(relativeToRepository);
  const repositoryTopLevelFolder = relativeToRepository.split(path.sep).at(0);
  if (isInsideRepository && repositoryTopLevelFolder && PROTECTED_REPOSITORY_FOLDERS.has(repositoryTopLevelFolder)) {
    throw new Error(`Refusing to delete protected repository folder: ${repositoryTopLevelFolder}.`);
  }

  await rm(root, { recursive: true, force: false });
  return { root, deleted: true };
}

async function readFlatMarkdownLike(root: string, folder: string): Promise<SourceFile[]> {
  const dir = path.join(root, folder);
  const entries = await safeReaddir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(md|markdown|ya?ml|json)$/i.test(entry.name)) continue;

    const absolutePath = path.join(dir, entry.name);
    const text = await readFile(absolutePath, "utf8");
    const parsed = parseFrontmatter(text);
    files.push({
      path: path.relative(root, absolutePath).replaceAll("\\", "/"),
      name: entry.name,
      id: stringValue(parsed.data.id) || idFromFilename(entry.name),
      data: parsed.data,
      body: parsed.body,
      text
    });
  }

  return files;
}

async function readEntityFolders(root: string): Promise<EntitySource[]> {
  const dir = path.join(root, "entities");
  const entries = await safeReaddir(dir, { withFileTypes: true });
  const entities = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const entityDir = path.join(dir, entry.name);
    const files: EntitySourceFile[] = [];
    const fileEntries = await safeReaddir(entityDir, { withFileTypes: true });

    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile()) continue;
      if (!/\.md$/i.test(fileEntry.name)) continue;

      const absolutePath = path.join(entityDir, fileEntry.name);
      const text = await readFile(absolutePath, "utf8");
      const parsed = parseFrontmatter(text);
      files.push({
        id: idFromFilename(fileEntry.name),
        path: path.relative(root, absolutePath).replaceAll("\\", "/"),
        name: fileEntry.name,
        section: fileEntry.name.replace(/\.md$/i, ""),
        data: parsed.data,
        body: parsed.body,
        text
      });
    }

    const identity = files.find((file) => file.name.toUpperCase() === "IDENTITY.MD");
    entities.push({
      id: stringValue(identity?.data.id) || entry.name,
      kind: entityKindValue(identity?.data.kind) || "agent",
      rawKind: identity?.data.kind,
      name: stringValue(identity?.data.name) || titleFromId(entry.name),
      visibility: stringValue(identity?.data.visibility) || "public",
      folder: `entities/${entry.name}`,
      files
    });
  }

  return entities;
}

async function safeReaddir(dir: string, options: { withFileTypes: true }): Promise<Dirent[]> {
  try {
    return await readdir(dir, options);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function summarizeFlatSourceFile(
  file: SourceFile,
  kind: SourceFileSummary["kind"]
): SourceFileSummary {
  return {
    id: file.id,
    name: file.name,
    path: file.path,
    kind
  };
}

function resolveSourcePath(root: string, relativePath: string): string {
  const normalizedRelativePath = relativePath.replaceAll("\\", "/");
  const firstSegment = normalizedRelativePath.split("/").at(0);
  if (!firstSegment || !SOURCE_FOLDERS.includes(firstSegment)) {
    throw new Error(`Source path must start with one of: ${SOURCE_FOLDERS.join(", ")}.`);
  }

  if (!/\.(md|markdown|ya?ml|json)$/i.test(normalizedRelativePath)) {
    throw new Error("Source path must be a Markdown, YAML, or JSON file.");
  }

  const absolutePath = path.resolve(root, normalizedRelativePath);
  const relativeToRoot = path.relative(root, absolutePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("Source path must stay inside the workspace source folder.");
  }

  return absolutePath;
}

function idFromFilename(filename: string): string {
  return filename.replace(/\.(md|markdown|ya?ml|json)$/i, "");
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part: string) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function entityKindValue(value: unknown): EntityKind | undefined {
  if (value === "agent" || value === "affiliation" || value === "artifact" || value === "stateless") {
    return value;
  }

  return undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
