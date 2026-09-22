import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { compileWorkspace } from "../src/core/compiler.ts";
import { commitManualTurn, commitRuntimeEffects, projectBranch, startBranchSimulationFromCompiled } from "../src/core/branch-kernel.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { deriveFirstImpressionEvents, fingerprintCommand } from "../src/core/domain-rules.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { createLocalApiServer } from "../src/local-api/server.ts";
import { ACTOR_KNOWLEDGE_POLICY } from "../src/local-api/stage-contracts.ts";
import { StageSession } from "../src/local-ui/lib/stage-session.ts";
import type { RunActorTurnRequest } from "../src/agent-runtime/contracts.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";

const marker = "UNOBSERVED-CFO-SURFACE";
/** Real loopback HTTP, actual StageSession, disposable SQLite, no model calls. */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-stage-knowledge-"));
  const dbPath = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(dbPath).open();
  const compiled = await compileWorkspace(path.resolve("examples/executive-interviews"));
  compiled.beliefs = []; compiled.accessLinks = [];
  for (const asset of [...compiled.worlds, ...compiled.scenarios]) asset.body = "An ordinary conversation.";
  compiled.surfaces = [{ ...compiled.surfaces[0]!, entity: "cfo", text: marker }];
  const query = { ownerScope: "local", simulationId: "sim", branchId: "main" };
  const started = startBranchSimulationFromCompiled(store, { ...query, commandId: "start", scenarioId: "executive-interviews", compiled });
  const presence = commitRuntimeEffects(store, { ...query, expectedHead: started.root.id, commandId: "presence",
    payload: { audienceChanges: [{ actorId: "ceo", action: "add" }, { actorId: "cfo", action: "add" }] } });
  const captures: RunActorTurnRequest[] = [];
  const runtime = new DeterministicFakeRuntime([{ type: "completed", text: JSON.stringify({ text: "A reply without appearance information.", audience: ["ceo", "cfo"] }) }], request => captures.push(structuredClone(request)));
  const server = createLocalApiServer({ dbPath, actorTurnRuntime: runtime });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true }); });
  const calls: Array<{ route: string; body: Record<string, any> }> = [];
  const fetcher: typeof fetch = (input, init) => {
    if (init?.body) calls.push({ route: String(input), body: JSON.parse(String(init.body)) });
    return fetch(input, init);
  };
  const session = new StageSession({ apiBase: url, simulationId: "sim", branchId: "main" }, fetcher);
  await session.refresh();
  async function post(route: string, body: unknown, expected = 200) {
    const response = await fetch(`${url}/simulations/sim${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  }
  return { root, dbPath, store, query, head: presence.commit.id, captures, runtime, session, post, calls };
}

test("Stage Perform uses explicit knowledge policy across real HTTP, replay, next generation and archive import", async t => {
  const f = await fixture(t);
  f.session.actorId = "ceo"; f.session.audienceMode = "selected"; f.session.audienceIds = ["cfo"];
  await f.session.generate(); await f.session.discard();
  f.session.mode = "perform"; f.session.actorId = "ceo"; f.session.audienceMode = "selected"; f.session.audienceIds = ["cfo"];
  f.session.performance = "MANUAL-RECEIVED-SPEECH, without any observation.";
  await f.session.perform(); assert.equal(f.session.error, "");
  const body = f.calls.find(call => call.route.endsWith("/turns"))!.body;
  assert.equal(body.knowledgePolicy, ACTOR_KNOWLEDGE_POLICY);
  const projection = projectBranch(f.store, f.query);
  assert.deepEqual(projection.firstImpressions, []);
  assert.deepEqual(projection.perceptions.map(item => item.actorId), ["ceo", "cfo"]);
  const replay = await f.post("/turns", body); assert.equal(replay.replayed, true);
  assert.equal("context" in replay, false);
  await f.post("/turns", { ...body, knowledgePolicy: "forged" }, 400);
  const legacyBody = { ...body }; delete legacyBody.knowledgePolicy;
  await f.post("/turns", legacyBody, 409);
  f.session.mode = "direct"; f.session.actorId = "ceo"; f.session.audienceMode = "selected"; f.session.audienceIds = ["cfo"];
  await f.session.generate(); assert.equal(f.session.error, "");
  assert.match(f.captures.at(-1)!.prompt, /MANUAL-RECEIVED-SPEECH/);
  for (const request of f.captures) assert.equal(JSON.stringify(request).includes(marker), false);
  const archive = f.store.exportSimulation("local", "sim"); validateSimulationArchive(archive);
  const command = archive.commandResults.find(item => item.commandId === body.commandId)!.canonicalInput;
  assert.equal(command.kind, "turn"); if (command.kind !== "turn") throw new Error("Wrong command");
  assert.equal(command.payload.knowledgePolicy, ACTOR_KNOWLEDGE_POLICY);
  const imported = await openBranchStore(path.join(f.root, "import.sqlite")).open();
  try { imported.importSimulation(archive); assert.equal(commitManualTurn(imported, command).replayed, true); }
  finally { imported.close(); }
  for (const mutate of [
    (copy: typeof archive) => {
      const turn = copy.commandResults.find(item => item.commandId === body.commandId)!;
      if (turn.canonicalInput.kind !== "turn") throw new Error("Wrong command");
      delete turn.canonicalInput.payload.knowledgePolicy;
      turn.fingerprint = fingerprintCommand(turn.canonicalInput);
    },
    (copy: typeof archive) => {
      const commit = copy.commits.find(item => item.commandId === body.commandId)!;
      commit.events.push(...deriveFirstImpressionEvents({ audience: ["ceo", "cfo"], surfaces: copy.contentRevision.compiled.surfaces, existing: [] }));
    },
  ]) { const forged = structuredClone(archive); mutate(forged); assert.throws(() => validateSimulationArchive(forged)); }
});

test("manual requests without opt-in retain impressions and exact command replay/import", async t => {
  const f = await fixture(t);
  const body = { branchId: "main", expectedHead: f.head, commandId: "legacy-manual", actorId: "ceo", audience: ["cfo"], stageWhisperIds: [], manualText: "Legacy speech." };
  await f.post("/turns", body);
  assert.ok(projectBranch(f.store, f.query).firstImpressions.some(item => item.entityId === "cfo"));
  assert.equal((await f.post("/turns", body)).replayed, true);
  const archive = f.store.exportSimulation("local", "sim"); validateSimulationArchive(archive);
  const command = archive.commandResults.find(item => item.commandId === body.commandId)!.canonicalInput;
  if (command.kind !== "turn") throw new Error("Wrong command");
  assert.equal(Object.hasOwn(command.payload, "knowledgePolicy"), false);
  // Captured with recordCommand at base 05171e243b8033c6dac29ee31c9a5a5b5f1098aa.
  assert.equal(fingerprintCommand(command), "e29a7930c63db154da4e2d057986abc81596768a1ce5e9eb57adc0bc6be1ebee");
  const imported = await openBranchStore(path.join(f.root, "legacy-import.sqlite")).open();
  try { imported.importSimulation(archive); assert.equal(commitManualTurn(imported, command).replayed, true); }
  finally { imported.close(); }
});

for (const version of [1, 2]) {
  for (const preserve of [false, true]) {
    test(`Stage replacement of legacy v${version} explicitly adopts current policy, preserve=${preserve}`, async t => {
      const f = await fixture(t);
      let source = (await f.post("/drafts", { branchId: "main", expectedHead: f.head, commandId: "legacy", actorId: "ceo", audience: ["cfo"], stageWhisperIds: [], draftingPolicy: "audience-proposal-v1" })).draft;
      if (version === 2) source = (await f.post(`/drafts/${source.id}/revise`, { commandId: "legacy-v2", completeWhisper: "Old complete input.", audience: ["cfo"] })).draft;
      const original = f.store.getActorTurnDraft("local", "sim", source.id)!;
      assert.equal(original.routing!.version, version); assert.ok(original.prompt.includes(marker));
      const retry = (await f.post(`/drafts/${source.id}/retry`, { commandId: "exact-old-retry" })).draft;
      const retried = f.store.getActorTurnDraft("local", "sim", retry.id)!;
      assert.equal(retried.promptHash, original.promptHash); assert.equal(retried.contextHash, original.contextHash);
      assert.equal(retried.routing!.version, version);
      await f.session.refresh(); f.session.selectDraft(source.id);
      if (!preserve) f.session.correctionText = "New complete input, not an observation.";
      const beforeCalls = f.runtime.calls;
      await f.session.revise(preserve); assert.equal(f.session.error, "");
      const selected = f.session.selectedDraft!; assert.notEqual(selected.id, source.id); assert.equal(selected.status, "ready");
      assert.equal(f.runtime.calls, beforeCalls + (preserve ? 0 : 1));
      const replacement = f.store.getActorTurnDraft("local", "sim", selected.id)!;
      assert.equal(replacement.routing!.version, 3); assert.equal(replacement.promptPolicy.id, ACTOR_KNOWLEDGE_POLICY);
      assert.equal(JSON.stringify(replacement.context).includes(marker), false); assert.equal(replacement.prompt.includes(marker), false);
      assert.deepEqual(f.store.getActorTurnDraft("local", "sim", source.id), original);
      assert.equal(replacement.routing!.source!.promptHash, original.promptHash);
      assert.deepEqual(replacement.routing!.source!.artifact, original.artifact);
      assert.equal(replacement.artifact!.provenance.adapter.id, preserve ? "director-preserved" : "deterministic-fake");
      const submitted = f.calls.find(call => call.route.endsWith("/revise"))!.body;
      assert.equal(submitted.draftingPolicy, ACTOR_KNOWLEDGE_POLICY);
      assert.equal((await f.post(`/drafts/${source.id}/revise`, submitted)).replayed, true);
      const withoutOptIn = { ...submitted }; delete withoutOptIn.draftingPolicy;
      await f.post(`/drafts/${source.id}/revise`, withoutOptIn, 409);
      await f.post(`/drafts/${source.id}/revise`, { ...submitted, commandId: "forged", draftingPolicy: "forged" }, 400);
      await f.post(`/drafts/${source.id}/revise`, { commandId: "additive", draftingPolicy: ACTOR_KNOWLEDGE_POLICY, correction: "More", audience: ["cfo"] }, 400);
      await f.post(`/drafts/${source.id}/revise`, { ...submitted, commandId: "false-preserve", completeWhisper: "Changed input", preservedText: "Unchanged wording" }, 400);
      await f.post(`/drafts/${selected.id}/accept`, { commandId: "accept-new" });
      const archive = f.store.exportSimulation("local", "sim"); validateSimulationArchive(archive);
      assert.deepEqual(projectBranch(f.store, f.query).firstImpressions, []);
      const imported = await openBranchStore(path.join(f.root, "replacement-import.sqlite")).open();
      try {
        imported.importSimulation(archive);
        const { acceptActorTurnDraft } = await import("../src/core/draft-lifecycle.ts");
        assert.equal(acceptActorTurnDraft(imported, { ...f.query, draftId: selected.id, commandId: "accept-new" }).replayed, true);
      } finally { imported.close(); }
    });
  }
}

test("accepting a saved legacy candidate remains frozen after generating a new-policy replacement", async t => {
  const f = await fixture(t);
  const original = (await f.post("/drafts", { branchId: "main", expectedHead: f.head, commandId: "old", actorId: "ceo", audience: ["cfo"], stageWhisperIds: [], draftingPolicy: "audience-proposal-v1" })).draft;
  await f.post(`/drafts/${original.id}/revise`, { commandId: "new", draftingPolicy: ACTOR_KNOWLEDGE_POLICY, completeWhisper: "Edited whisper", audience: ["cfo"] });
  await f.post(`/drafts/${original.id}/accept`, { commandId: "accept-old" });
  assert.ok(projectBranch(f.store, f.query).firstImpressions.some(item => item.entityId === "cfo"));
  assert.equal((await f.post(`/drafts/${original.id}/accept`, { commandId: "accept-old" })).replayed, true);
  validateSimulationArchive(f.store.exportSimulation("local", "sim"));
});
