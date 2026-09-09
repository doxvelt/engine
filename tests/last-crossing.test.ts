import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileWorkspace } from "../src/core/compiler.ts";
import { initWorkspace } from "../src/core/init.ts";
import { inspectActorContext, LOCAL_OWNER_SCOPE, projectBranch, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { playLastCrossing } from "../src/local-api/example.ts";
import { createLocalApiServer } from "../src/local-api/server.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";

const actors = ["corin", "mara", "nell"];
const workspace = path.resolve("examples/last-crossing");
const entry = "/examples/last-crossing/play";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-crossing-"));
  const dbPath = path.join(root, "runtime.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, dbPath };
}

test("last crossing compiles with three actors, portable prose and source-linked private beliefs", async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, "authored");
  await initWorkspace(target, { template: "last-crossing" });
  const compiled = await compileWorkspace(target);
  assert.deepEqual(compiled.entities.map(actor => actor.id).sort(), actors);
  assert.deepEqual(compiled.diagnostics, []);
  assert.deepEqual(compiled.models, []);
  assert.equal(compiled.scenarios[0]?.name, "The last crossing");
  for (const actor of actors) {
    const beliefs = compiled.beliefs.filter(b => b.holder === actor);
    assert.ok(beliefs.length >= 5);
    for (const belief of beliefs) {
      const source = await readFile(path.join(target, belief.sourceSpan.file), "utf8");
      assert.equal(source.split(/\r?\n/)[belief.sourceSpan.line - 1], belief.sourceSpan.quote);
    }
  }
  assert.doesNotMatch(JSON.stringify(compiled), /\bIvo\b|base_url|api_key|https?:/i);
  await assert.rejects(initWorkspace(target, { template: "last-crossing" }));
});

test("actual assembled contexts omit every other holder's private prose and hidden source lines", async (t) => {
  const { dbPath } = await fixture(t);
  const store = await openBranchStore(dbPath).open();
  t.after(() => store.close());
  const started = await startBranchSimulation(store, { ownerScope: LOCAL_OWNER_SCOPE, simulationId: "scene", workspacePath: workspace, scenarioId: "last-crossing", branchId: "main", commandId: "start" });
  const before = store.exportSimulation(LOCAL_OWNER_SCOPE, "scene");
  for (const actorId of actors) {
    const context = inspectActorContext(store, { ownerScope: LOCAL_OWNER_SCOPE, simulationId: "scene", branchId: "main", actorId, audience: actors });
    const serialized = JSON.stringify(context);
    for (const line of started.compiled.scenarios[0]!.body.split("\n").filter(line => line.includes(":hidden"))) {
      const holder = line.match(/@([a-z-]+)/)?.[1];
      if (holder !== actorId) assert.ok(!serialized.includes(line.replace(/ :canonical :hidden$/, "")), `${actorId} received ${line}`);
      else assert.ok(context.promptPreview.includes(line));
    }
    for (const belief of started.compiled.beliefs) {
      if (belief.holder === actorId) assert.ok(context.promptPreview.includes(belief.propositionText));
      else assert.ok(!serialized.includes(belief.propositionText), `${actorId} received ${belief.holder}'s belief`);
    }
    assert.match(context.promptPreview, /departure lantern/);
    assert.equal(context.subjective.transcript.length, 0);
  }
  assert.deepEqual(store.exportSimulation(LOCAL_OWNER_SCOPE, "scene"), before);
});

