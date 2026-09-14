import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initWorkspace } from "../src/core/init.ts";
import { generateActorTurnDraft } from "../src/core/draft-lifecycle.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";
import { compileWorkspace } from "../src/core/compiler.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { createLocalApiServer } from "../src/local-api/server.ts";
import { LOCAL_OWNER_SCOPE, commitManualTurn, projectBranch } from "../src/core/branch-kernel.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "collection-"));
  const dbPath = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(dbPath).open();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const compiled = await compileWorkspace(path.resolve("examples/last-crossing"));
  function start(id: string, ownerScope = LOCAL_OWNER_SCOPE, createdAt?: string, scenarioId: string | null = "last-crossing") {
    const result = store.startSimulation({ ownerScope, simulationId: id, compiled, sourceRoot: "/deleted/source", scenarioId, defaultBranchId: "main", rootCommitId: `root-${ownerScope}-${id}`, commandId: `start-${id}` });
    if (createdAt) {
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE branch_simulations SET created_at = ? WHERE owner_scope = ? AND id = ?").run(createdAt, ownerScope, id); db.close();
    }
    return result;
  }
  return { root, dbPath, store, start };
}

test("collection is minimal, owner scoped and deterministically orders opened runs before creation fallback", async t => {
  const { store, start } = await fixture(t);
  assert.deepEqual(store.listSimulations(LOCAL_OWNER_SCOPE), []);
  start("b", LOCAL_OWNER_SCOPE, "2026-01-01T00:00:00.000Z"); start("a", LOCAL_OWNER_SCOPE, "2026-01-01T00:00:00.000Z"); start("future", LOCAL_OWNER_SCOPE, "2099-01-01T00:00:00.000Z"); start("hidden", "other");
  assert.deepEqual(store.listSimulations(LOCAL_OWNER_SCOPE).map(x => x.simulationId), ["future", "a", "b"]);
  const before = store.exportSimulation(LOCAL_OWNER_SCOPE, "b");
  const opened = store.recordSimulationOpened({ ownerScope: LOCAL_OWNER_SCOPE, simulationId: "b", branchId: "main", operationId: "open-b", expectedVersion: null });
  assert.deepEqual(store.listSimulations(LOCAL_OWNER_SCOPE).map(x => x.simulationId), ["b", "future", "a"]);
  assert.deepEqual(Object.keys(store.listSimulations(LOCAL_OWNER_SCOPE)[0]!).sort(), ["branchId", "createdAt", "openedAt", "scenarioName", "simulationId"]);
  assert.equal(store.listSimulations(LOCAL_OWNER_SCOPE)[0]!.scenarioName, "The last crossing");
  assert.equal(store.listSimulations(LOCAL_OWNER_SCOPE)[1]!.openedAt, null);
  assert.deepEqual(store.exportSimulation(LOCAL_OWNER_SCOPE, "b"), before);
  assert.deepEqual(store.recordSimulationOpened({ ownerScope: LOCAL_OWNER_SCOPE, simulationId: "b", branchId: "main", operationId: "open-b", expectedVersion: null }), opened);
  store.recordSimulationOpened({ ownerScope: LOCAL_OWNER_SCOPE, simulationId: "a", branchId: "main", operationId: "open-a", expectedVersion: opened.version });
  assert.throws(() => store.recordSimulationOpened({ ownerScope: LOCAL_OWNER_SCOPE, simulationId: "b", branchId: "main", operationId: "open-b", expectedVersion: null }), /changed/);
  assert.equal(store.listSimulations(LOCAL_OWNER_SCOPE)[0]!.simulationId, "a");
  commitManualTurn(store, { ownerScope: LOCAL_OWNER_SCOPE, simulationId: "b", branchId: "main", expectedHead: store.getBranch(LOCAL_OWNER_SCOPE, "b", "main")!.headCommitId, commandId: "later-mutation", payload: { actorId: "mara", audience: [], text: "A mutation does not count as opening." } });
  assert.equal(store.listSimulations(LOCAL_OWNER_SCOPE)[0]!.simulationId, "a", "most recently mutated must not displace most recently opened");
  start("unnamed", LOCAL_OWNER_SCOPE, undefined, null);
  assert.equal(store.listSimulations(LOCAL_OWNER_SCOPE).find(x => x.simulationId === "unnamed")!.scenarioName, null);
});

