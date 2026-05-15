import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

export const SOURCE_FOLDERS = [
  "models",
  "worlds",
  "scenarios",
  "formats",
  "entities",
  "connections"
];

export async function readWorldSource(worldPath) {
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

async function readFlatMarkdownLike(root, folder) {
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
      id: parsed.data.id || idFromFilename(entry.name),
      data: parsed.data,
      body: parsed.body,
      text
    });
  }

  return files;
}

async function readEntityFolders(root) {
  const dir = path.join(root, "entities");
  const entries = await safeReaddir(dir, { withFileTypes: true });
  const entities = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const entityDir = path.join(dir, entry.name);
    const files = [];
    const fileEntries = await safeReaddir(entityDir, { withFileTypes: true });

    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile()) continue;
      if (!/\.md$/i.test(fileEntry.name)) continue;

      const absolutePath = path.join(entityDir, fileEntry.name);
      const text = await readFile(absolutePath, "utf8");
      const parsed = parseFrontmatter(text);
      files.push({
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
      id: identity?.data.id || entry.name,
      kind: identity?.data.kind || "agent",
      name: identity?.data.name || titleFromId(entry.name),
      visibility: identity?.data.visibility || "public",
      folder: `entities/${entry.name}`,
      files
    });
  }

  return entities;
}

async function safeReaddir(dir, options) {
  try {
    return await readdir(dir, options);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function idFromFilename(filename) {
  return filename.replace(/\.(md|markdown|ya?ml|json)$/i, "");
}

function titleFromId(id) {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}
