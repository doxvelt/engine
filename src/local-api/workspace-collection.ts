import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileWorkspaceSource } from "../core/compiler.ts";
import { LOCAL_OWNER_SCOPE, startBranchSimulationFromCompiled } from "../core/branch-kernel.ts";
import { canOwnTurn } from "../core/turn-ownership.ts";
import { readWorkspaceSource, readSourceText, publishSourceText, type SourceFileSummary } from "../core/source.ts";
import { openBranchStore, type SqliteSimulationRepository } from "../store/branch-sqlite.ts";
import type { EpisodeMemory } from "../memory/episodes.ts";

export class WorkspaceCollectionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type HarnessModel = { provider: string; model: string };
export type WorkspaceConfiguration = {
  version: 1;
  actorModel?: HarnessModel;
  reflectionModel?: HarnessModel;
};

const sourceKinds = { world: "worlds", scenario: "scenarios", character: "entities", format: "formats" } as const;
type SourceKind = keyof typeof sourceKinds;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** The host supplies a registered workspace, never a path from the browser. */
export async function workspaceLocation(directory: string) {
  const root = await realpath(directory);
  const data = path.join(root, ".doxvelt");
  try {
    const entry = await lstat(data);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(data) !== data)
      throw new WorkspaceCollectionError("unsafe-data-directory", "The workspace's .doxvelt must be a local directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const child of ["workspace.json", "runtime.sqlite", "scene-headings.sqlite", "memory", "memory/catalog.sqlite"]) {
    try {
      const entry = await lstat(path.join(data, child));
      if (entry.isSymbolicLink() || (child === "memory" ? !entry.isDirectory() : !entry.isFile() || entry.nlink > 1))
        throw new WorkspaceCollectionError("unsafe-data-path", "Doxvelt data must stay in private files and directories inside this workspace.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { root, data, configuration: path.join(data, "workspace.json"), database: path.join(data, "runtime.sqlite") };
}

export async function readWorkspaceConfiguration(directory: string): Promise<WorkspaceConfiguration | null> {
  const location = await workspaceLocation(directory);
  try {
    const config: unknown = JSON.parse(await readFile(location.configuration, "utf8"));
    return validateConfiguration(config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validateConfiguration(value: unknown): WorkspaceConfiguration {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1)
    throw new WorkspaceCollectionError("invalid-configuration", "This workspace has an unsupported Doxvelt configuration.");
  const config = value as WorkspaceConfiguration;
  if (Object.keys(config).some(key => !["version", "actorModel", "reflectionModel"].includes(key)))
    throw new WorkspaceCollectionError("invalid-configuration", "Doxvelt workspace settings contain an unsupported field.");
  for (const model of [config.actorModel, config.reflectionModel]) {
    if (model !== undefined && (!model || Object.keys(model).some(key => !["provider", "model"].includes(key)) || typeof model.provider !== "string" || !model.provider.trim() ||
        typeof model.model !== "string" || !model.model.trim()))
      throw new WorkspaceCollectionError("invalid-model", "Choose a provider and model configured in DSH.");
  }
  return config;
}

export const configurationRevision = (config: WorkspaceConfiguration) => digest(JSON.stringify(config));

export async function saveWorkspaceConfiguration(directory: string, config: WorkspaceConfiguration, expectedRevision: string, signal?: AbortSignal) {
  validateConfiguration(config);
  const current = await readWorkspaceConfiguration(directory);
  if (!current || configurationRevision(current) !== expectedRevision)
    throw new WorkspaceCollectionError("configuration-changed", "Workspace settings changed. Reopen settings before saving.", 409);
  const location = await workspaceLocation(directory);
  const temporary = location.configuration + "." + randomUUID() + ".tmp";
  signal?.throwIfAborted();
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    signal?.throwIfAborted();
    await rename(temporary, location.configuration);
  } finally { await unlink(temporary).catch(() => {}); }
  return { configuration: config, configurationRevision: configurationRevision(config) };
}

export async function activateWorkspace(directory: string, signal?: AbortSignal) {
  const location = await workspaceLocation(directory);
  signal?.throwIfAborted();
  await mkdir(location.data, { recursive: true });
  const existing = await readWorkspaceConfiguration(directory);
  if (existing) return existing;
  const temporary = location.configuration + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify({ version: 1 }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    signal?.throwIfAborted();
    try { await link(temporary, location.configuration); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await unlink(temporary).catch(() => {}); }
  return readWorkspaceConfiguration(directory);
}

export async function workspaceCollection(directory: string) {
  return (await collectionSnapshot(directory)).collection;
}

async function collectionSnapshot(directory: string) {
  const { root } = await workspaceLocation(directory);
  const source = await readWorkspaceSource(root);
  const files: Array<{ file: { path: string; text: string }; summary: SourceFileSummary }> = [];
  for (const [key, kind] of [["models", "model"], ["worlds", "world"], ["scenarios", "scenario"],
    ["formats", "format"], ["connections", "connection"]] as const) {
    for (const file of source[key]) files.push({ file, summary: { id: file.id, name: file.name, path: file.path, kind } });
  }
  for (const entity of source.entities) for (const file of entity.files) files.push({ file, summary: {
    id: entity.id + ":" + file.section, name: file.name, path: file.path, kind: "entity-file",
    entityId: entity.id, entityName: entity.name, entityKind: entity.kind, section: file.section,
  } });
  const sources = await Promise.all(files.map(async ({ file, summary }) => {
    if ((await readSourceText(root, file.path)).text !== file.text)
      throw new WorkspaceCollectionError("collection-changed", "Source changed while reading the collection. Reopen it and try again.", 409);
    return { ...summary, revision: digest(file.text) };
  }));
  sources.sort((a, b) => a.path.localeCompare(b.path));
  const compiled = compileWorkspaceSource(source);
  const collection = {
    revision: digest(JSON.stringify(sources.map(file => [file.path, file.revision]))),
    worlds: compiled.worlds.map(({ id, name }) => ({ id, name })),
    scenarios: compiled.scenarios.map(({ id, name }) => ({ id, name })),
    formats: compiled.formats.map(({ id, name }) => ({ id, name })),
    characters: compiled.entities.filter(canOwnTurn).map(({ id, name }) => ({ id, name })),
    files: sources,
    diagnostics: compiled.diagnostics,
  };
  return { compiled, collection };
}

export async function createCollectionObject(directory: string, input: {
  kind: SourceKind; id: string; name: string; body: string;
}, signal?: AbortSignal) {
  if (!input || !Object.hasOwn(sourceKinds, input.kind) || typeof input.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(input.id))
    throw new WorkspaceCollectionError("invalid-object", "Choose a short lowercase object ID using letters, digits, hyphens or underscores.");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120 || /[\r\n\x00-\x1f]/.test(input.name) ||
      typeof input.body !== "string" || input.body.length > 500_000)
    throw new WorkspaceCollectionError("invalid-object", "Enter a name and Markdown description.");
  const filename = input.kind === "character" ? `entities/${input.id}/IDENTITY.md` : `${sourceKinds[input.kind]}/${input.id}.md`;
  const text = `---\nid: ${input.id}\nname: ${JSON.stringify(input.name.trim())}\n${input.kind === "character" ? "kind: agent\nvisibility: public\n" : ""}---\n\n${input.body}\n`;
  await saveCollectionSource(directory, { path: filename, text, expectedRevision: null }, signal);
  return { path: filename, revision: digest(text) };
}

/** Hosts serialize writes; expected revisions also reject edits from stale views. */
export async function saveCollectionSource(directory: string, input: {
  path: string; text: string; expectedRevision: string | null;
}, signal?: AbortSignal) {
  const { root } = await workspaceLocation(directory);
  if (!input || typeof input.path !== "string" || input.path.length > 512 || typeof input.text !== "string" || input.text.length > 500_000)
    throw new WorkspaceCollectionError("invalid-source", "Source text must be at most 500,000 characters.");
  let current: string | null = null;
  try { current = (await readSourceText(root, input.path)).text; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if ((current === null ? null : digest(current)) !== input.expectedRevision)
    throw new WorkspaceCollectionError("source-changed", "This source changed. Reopen it before saving your changes.", 409);
  signal?.throwIfAborted();
  await publishSourceText(root, input.path, input.text, current, signal);
  return { path: input.path, revision: digest(input.text) };
}

export type StorySetup = {
  operationId: string;
  collectionRevision: string;
  worldId: string;
  scenarioId: string;
  formatId: string;
  characterIds: string[];
  date: string;
};

export async function startCollectionStory(directory: string, setup: StorySetup, memory: EpisodeMemory, signal?: AbortSignal) {
  if (!setup || typeof setup.operationId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(setup.operationId))
    throw new WorkspaceCollectionError("invalid-operation", "Story creation needs a stable operation ID.");
  const date = new Date(setup.date);
  if (typeof setup.date !== "string" || !/^\d{4}-\d\d-\d\d$/.test(setup.date) || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== setup.date)
    throw new WorkspaceCollectionError("invalid-date", "Enter the episode's fictional date as YYYY-MM-DD.");
  if (!Array.isArray(setup.characterIds) || !setup.characterIds.length || setup.characterIds.some(id => typeof id !== "string") ||
      Object.keys(setup).some(key => !["operationId", "collectionRevision", "worldId", "scenarioId", "formatId", "characterIds", "date"].includes(key)))
    throw new WorkspaceCollectionError("incomplete-setup", "Choose a world, scenario, format and at least one character from this workspace.");
  const location = await workspaceLocation(directory);
  if (!await readWorkspaceConfiguration(directory)) throw new WorkspaceCollectionError("inactive-workspace", "Activate Doxvelt in this workspace first.", 409);
  const identity = (input: StorySetup) => JSON.stringify([input.operationId, input.collectionRevision,
    input.worldId, input.scenarioId, input.formatId, [...input.characterIds].sort(), input.date]);
  function datedStory(store: SqliteSimulationRepository, simulationId: string, branchId: string) {
    const selection = { ownerScope: LOCAL_OWNER_SCOPE, simulationId, branchId };
    try {
      const first = memory.inspect(store, selection).find(episode => episode.slot === "first")!;
      // A creation retry must not undo a later, deliberate date correction.
      if (!first.date) memory.setDate(store, selection, "first", setup.date);
      return { status: "complete" as const, simulationId, branchId };
    } catch {
      return { status: "partial" as const, simulationId, branchId,
        pending: "date", message: "The story is saved. Open Episode memory to retry setting its date." };
    }
  }
  signal?.throwIfAborted();
  const existingStore = await openBranchStore(location.database).open();
  try {
    signal?.throwIfAborted();
    const existing = existingStore.getSimulation(LOCAL_OWNER_SCOPE, "story-" + setup.operationId);
    if (existing) {
      const revision = existingStore.getContentRevision(LOCAL_OWNER_SCOPE, existing.contentRevisionId)!;
      const recorded = revision.compiled.scenarios.find(item => item.id === existing.scenarioId)?.metadata.doxvelt_setup;
      if (typeof recorded !== "string" || identity(JSON.parse(recorded)) !== identity(setup))
        throw new WorkspaceCollectionError("operation-conflict", "This creation operation already belongs to another episode setup.", 409);
      return datedStory(existingStore, existing.id, existing.defaultBranchId);
    }
  } finally { existingStore.close(); }
  const { collection, compiled } = await collectionSnapshot(directory);
  if (collection.revision !== setup.collectionRevision)
    throw new WorkspaceCollectionError("collection-changed", "The collection changed. Review the episode setup and try again.", 409);
  const world = compiled.worlds.find(item => item.id === setup.worldId);
  const scenario = compiled.scenarios.find(item => item.id === setup.scenarioId);
  const format = compiled.formats.find(item => item.id === setup.formatId);
  if (!world || !scenario || !format || !Array.isArray(setup.characterIds) || !setup.characterIds.length ||
      new Set(setup.characterIds).size !== setup.characterIds.length ||
      setup.characterIds.some(id => !collection.characters.some(character => character.id === id)))
    throw new WorkspaceCollectionError("incomplete-setup", "Choose a world, scenario, format and at least one character from this workspace.");
  const errors = compiled.diagnostics.filter(item => item.severity === "error");
  if (errors.length) throw new WorkspaceCollectionError("invalid-collection", "Resolve the collection's source errors before starting a story.");
  const entities = compiled.entities.filter(item => !canOwnTurn(item) || setup.characterIds.includes(item.id));
  const ids = new Set(entities.map(item => item.id));
  const connections = compiled.connections.filter(item => Array.isArray(item.metadata.entities) && item.metadata.entities.every(id => ids.has(id)));
  const files = new Set([world.path, scenario.path, format.path, ...entities.flatMap(item => item.files), ...connections.map(item => item.path)]);
  const selected = {
    ...compiled, models: [], worlds: [world], formats: [format],
    scenarios: [{ ...scenario, metadata: { ...scenario.metadata, doxvelt_setup: JSON.stringify(setup) } }],
    entities, connections,
    taggedLines: compiled.taggedLines.filter(item => files.has(item.sourceSpan.file)),
    mentions: compiled.mentions.filter(item => files.has(item.sourceSpan.file)),
    beliefs: compiled.beliefs.filter(item => ids.has(item.holder) && files.has(item.sourceSpan.file)),
    surfaces: compiled.surfaces.filter(item => ids.has(item.entity) && files.has(item.sourceSpan.file)),
    accessLinks: compiled.accessLinks.filter(item => ids.has(item.member) && ids.has(item.container) && files.has(item.sourceSpan.file)),
  };
  signal?.throwIfAborted();
  const store = await openBranchStore(location.database).open();
  try {
    // Opening storage may wait on another process; check source after that wait.
    if ((await workspaceCollection(directory)).revision !== setup.collectionRevision)
      throw new WorkspaceCollectionError("collection-changed", "The collection changed while preparing the story. Review the setup and try again.", 409);
    signal?.throwIfAborted();
    const started = startBranchSimulationFromCompiled(store, {
      ownerScope: LOCAL_OWNER_SCOPE, simulationId: "story-" + setup.operationId,
      scenarioId: setup.scenarioId, branchId: "main", commandId: "start-" + setup.operationId, compiled: selected,
    });
    return datedStory(store, started.simulation.id, started.branch.id);
  } finally { store.close(); }
}
