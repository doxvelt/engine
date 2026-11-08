import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  activateWorkspace, createCollectionObject, readWorkspaceConfiguration, saveCollectionSource,
  startCollectionStory, workspaceCollection, workspaceLocation, type StorySetup,
} from "../src/local-api/workspace-collection.ts";
import { EpisodeMemory } from "../src/memory/episodes.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { commitManualTurn, inspectActorContext, projectBranch } from "../src/core/branch-kernel.ts";
import { forkBranch } from "../src/core/branch-kernel.ts";
import { SceneHeadingStore } from "../src/store/scene-headings.ts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-collection-"));
  await activateWorkspace(root);
  for (const [kind, id, body] of [
    ["world", "river", "The river runs through a quiet valley."],
    ["world", "other", "Unselected world should stay out of the story."],
    ["scenario", "crossing", "The ferry must leave before the storm."],
    ["format", "script", "Write a short performance."],
    ["character", "corin", "@corin is a ferryman. :+3"],
    ["character", "nell", "@nell wants to cross. :+3"],
    ["character", "mara", "@mara keeps her own secrets. :+3"],
  ] as const) await createCollectionObject(root, { kind, id, name: id, body });
  const memory = new EpisodeMemory({ directory: path.join(root, ".doxvelt/memory"), executable: "", modelKey: "fixture",
    reflect: async () => { throw new Error("Manual setup must not call a model"); } });
  const setup: StorySetup = { operationId: "first", collectionRevision: (await workspaceCollection(root)).revision,
    worldId: "river", scenarioId: "crossing", formatId: "script", characterIds: ["corin", "nell"], date: "2000-03-01" };
  return { root, memory, setup };
}

test("workspace activation is explicit, idempotent and cancelled before mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-activation-"));
  const existing = path.join(root, "notes.md");
  await writeFile(existing, "Keep my notes");
  assert.equal(await readWorkspaceConfiguration(root), null);
  await assert.rejects(activateWorkspace(root, AbortSignal.abort()));
  assert.equal(await readWorkspaceConfiguration(root), null);
  assert.deepEqual(await activateWorkspace(root), { version: 1 });
  assert.deepEqual(await activateWorkspace(root), { version: 1 });
  assert.equal(await readFile(existing, "utf8"), "Keep my notes");
  const another = await mkdtemp(path.join(os.tmpdir(), "doxvelt-inactive-"));
  assert.equal(await readWorkspaceConfiguration(another), null);
});

test("collection objects are ordinary workspace files and stale edits cannot overwrite them", async () => {
  const f = await fixture();
  try {
    const collection = await workspaceCollection(f.root);
    assert.equal(collection.characters.length, 3);
    const file = collection.files.find(file => file.path === "worlds/river.md")!;
    const original = await readFile(path.join(f.root, file.path), "utf8");
    await assert.rejects(createCollectionObject(f.root, { kind: "world", id: "river", name: "Replace", body: "Bad replacement" }), /changed/);
    assert.equal(await readFile(path.join(f.root, file.path), "utf8"), original);
    await assert.rejects(saveCollectionSource(f.root, { path: file.path, text: "Cancelled", expectedRevision: file.revision }, AbortSignal.abort()));
    const edited = await saveCollectionSource(f.root, { path: file.path, text: original + "\nThe river is wide.", expectedRevision: file.revision });
    assert.notEqual(edited.revision, file.revision);
    await assert.rejects(saveCollectionSource(f.root, { path: file.path, text: "Old view", expectedRevision: file.revision }), /changed/);
    await assert.rejects(saveCollectionSource(f.root, { path: "worlds/../../outside.md", text: "escape", expectedRevision: null }), /inside/);
  } finally { f.memory.close(); }
});

test("new stories pin selected collection objects, date the episode, safely retry and isolate playthroughs", async () => {
  const f = await fixture();
  try {
    const first = await startCollectionStory(f.root, f.setup, f.memory);
    assert.equal(first.status, "complete");
    assert.deepEqual(await startCollectionStory(f.root, f.setup, f.memory), first);
    const location = await workspaceLocation(f.root);
    const store = await openBranchStore(location.database).open();
    try {
      assert.equal(store.listSimulations("local").length, 1);
      const q = { ownerScope: "local", simulationId: first.simulationId, branchId: first.branchId };
      const archive = store.exportSimulation("local", first.simulationId);
      validateSimulationArchive(archive);
      assert.deepEqual(archive.contentRevision.compiled.worlds.map(item => item.id), ["river"]);
      assert.deepEqual(archive.contentRevision.compiled.entities.map(item => item.id), ["corin", "nell"]);
      assert.doesNotMatch(JSON.stringify(archive.contentRevision.compiled.taggedLines), /mara keeps her own secrets/);
      assert.equal(f.memory.inspect(store, q)[0]!.date, f.setup.date);
      const head = projectBranch(store, q).branch.headCommitId;
      commitManualTurn(store, { ...q, commandId: "private", expectedHead: head,
        payload: { actorId: "corin", text: "The key is hidden.", audience: ["nell"], stageWhisperIds: [], knowledgePolicy: "actor-knowledge-v1" } });
      const second = await startCollectionStory(f.root, { ...f.setup, operationId: "second" }, f.memory);
      const context = inspectActorContext(store, { ...q, simulationId: second.simulationId, actorId: "nell" });
      assert.doesNotMatch(context.promptPreview, /The key is hidden/);
      const file = (await workspaceCollection(f.root)).files.find(file => file.path === "worlds/river.md")!;
      await saveCollectionSource(f.root, { path: file.path, text: "A changed world.", expectedRevision: file.revision });
      assert.equal(store.exportSimulation("local", first.simulationId).contentRevision.compiled.worlds[0]!.body, archive.contentRevision.compiled.worlds[0]!.body);
      f.memory.setDate(store, q, "first", "2000-03-02");
      assert.deepEqual(await startCollectionStory(f.root, f.setup, f.memory), first, "A lost-response retry uses its saved setup after source changes");
      assert.equal(f.memory.inspect(store, q)[0]!.date, "2000-03-02", "Creation replay preserves a later date correction");
      await assert.rejects(startCollectionStory(f.root, { ...f.setup, date: "2000-03-03" }, f.memory), /already belongs/);
    } finally { store.close(); }
  } finally { f.memory.close(); }
});