test("navigation validates owner, identity, branch membership and missing targets without writes", async t => {
  const { store, start } = await fixture(t);
  start("a"); start("b", "other");
  const valid = { ownerScope: LOCAL_OWNER_SCOPE, simulationId: "a", branchId: "main", operationId: "open", expectedVersion: null };
  for (const patch of [{ simulationId: "b" }, { ownerScope: "other" }, { branchId: "missing" }, { simulationId: "missing" }, { simulationId: "../a" }, { operationId: "" }, { expectedVersion: 3 }]) {
    assert.throws(() => store.recordSimulationOpened({ ...valid, ...patch } as typeof valid));
  }
  assert.equal(store.getNavigationVersion(LOCAL_OWNER_SCOPE), null);
  assert.equal(store.listSimulations(LOCAL_OWNER_SCOPE)[0]!.openedAt, null);
});

test("additive old database migration and import retain pinned fallback; navigation survives restart but never exports", async t => {
  const { store, start, dbPath, root } = await fixture(t);
  const started = start("legacy");
  store.createBranch({ ownerScope: LOCAL_OWNER_SCOPE, simulationId: "legacy", sourceBranchId: "main", expectedHead: started.root.id, branchId: "alternate", atCommitId: started.root.id, commandId: "fork" });
  const turn = commitManualTurn(store, { ownerScope: LOCAL_OWNER_SCOPE, simulationId: "legacy", branchId: "alternate", expectedHead: started.root.id, commandId: "turn", payload: { actorId: "mara", audience: [], text: "Pinned words." } });
  const before = store.exportSimulation(LOCAL_OWNER_SCOPE, "legacy");
  store.close();
  const old = new DatabaseSync(dbPath);
  old.exec("DROP TABLE application_simulation_navigation; DROP TABLE application_navigation_version;"); old.close();
  await store.open();
  assert.equal(store.listSimulations(LOCAL_OWNER_SCOPE)[0]!.openedAt, null);
  store.recordSimulationOpened({ ownerScope: LOCAL_OWNER_SCOPE, simulationId: "legacy", branchId: "alternate", operationId: "visit", expectedVersion: null });
  store.close(); await store.open();
  const item = store.listSimulations(LOCAL_OWNER_SCOPE)[0]!;
  assert.equal(item.branchId, "alternate");
  assert.equal(projectBranch(store, { ownerScope: LOCAL_OWNER_SCOPE, simulationId: item.simulationId, branchId: item.branchId }).branch.headCommitId, turn.commit.id);
  assert.deepEqual(store.exportSimulation(LOCAL_OWNER_SCOPE, "legacy"), before);
  const imported = await openBranchStore(path.join(root, "imported.sqlite")).open();
  try {
    imported.importSimulation(before);
    assert.equal(imported.listSimulations(LOCAL_OWNER_SCOPE)[0]!.branchId, "main");
    assert.equal(imported.listSimulations(LOCAL_OWNER_SCOPE)[0]!.openedAt, null);
    assert.equal(imported.listSimulations(LOCAL_OWNER_SCOPE)[0]!.scenarioName, "The last crossing");
  } finally { imported.close(); }
});

