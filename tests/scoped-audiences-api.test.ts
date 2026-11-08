import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalApiServer } from "../src/local-api/server.ts";
import { StageSession } from "../src/local-ui/lib/stage-session.ts";
import { validStageBuffer } from "../src/local-ui/lib/stage-buffer.ts";
import { inspectActorContext, projectBranch } from "../src/core/branch-kernel.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import type { BrowserStorage } from "../src/local-ui/lib/stage-recovery.ts";
// @ts-expect-error DSH's host adapter is a JavaScript plugin loaded by the desktop host.
import { savedEpisodeRequest } from "../scripts/dsh-gui-spike/saved-episode.mjs";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-scopes-api-"));
  const dbPath = path.join(root, "source.sqlite");
  let server = createLocalApiServer({ dbPath });
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let drop = false;
  t.after(async () => { server.close(); await rm(root, { recursive: true, force: true }); });
  const fetcher: typeof fetch = async (url, options) => {
    const parsed = new URL(String(url), "http://stage.invalid");
    const request = new IncomingMessage(new Socket());
    request.url = parsed.pathname + parsed.search; request.method = options?.body ? "POST" : "GET";
    request.headers = { "content-type": "application/json" };
    if (options?.body) { request.push(String(options.body)); calls.push({ path: parsed.pathname, body: JSON.parse(String(options.body)) }); }
    request.push(null);
    const result = await new Promise<Response>(resolve => {
      const response = new ServerResponse(request);
      response.end = ((body: string) => { resolve(new Response(body, { status: response.statusCode })); return response; }) as typeof response.end;
      server.emit("request", request, response);
    });
    if (drop && parsed.pathname.endsWith("/turns") && result.ok) { drop = false; throw new Error("Lost accepted response"); }
    return result;
  };
  const request = (suffix: string, body?: unknown) => fetcher(`http://stage.invalid${suffix}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  const start = await request("/simulations/start", { simulationId: "sim", branchId: "main", commandId: "start", workspacePath: path.resolve("examples/last-crossing"), scenarioId: "last-crossing" });
  assert.equal(start.status, 200);
  const scope = { apiBase: "http://stage.invalid", simulationId: "sim", branchId: "main" };
  return { root, dbPath, fetcher, request, calls, scope, drop() { drop = true; }, restart() { server.close(); server = createLocalApiServer({ dbPath }); } };
}

test("Stage requires an explicit default, retains it through overrides, uses span projections and resets on scope change", async t => {
  const f = await fixture(t);
  const session = new StageSession(f.scope, f.fetcher);
  await session.refresh(); session.mode = "perform"; session.actorId = "corin";
  assert.equal(session.audienceMode, "unspecified");
  session.performance = "Unscoped without default";
  await session.perform();
  assert.match(session.error, /audience/);
  assert.equal(f.calls.filter(c => c.path.endsWith("/turns")).length, 0);
  session.audienceMode = "selected"; session.audienceIds = ["mara"];
  session.performance = "@Corin #Nell Before #Mara,Nell(both) after";
  await session.perform();
  assert.equal(session.error, "");
  assert.deepEqual(session.audienceIds, ["mara"]);
  session.performance = "Next turn to default"; await session.perform();
  session.performance = "@Nell #Corin(own primary)"; await session.perform();
  assert.equal(session.actorId, "corin", "turn actor override must not change composer actor");
  assert.deepEqual(session.audienceIds, ["mara"]);
  const store = await openBranchStore(f.dbPath).open();
  try {
    const q = { ownerScope: "local", simulationId: "sim", branchId: "main", audience: [] };
    assert.deepEqual(inspectActorContext(store, { ...q, actorId: "mara" }).subjective.transcript.map(t => t.text), ["both", "Next turn to default"]);
    assert.deepEqual(inspectActorContext(store, { ...q, actorId: "nell" }).subjective.transcript.map(t => t.text), ["Before both after", "own primary"]);
    const turns = projectBranch(store, q).transcript;
    assert.equal(turns.length, 3);
    assert.equal(turns[2]!.actorId, "nell");
    validateSimulationArchive(store.exportSimulation("local", "sim"));
  } finally { store.close(); }
  const otherScope = new StageSession({ ...f.scope, branchId: "other" }, f.fetcher);
  otherScope.mode = "perform";
  assert.equal(otherScope.audienceMode, "unspecified");
  assert.deepEqual(otherScope.audienceIds, []);
});

test("proposed fallback opt-in, malformed input, private thought and exact retry after restart", async t => {
  const f = await fixture(t);
  const session = new StageSession(f.scope, f.fetcher);
  await session.refresh(); session.mode = "perform"; session.actorId = "corin";
  session.audienceMode = "selected"; session.audienceIds = ["mara", "nell"];
  session.performance = "#Mara(secret words|[unintelligible])";
  await session.perform(); assert.match(session.error, /opt-in/);
  session.observerFallbacks = true;
  f.drop(); await session.perform(); assert.match(session.error, /Lost accepted response/);
  const original = structuredClone(f.calls.filter(c => c.path.endsWith("/turns"))[0]!.body);
  session.audienceIds = []; session.observerFallbacks = false; session.performance = "New unsent text";
  f.restart(); await session.resume();
  assert.equal(session.needsReconcile, false, session.error);
  assert.deepEqual(f.calls.filter(c => c.path.endsWith("/turns"))[1]!.body, original);
  assert.equal(session.performance, "New unsent text");
  assert.deepEqual(session.audienceIds, []);
  assert.equal(session.projection!.transcript.length, 1);
  const invalid = await f.request("/simulations/sim/turns", { ...original, commandId: "invalid", manualText: "#Unknown(text)", expectedHead: session.projection!.branch.headCommitId });
  assert.equal(invalid.status, 400);
  const before = session.projection!.branch.headCommitId;
  for (const mutation of [
    { audienceSyntax: "scoped-v9" }, { audienceSyntax: "scoped-v1", manualText: "#Mara(secret|fallback)" },
    { knowledgePolicy: "wrong" }, { audience: null, manualText: "No audience" },
  ]) assert.equal((await f.request("/simulations/sim/turns", { ...original, ...mutation, commandId: crypto.randomUUID(), expectedHead: before })).status, 400);
  session.performance = "#Corin(private thought)"; await session.perform();
  const store = await openBranchStore(f.dbPath).open();
  try {
    const q = { ownerScope: "local", simulationId: "sim", branchId: "main" };
    const context = inspectActorContext(store, { ...q, actorId: "nell", audience: [] });
    assert.deepEqual(context.subjective.transcript.map(t => t.text), ["[unintelligible]"]);
    assert.doesNotMatch(JSON.stringify(context), /secret words|private thought|baseAudience|fallback|projections/);
    assert.equal(projectBranch(store, q).transcript.length, 2);
    validateSimulationArchive(store.exportSimulation("local", "sim"));
  } finally { store.close(); }
});

test("scoped defaults, fallback choice, frozen requests and historical scopes survive browser recovery", async t => {
  const f = await fixture(t);
  const values = new Map<string, string>();
  const storage: BrowserStorage = { get length() { return values.size; }, key(i) { return [...values.keys()][i] ?? null; },
    getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); } };
  const session = new StageSession(f.scope, f.fetcher);
  await session.refresh(); await session.enableRecovery(storage);
  session.mode = "perform"; session.actorId = "corin"; session.audienceMode = "selected"; session.audienceIds = ["mara", "nell"]; session.observerFallbacks = true;
  session.performance = "#Mara(words|[unintelligible])";
  f.drop(); await session.perform(); assert.equal(session.needsReconcile, true);
  session.performance = "Newer #Corin(thought)"; session.autosave();
  assert.equal(validStageBuffer(session.snapshot()), true);
  session.dispose(); f.restart();
  const reopened = new StageSession(f.scope, f.fetcher);
  await reopened.refresh(); await reopened.enableRecovery(storage);
  assert.equal(reopened.recoveryBlocked, false, reopened.recoveryWarning);
  assert.deepEqual(reopened.audienceIds, ["mara", "nell"]);
  assert.equal(reopened.observerFallbacks, true);
  assert.equal(reopened.needsReconcile, true);
  await reopened.resume();
  assert.equal(reopened.projection!.transcript.length, 1);
  assert.equal(reopened.performance, "Newer #Corin(thought)");
  await reopened.history.open(reopened.projection!.transcript[0]!);
  assert.equal(reopened.history.editor!.audienceSyntax, "scoped-fallback-v1");
  reopened.history.editor!.performance = "#Mara(changed words|[unintelligible])";
  reopened.history.touch(); reopened.autosave();
  assert.equal(validStageBuffer(reopened.snapshot()), true);
  await reopened.history.submit();
  assert.equal(reopened.history.error, "");
  assert.ok(reopened.history.target);
});

test("the maintained DSH host commits scoped text through the real API and replays the same occurrence", async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", f.fetcher);
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const session = { get seq() { return events.length; }, append(type: string, data: Record<string, unknown>) { events.push({ type, data }); }, eventAt(index: number) { return events[index]; } };
  const opened = await savedEpisodeRequest("http://stage.invalid", session, { mode: "open-saved", simulationId: "sim" });
  assert.equal(opened.status, 200);
  const status = await (await savedEpisodeRequest("http://stage.invalid", session, { mode: "scene-status" })).json();
  const command = { mode: "perform", character: "Corin", audience: "!unset", audienceSyntax: "scoped-fallback-v1", requestId: crypto.randomUUID(), expectedHead: status.expectedHead,
    body: '#Mara,Nell He whispers: #Mara(secret words|[unintelligible]) and steps back.' };
  assert.equal((await savedEpisodeRequest("http://stage.invalid", session, command)).status, 200);
  f.restart();
  assert.equal((await savedEpisodeRequest("http://stage.invalid", session, command)).status, 200);
  const bad = await savedEpisodeRequest("http://stage.invalid", session, { ...command, requestId: crypto.randomUUID(), body: "#Mara(unclosed" });
  assert.equal(bad.status, 409, "stale preparation cannot mutate the branch");
  const current = await (await savedEpisodeRequest("http://stage.invalid", session, { mode: "scene-status" })).json();
  assert.equal((await savedEpisodeRequest("http://stage.invalid", session, { ...command, expectedHead: current.expectedHead, requestId: crypto.randomUUID(), body: "#Mara(unclosed" })).status, 400);
  assert.equal((await savedEpisodeRequest("http://stage.invalid", session, { ...command, expectedHead: current.expectedHead,
    requestId: crypto.randomUUID(), body: "#[mara] A private bracket-selected line." })).status, 200);
  const store = await openBranchStore(f.dbPath).open();
  try {
    const q = { ownerScope: "local", simulationId: "sim", branchId: "main", audience: [] };
    assert.equal(projectBranch(store, q).transcript.length, 2);
    assert.equal(inspectActorContext(store, { ...q, actorId: "nell" }).subjective.transcript[0]!.text, "He whispers: [unintelligible] and steps back.");
    assert.match(inspectActorContext(store, { ...q, actorId: "mara" }).subjective.transcript[0]!.text, /secret words/);
    validateSimulationArchive(store.exportSimulation("local", "sim"));
  } finally { store.close(); }
});
