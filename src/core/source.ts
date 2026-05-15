import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import type { EntityKind, EntitySource, EntitySourceFile, SourceFile, WorldSource } from "./types.ts";

export const SOURCE_FOLDERS = [
  "models",
  "worlds",
  "scenarios",
  "formats",
  "entities",
  "connections"
];

export async function readWorldSource(worldPath: string): Promise<WorldSource> {
  const root = path.resolve(worldPath);

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