test("stale collection, missing choices and cancellation leave no story; date failure reports the saved story", async () => {
  const f = await fixture();
  try {
    await assert.rejects(startCollectionStory(f.root, { ...f.setup, collectionRevision: "old" }, f.memory), /collection changed/);
    await assert.rejects(startCollectionStory(f.root, { ...f.setup, characterIds: [] }, f.memory), /at least one/);
    await assert.rejects(startCollectionStory(f.root, f.setup, f.memory, AbortSignal.abort()));
    const store = await openBranchStore((await workspaceLocation(f.root)).database).open();
    assert.equal(store.listSimulations("local").length, 0);
    store.close();
    const previous = f.memory.setDate;
    f.memory.setDate = () => { throw new Error("Storage unavailable"); };
    const partial = await startCollectionStory(f.root, f.setup, f.memory);
    assert.equal(partial.status, "partial");
    assert.equal(partial.simulationId, "story-first");
    f.memory.setDate = previous;
    assert.equal((await startCollectionStory(f.root, f.setup, f.memory)).status, "complete");
    const unsafe = path.join(await mkdtemp(path.join(os.tmpdir(), "doxvelt-unsafe-")), "workspace");
    await mkdir(unsafe);
    await writeFile(path.join(unsafe, ".doxvelt"), "not a directory");
    await assert.rejects(activateWorkspace(unsafe), /local directory/);
  } finally { f.memory.close(); }
});

test("scene headings organize a story path without changing canonical history, actor knowledge or memory source", async () => {
  const f = await fixture();
  const location = await workspaceLocation(f.root);
  const filename = path.join(location.data, "scene-headings.sqlite");
  let headings = new SceneHeadingStore(filename);
  try {
    const first = await startCollectionStory(f.root, f.setup, f.memory);
    const q = { ownerScope: "local", simulationId: first.simulationId, branchId: first.branchId };
    const store = await openBranchStore(location.database).open();
    try {
      const head = projectBranch(store, q).branch.headCommitId;
      const context = inspectActorContext(store, { ...q, actorId: "nell" });
      const archive = store.exportSimulation("local", first.simulationId);
      const memory = f.memory.inspect(store, q);
      const command = { ...q, expectedHead: head, commandId: "scene-one" };
      const heading = headings.create(store, command, "Ferry landing — dusk");
      assert.equal(headings.list(store, q)[0]!.title, heading.title);
      assert.deepEqual(inspectActorContext(store, { ...q, actorId: "nell" }), context);
      assert.deepEqual(store.exportSimulation("local", first.simulationId), archive);
      assert.deepEqual(f.memory.inspect(store, q), memory);
      commitManualTurn(store, { ...q, commandId: "turn", expectedHead: head,
        payload: { actorId: "corin", text: "The ferry is ready.", audience: ["nell"], stageWhisperIds: [], knowledgePolicy: "actor-knowledge-v1" } });
      assert.deepEqual(headings.create(store, command, "Ferry landing — dusk"), heading);
      assert.equal(headings.list(store, q).length, 1);
      assert.throws(() => headings.create(store, command, "Different heading"), /already used/);
      assert.throws(() => headings.create(store, { ...command, commandId: "stale" }, "Old view"), /head/i);
      const fork = forkBranch(store, { ...q, sourceBranchId: q.branchId, expectedHead: projectBranch(store, q).branch.headCommitId,
        commandId: "fork", branchId: "other-path", name: "Other path", atCommitId: head });
      const alternate = { ...q, branchId: fork.branch.id };
      headings.create(store, { ...alternate, expectedHead: head, commandId: "alternate-scene" }, "An alternate opening");
      assert.equal(headings.list(store, q).length, 1);
      assert.equal(headings.list(store, alternate).length, 2);
      headings.close();
      headings = new SceneHeadingStore(filename);
      assert.equal(headings.list(store, alternate).length, 2);
    } finally { store.close(); }
  } finally { headings.close(); f.memory.close(); }
});