async function apiFixture(t: test.TestContext) {
  const { root, dbPath } = await fixture(t);
  const prompts: string[] = [];
  const runtime = new DeterministicFakeRuntime([{ type: "completed", text: "A deterministic test performance.", stopReason: "stop" }], request => prompts.push(request.prompt));
  let server = createLocalApiServer({ dbPath, actorTurnRuntime: runtime });
  let base = "";
  async function listen() {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
  }
  async function close() { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  await listen();
  t.after(close);
  return {
    root, dbPath, prompts,
    async restart() { await close(); server = createLocalApiServer({ dbPath, actorTurnRuntime: runtime }); await listen(); },
    async request(route: string, body?: Record<string, unknown>) {
      return fetch(`${base}${route}`, { ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    },
  };
}

test("Home example entry is safe under concurrent clicks, lost responses, source edits and API restart", async (t) => {
  const f = await apiFixture(t);
  const responses = await Promise.all([f.request(entry, {}), f.request(entry, {})]);
  for (const response of responses) assert.equal(response.status, 200);
  const first = await responses[0]!.json();
  assert.deepEqual(await responses[1]!.json(), first);
  assert.ok(first.workspacePath.startsWith(f.root + path.sep));
  const source = path.join(first.workspacePath, "scenarios/last-crossing.md");
  await writeFile(source, "User's replacement source must survive");
  const route = `/simulations/${first.simulationId}`;
  const stage = await (await f.request(`${route}/stage?branchId=${first.branchId}`)).json();
  assert.equal(stage.transcript.length, 0);
  assert.deepEqual(stage.actors.map((a: { id: string }) => a.id).sort(), actors);
  const turn = await f.request(`${route}/turns`, { commandId: "opening", branchId: first.branchId, expectedHead: stage.branch.headCommitId, actorId: "mara", audience: actors, stageWhisperIds: [], manualText: "The lantern is down. Tell me what cannot wait." });
  assert.equal(turn.status, 200);
  await f.restart();
  assert.deepEqual(await (await f.request(entry, {})).json(), first);
  assert.equal(await readFile(source, "utf8"), "User's replacement source must survive");
  const resumed = await (await f.request(`${route}/stage`)).json();
  assert.equal(resumed.transcript.length, 1);
  assert.equal(resumed.scenarioName, "The last crossing");
  assert.equal((await readdir(f.root)).filter(name => name.startsWith("last-crossing-")).length, 1);
  assert.equal((await f.request(entry, { workspacePath: workspace })).status, 400);
});

test("entry failure retries without replacing a colliding accepted simulation", async (t) => {
  const f = await apiFixture(t);
  // A failed request has no setup effect; an empty retry is supported.
  assert.equal((await f.request(entry, { template: "unknown" })).status, 400);
  const store = await openBranchStore(f.dbPath).open();
  await startBranchSimulation(store, { ownerScope: LOCAL_OWNER_SCOPE, simulationId: "example-last-crossing", workspacePath: path.resolve("examples/executive-interviews"), scenarioId: "executive-interviews", branchId: "main", commandId: "unrelated" });
  const before = store.exportSimulation(LOCAL_OWNER_SCOPE, "example-last-crossing");
  assert.equal((await f.request(entry, {})).status, 409);
  assert.deepEqual(store.exportSimulation(LOCAL_OWNER_SCOPE, "example-last-crossing"), before);
  store.close();
});

test("example drafts stay uncommitted, recover after restart, and restricted perceptions exclude Corin", async (t) => {
  const f = await apiFixture(t);
  const response = await f.request(entry, {});
  assert.equal(response.status, 200);
  const setup = await response.json();
  const route = `/simulations/${setup.simulationId}`;
  const stage = await (await f.request(`${route}/stage`)).json();
  const base = { branchId: setup.branchId, expectedHead: stage.branch.headCommitId };
  const generated = await (await f.request(`${route}/drafts`, { ...base, commandId: "opening-draft", actorId: "mara", audience: actors })).json();
  assert.equal(generated.draft.status, "ready");
  assert.equal((await (await f.request(`${route}/stage`)).json()).transcript.length, 0);
  await f.restart();
  const recovered = await (await f.request(`${route}/drafts?branchId=main`)).json();
  assert.equal(recovered.drafts[0].id, generated.draft.id);
  await f.request(`${route}/drafts/${generated.draft.id}/discard`, { commandId: "discard" });
  const privateText = "Ask which door he was told to use.";
  const privateTurn = await f.request(`${route}/turns`, { ...base, commandId: "private", actorId: "nell", audience: ["mara"], stageWhisperIds: [], manualText: privateText });
  assert.equal(privateTurn.status, 200);
  const head = (await (await f.request(`${route}/stage`)).json()).branch.headCommitId;
  await f.request(`${route}/drafts`, { branchId: "main", expectedHead: head, commandId: "corin-next", actorId: "corin", audience: actors });
  assert.ok(!f.prompts.at(-1)!.includes(privateText));
  const corin = await (await f.request(`${route}/context/corin`)).json();
  const mara = await (await f.request(`${route}/context/mara`)).json();
  assert.ok(!JSON.stringify(corin).includes(privateText));
  assert.ok(mara.promptPreview.includes(privateText));
  const store = await openBranchStore(f.dbPath).open();
  const projection = projectBranch(store, { ownerScope: LOCAL_OWNER_SCOPE, simulationId: setup.simulationId, branchId: "main" });
  assert.deepEqual([...new Set(projection.perceptions.map(p => p.actorId))].sort(), ["mara", "nell"]);
  assert.equal(projection.transcript.length, 1);
  store.close();
});


test("filesystem setup failure is retryable and leaves no simulation or overwritten source", async (t) => {
  const { root, dbPath } = await fixture(t);
  const store = await openBranchStore(dbPath).open();
  t.after(() => store.close());
  const blocker = path.join(root, "not-a-directory");
  await writeFile(blocker, "Keep this existing file");
  await assert.rejects(playLastCrossing(store, blocker));
  assert.equal(store.getSimulation(LOCAL_OWNER_SCOPE, "example-last-crossing"), null);
  assert.equal(await readFile(blocker, "utf8"), "Keep this existing file");
  const entry = await playLastCrossing(store, root);
  assert.equal(entry.simulationId, "example-last-crossing");
  await rm(entry.workspacePath, { recursive: true });
  assert.deepEqual(await playLastCrossing(store, root), entry, "resume uses pinned content even when source is unavailable");
});
