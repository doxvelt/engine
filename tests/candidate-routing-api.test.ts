import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalApiServer } from "../src/local-api/server.ts";
import type { StageDraft } from "../src/local-api/stage-contracts.ts";
import { StageSession } from "../src/local-ui/lib/stage-session.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";

/** Exercise the actual server request listener without binding a network socket. */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-routing-api-"));
  const runtime = new DeterministicFakeRuntime([{ type: "completed", text: JSON.stringify({ text: "For the CFO.", audience: ["ceo", "cfo"] }) }]);
  const dbPath = path.join(root, "runtime.sqlite");
  let server = createLocalApiServer({ dbPath, actorTurnRuntime: runtime });
  t.after(async () => { server.close(); await rm(root, { recursive: true, force: true }); });
  const fetcher: typeof fetch = async (url, options) => {
    const request = new IncomingMessage(new Socket());
    request.url = new URL(String(url), "http://localhost").pathname + new URL(String(url), "http://localhost").search;
    request.method = options?.body ? "POST" : "GET";
    request.headers = { "content-type": "application/json" };
    if (options?.body) request.push(String(options.body));
    request.push(null);
    return new Promise<Response>(resolve => {
      const response = new ServerResponse(request);
      response.end = ((body: string) => {
        resolve(new Response(body, { status: response.statusCode, headers: { "content-type": "application/json" } }));
        return response;
      }) as typeof response.end;
      server.emit("request", request, response);
    });
  };
  const request = (route: string, body?: unknown) => fetcher(`http://localhost${route}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  const started = await request("/simulations/start", { simulationId: "sim", workspacePath: path.resolve("examples/executive-interviews"),
    scenarioId: "executive-interviews", branchId: "main", commandId: "start" });
  assert.equal(started.status, 200);
  const head = (await started.json()).root.id as string;
  return { runtime, request, fetcher, head, restart: () => { server.close(); server = createLocalApiServer({ dbPath, actorTurnRuntime: runtime }); } };
}

test("API accepts no initial audience, exposes minimal review, preserves corrections across restart and replay", async t => {
  const f = await fixture(t);
  const whisper = await (await f.request("/simulations/sim/whispers", { branchId: "main", expectedHead: f.head,
    commandId: "whisper", targetActorId: "ceo", text: "Tell @cfo about @coo." })).json();
  const generated = await f.request("/simulations/sim/drafts", { draftingPolicy: "audience-proposal-v1",
    branchId: "main", expectedHead: f.head, commandId: "generate", actorId: "ceo", audience: null, stageWhisperIds: [whisper.id] });
  assert.equal(generated.status, 200);
  const original = (await generated.json()).draft as StageDraft;
  assert.equal(original.status, "ready");
  assert.deepEqual(original.audience, ["ceo", "cfo"]);
  assert.equal(original.routingReview?.initialAudience, null);
  assert.deepEqual(original.routingReview?.originalWhisper, ["Tell @cfo about @coo."]);
  for (const forbidden of ["context", "prompt", "stageWhispers", "routing"]) assert.equal(forbidden in original, false);
  const body = { commandId: "revise", audience: ["coo"], correction: "No, only COO.", preservedText: "Edited performance.\nExact wording." };
  const changed = await f.request(`/simulations/sim/drafts/${original.id}/revise`, body);
  assert.equal(changed.status, 200);
  const replacement = (await changed.json()).draft as StageDraft;
  assert.equal(replacement.status, "ready");
  assert.equal(replacement.artifact?.text, body.preservedText);
  assert.notEqual(replacement.id, original.id);
  assert.equal(f.runtime.calls, 1);
  f.restart();
  const replay = await (await f.request(`/simulations/sim/drafts/${original.id}/revise`, body)).json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.draft.id, replacement.id);
  const recovered = await (await f.request("/simulations/sim/drafts?branchId=main")).json();
  assert.equal(recovered.drafts.length, 2);
  assert.equal((await f.request(`/simulations/sim/drafts/${replacement.id}/accept`, { commandId: "retag", audience: ["cfo"] })).status, 400);
  assert.equal((await f.request(`/simulations/sim/drafts/${original.id}/revise`, { ...body, actorId: "cfo" })).status, 400);
  assert.equal((await f.request(`/simulations/sim/drafts/${original.id}/revise`, { ...body, preservedText: "collision" })).status, 409);
  const retry = await (await f.request(`/simulations/sim/drafts/${replacement.id}/retry`, { commandId: "retry" })).json();
  assert.equal(retry.draft.status, "ready");
  assert.equal(retry.draft.routingReview.correction, body.correction);
  assert.deepEqual(retry.draft.audience, ["ceo", "coo"]);
  assert.equal(f.runtime.calls, 1);
  assert.equal((await f.request(`/simulations/sim/drafts/${replacement.id}/accept`, { commandId: "accept" })).status, 200);
  assert.equal((await f.request(`/simulations/sim/drafts/${replacement.id}/accept`, { commandId: "accept" })).status, 200);
  assert.equal((await f.request(`/simulations/sim/drafts/${original.id}/accept`, { commandId: "stale" })).status, 409);
  const stage = await (await f.request("/simulations/sim/stage?branchId=main")).json();
  assert.equal(stage.transcript.length, 1);
  assert.deepEqual(stage.transcript[0].audience, ["ceo", "coo"]);
});

test("Stage keeps mode routing and editor wording through a lost correction response and replacement review", async t => {
  const f = await fixture(t);
  let loseCorrection = true;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    const response = await f.fetcher(url, options);
    if (String(url).endsWith("/revise")) {
      calls.push(String(options?.body));
      if (loseCorrection) { loseCorrection = false; throw new Error("Lost response"); }
    }
    return response;
  };
  const session = new StageSession({ apiBase: "http://localhost", simulationId: "sim", branchId: "main" }, fetcher);
  await session.refresh();
  assert.equal(session.audienceMode, "unspecified");
  session.actorId = "ceo";
  session.direction = "Tell @cfo about @coo.";
  session.mode = "perform";
  session.actorId = "cfo";
  session.audienceMode = "selected";
  session.audienceIds = ["coo"];
  session.performance = "Manual buffer";
  session.mode = "direct";
  assert.equal(session.actorId, "ceo");
  assert.equal(session.audienceMode, "unspecified");
  await session.generate();
  assert.equal(session.error, "");
  const original = session.selectedDraftId!;
  session.reviewText = "My unsaved edited performance.";
  session.correctionAudienceIds = ["coo"];
  session.correctionText = "Only COO.";
  await session.revise(true);
  assert.equal(session.needsReconcile, true);
  session.correctionAudienceIds = ["cfo"];
  await session.resume();
  assert.equal(session.needsReconcile, false);
  assert.equal(calls[0], calls[1]);
  assert.notEqual(session.selectedDraftId, original);
  assert.equal(session.reviewText, "My unsaved edited performance.");
  assert.deepEqual(session.selectedDraft?.audience, ["ceo", "coo"]);
  session.selectDraft(original);
  assert.equal(session.reviewText, "My unsaved edited performance.");
  session.mode = "perform";
  assert.equal(session.actorId, "cfo");
  assert.deepEqual(session.audienceIds, ["coo"]);
  assert.equal(session.performance, "Manual buffer");
  assert.equal(f.runtime.calls, 1);
});

test("discard and replay expose only the routed review transport", async t => {
  const f = await fixture(t);
  const result = await (await f.request("/simulations/sim/drafts", {
    draftingPolicy: "audience-proposal-v1", branchId: "main", expectedHead: f.head,
    commandId: "generate-discard", actorId: "ceo", audience: ["cfo"], stageWhisperIds: [],
  })).json();
  for (const replayed of [false, true]) {
    const response = await f.request(`/simulations/sim/drafts/${result.draft.id}/discard`, { commandId: "discard" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.replayed, replayed);
    assert.equal(body.draft.status, "discarded");
    assert.ok(body.draft.routingReview);
    for (const field of ["context", "prompt", "routing", "stageWhispers"])
      assert.equal(field in body.draft, false, field);
  }
});