test("HTTP collection and Stage reads are pure; explicit navigation is validated and server scoped", async t => {
  const { store, start, dbPath } = await fixture(t);
  const server = createLocalApiServer({ dbPath });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const addr = server.address(); assert.ok(addr && typeof addr !== "string");
  const request = (suffix: string, body?: unknown) => fetch(`http://127.0.0.1:${addr.port}${suffix}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  assert.deepEqual(await (await request("/simulations")).json(), { simulations: [] });
  start("a"); start("secret", "other");
  const before = store.exportSimulation(LOCAL_OWNER_SCOPE, "a");
  for (let i = 0; i < 2; i++) {
    assert.equal((await request("/simulations/a/stage?branchId=main")).status, 200);
    assert.deepEqual(await (await request("/simulations/a/navigation?branchId=main")).json(), { version: null });
  }
  assert.equal((await request("/simulations?ownerScope=other")).status, 400);
  assert.equal((await request("/simulations/secret/navigation?branchId=main")).status, 404);
  assert.equal((await request("/simulations/a/navigation?branchId=missing")).status, 404);
  const body = { branchId: "main", operationId: "visit", expectedVersion: null };
  assert.equal((await request("/simulations/a/navigation", { ...body, ownerScope: "other" })).status, 400);
  const receipt = await (await request("/simulations/a/navigation", body)).json();
  assert.ok(receipt.openedAt);
  assert.deepEqual(await (await request("/simulations/a/navigation", body)).json(), receipt);
  assert.equal((await request("/simulations/a/navigation", { ...body, expectedVersion: 5 })).status, 400);
  assert.equal((await request("/simulations/a/navigation", { ...body, branchId: "../main" })).status, 404);
  assert.deepEqual(store.exportSimulation(LOCAL_OWNER_SCOPE, "a"), before);
  const response = await (await request("/simulations")).json();
  assert.equal(response.simulations.length, 1);
  assert.ok(response.simulations[0].openedAt);
});


test("source edits/deletion and repeated navigation preserve pinned content and actual saved drafts", async t => {
  const { root, store } = await fixture(t);
  const source = path.join(root, 'authored');
  await initWorkspace(source, { template: 'last-crossing' });
  const compiled = await compileWorkspace(source);
  const started = store.startSimulation({ ownerScope: LOCAL_OWNER_SCOPE, simulationId: 'saved', compiled, sourceRoot: source, scenarioId: 'last-crossing', defaultBranchId: 'main', rootCommitId: 'saved-root', commandId: 'start-saved' });
  await generateActorTurnDraft(store, new DeterministicFakeRuntime([{ type: 'completed', text: 'Unaccepted performance.', stopReason: 'stop' }]), {
    ownerScope: LOCAL_OWNER_SCOPE, simulationId: 'saved', branchId: 'main', expectedHead: started.root.id, commandId: 'draft',
    payload: { actorId: 'mara', audience: ['nell'], stageWhisperIds: [], runtimeProfile: { id: 'test', version: 'v1' }, promptPolicy: { id: 'test', version: 'v1' }, outputSchema: { id: 'text', digest: 'v1' }, skillDigests: [] },
  });
  const before = store.exportSimulation(LOCAL_OWNER_SCOPE, 'saved');
  const drafts = store.listRecoverableActorTurnDrafts(LOCAL_OWNER_SCOPE, 'saved', 'main');
  assert.equal(drafts.length, 1);
  await writeFile(path.join(source, 'scenarios/last-crossing.md'), 'Changed source, no longer the pinned title.');
  assert.equal(store.listSimulations(LOCAL_OWNER_SCOPE)[0]!.scenarioName, 'The last crossing');
  await rm(source, { recursive: true });
  let expectedVersion: string | null = null;
  for (let i = 0; i < 3; i++) {
    const item = store.listSimulations(LOCAL_OWNER_SCOPE)[0]!;
    const projection = projectBranch(store, { ownerScope: LOCAL_OWNER_SCOPE, simulationId: item.simulationId, branchId: item.branchId });
    assert.equal(projection.branch.headCommitId, started.root.id);
    expectedVersion = store.recordSimulationOpened({ ownerScope: LOCAL_OWNER_SCOPE, simulationId: item.simulationId, branchId: item.branchId, operationId: `entry-${i}`, expectedVersion }).version;
    assert.deepEqual(store.exportSimulation(LOCAL_OWNER_SCOPE, 'saved'), before);
    assert.deepEqual(store.listRecoverableActorTurnDrafts(LOCAL_OWNER_SCOPE, 'saved', 'main'), drafts);
  }
});

test("missing saved branch remains the resume target and cannot fall back to main", async t => {
  const { store, start, dbPath } = await fixture(t);
  const a = start('a'); const b = start('b');
  store.createBranch({ ownerScope: LOCAL_OWNER_SCOPE, simulationId: 'b', sourceBranchId: 'main', expectedHead: b.root.id, branchId: 'belongs-to-b', atCommitId: b.root.id, commandId: 'fork-b' });
  assert.throws(() => store.recordSimulationOpened({ ownerScope: LOCAL_OWNER_SCOPE, simulationId: 'a', branchId: 'belongs-to-b', operationId: 'wrong', expectedVersion: null }), /not found/);
  store.createBranch({ ownerScope: LOCAL_OWNER_SCOPE, simulationId: 'a', sourceBranchId: 'main', expectedHead: a.root.id, branchId: 'alternate', atCommitId: a.root.id, commandId: 'fork-a' });
  store.recordSimulationOpened({ ownerScope: LOCAL_OWNER_SCOPE, simulationId: 'a', branchId: 'alternate', operationId: 'right', expectedVersion: null });
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM branches WHERE simulation_id = ? AND id = ?").run('a', 'alternate'); db.close();
  const item = store.listSimulations(LOCAL_OWNER_SCOPE)[0]!;
  assert.equal(item.branchId, 'alternate');
  assert.throws(() => projectBranch(store, { ownerScope: LOCAL_OWNER_SCOPE, simulationId: item.simulationId, branchId: item.branchId }), /not found/);
  assert.ok(store.getBranch(LOCAL_OWNER_SCOPE, 'a', 'main'));
});


test("saved identities round-trip through Stage and navigation without normalization or new format limits", async t => {
  const { store, dbPath } = await fixture(t);
  const server = createLocalApiServer({ dbPath });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const addr = server.address(); assert.ok(addr && typeof addr !== "string");
  const request = (suffix: string, body?: unknown) => fetch(`http://127.0.0.1:${addr.port}${suffix}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const identities = [
    ["my sim", "my branch"],
    [" 世界 é ", " 分岐/é "],
    ["legacy-" + "s".repeat(240), "legacy/" + "b".repeat(240)],
  ];
  let expectedVersion: string | null = null;
  for (const [index, ids] of identities.entries()) {
    const [simulationId, branchId] = ids as [string, string];
    assert.equal((await request("/simulations/start", { simulationId, branchId, commandId: `start-${index}`,
      workspacePath: path.resolve("examples/last-crossing"), scenarioId: "last-crossing" })).status, 200);
    const before = store.exportSimulation(LOCAL_OWNER_SCOPE, simulationId);
    const route = `/simulations/${encodeURIComponent(simulationId)}`;
    const query = `?branchId=${encodeURIComponent(branchId)}`;
    const stage = await request(`${route}/stage${query}`);
    assert.equal(stage.status, 200);
    assert.equal((await stage.json()).branch.id, branchId);
    assert.equal((await request(`${route}/actors`)).status, 200);
    assert.deepEqual(await (await request(`${route}/navigation${query}`)).json(), { version: expectedVersion });
    const opened = await request(`${route}/navigation`, { branchId, operationId: `visit-${index}`, expectedVersion });
    assert.equal(opened.status, 200);
    expectedVersion = (await opened.json()).version;
    const list = await (await request("/simulations")).json();
    assert.equal(list.simulations[0].simulationId, simulationId);
    assert.equal(list.simulations[0].branchId, branchId);
    for (const invalid of [undefined, null, 5, "", {}, [branchId]]) {
      assert.equal((await request(`${route}/navigation`, { branchId: invalid, operationId: "invalid", expectedVersion })).status, 400);
    }
    assert.equal((await request(`${route}/navigation`)).status, 400);
    assert.equal((await request(`${route}/navigation?branchId=missing%2Fbranch`)).status, 404);
    for (const token of ["", "with space", "with/slash", "x".repeat(201)]) {
      assert.equal((await request(`${route}/navigation`, { branchId, operationId: token, expectedVersion })).status, 400);
      assert.equal((await request(`${route}/navigation`, { branchId, operationId: "valid", expectedVersion: token })).status, 400);
    }
    assert.equal(store.getNavigationVersion(LOCAL_OWNER_SCOPE), expectedVersion);
    assert.deepEqual(store.exportSimulation(LOCAL_OWNER_SCOPE, simulationId), before);
  }
});

test("imported saved identities and owner scopes retain exact membership", async t => {
  const { store, start, root } = await fixture(t);
  const ownerScope = " owner/世界 " + "o".repeat(210);
  const simulationId = " saved/世界 " + "s".repeat(210);
  start(simulationId, ownerScope);
  const archive = store.exportSimulation(ownerScope, simulationId);
  const imported = await openBranchStore(path.join(root, "identities.sqlite")).open();
  try {
    imported.importSimulation(archive);
    assert.equal(imported.listSimulations(ownerScope)[0]!.simulationId, simulationId);
    assert.deepEqual(imported.listSimulations(LOCAL_OWNER_SCOPE), []);
    assert.throws(() => imported.recordSimulationOpened({ ownerScope: LOCAL_OWNER_SCOPE, simulationId, branchId: "main", operationId: "wrong-owner", expectedVersion: null }), /not found/);
    imported.recordSimulationOpened({ ownerScope, simulationId, branchId: "main", operationId: "imported", expectedVersion: null });
    assert.equal(imported.getNavigationVersion(ownerScope), "imported");
    assert.equal(imported.getNavigationVersion(LOCAL_OWNER_SCOPE), null);
    assert.deepEqual(imported.exportSimulation(ownerScope, simulationId), archive);
  } finally { imported.close(); }
});
