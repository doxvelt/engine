import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiActorTurnRuntime } from "../src/agent-runtime/pi.ts";
import { createLocalOpenAICompatibleRuntime, safeRuntimeDiagnostic } from "../src/agent-runtime/local-openai-compatible.ts";
import type { AgentRuntimeEvent, RunActorTurnRequest } from "../src/agent-runtime/contracts.ts";
import { createLocalApiServer } from "../src/local-api/server.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

// Real Pi adapter + actual request listener, without network listen permissions.
test("provider auth detail cannot escape status, API replies, durable failure or portable archive", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-inference-failure-"));
  const dbPath = path.join(root, "runtime.sqlite");
  const secret = "TEST_SECRET_SENTINEL";
  const faux = fauxProvider({ provider: "fixture-provider", models: [{ id: "fixture-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: `401 Unauthorized ${secret}` })]);
  let diagnostic: string | null = null;
  const runtime = new PiActorTurnRuntime(models, faux.getModel(), { onFailure: detail => { diagnostic = safeRuntimeDiagnostic(detail); } });
  const server = createLocalApiServer({ dbPath, actorTurnRuntime: runtime, runtimeDiagnostic: () => diagnostic });
  t.after(async () => { server.close(); await rm(root, { recursive: true, force: true }); });
  const request = async (route: string, body?: unknown) => {
    const incoming = new IncomingMessage(new Socket());
    incoming.url = route;
    incoming.method = body ? "POST" : "GET";
    incoming.headers = { "content-type": "application/json" };
    if (body) incoming.push(JSON.stringify(body));
    incoming.push(null);
    return new Promise<any>(resolve => {
      const response = new ServerResponse(incoming);
      response.end = ((payload: string) => {
        assert.equal(response.statusCode, 200);
        assert.ok(!payload.includes(secret));
        resolve(JSON.parse(payload));
        return response;
      }) as typeof response.end;
      server.emit("request", incoming, response);
    });
  };
  const status = await request("/runtime");
  assert.equal(status.configured, true);
  assert.equal(status.diagnostic, null);
  const started = await request("/simulations/start", { simulationId: "sim", workspacePath: path.resolve("examples/executive-interviews"), scenarioId: "executive-interviews", branchId: "main", commandId: "start" });
  const result = await request("/simulations/sim/drafts", { branchId: "main", expectedHead: started.root.id, commandId: "generation", actorId: "ceo", audience: ["cfo"], draftingPolicy: "actor-knowledge-v1", completeWhisper: "Speak briefly." });
  assert.equal(result.draft.status, "failed");
  assert.match((await request("/runtime")).diagnostic, /authentication failed/);
  const store = await openBranchStore(dbPath).open();
  try {
    assert.equal(store.getBranch("local", "sim", "main")!.headCommitId, started.root.id);
    const failed = store.getActorTurnDraft("local", "sim", result.draft.id)!;
    assert.ok(!JSON.stringify(failed).includes(secret));
    assert.equal(failed.failure?.message, "Runtime generation failed.");
    const archive = JSON.stringify(store.exportSimulation("local", "sim"));
    assert.ok(!archive.includes(secret));
    assert.ok(!archive.includes("authentication failed"), "transient diagnostic is not portable history");
  } finally { store.close(); }
});

// Exercise the production factory and Pi adapter against deterministic fetch responses.
// Diagnostics are process-local feedback, never the cause of an unrelated later draft.
test("a new runtime invocation clears earlier provider diagnostics, including non-provider failures", async t => {
  const runtime = createLocalOpenAICompatibleRuntime({ baseUrl: "http://inference.invalid/v1", modelId: "fixture-model" });
  let mode: "error" | "success" | "tool" | "empty" = "error";
  let calls = 0;
  const diagnosticsAtDispatch: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    diagnosticsAtDispatch.push(runtime.getDiagnostic());
    if (mode === "error") return new Response(JSON.stringify({ error: { message: "401 Unauthorized TEST_SECRET_SENTINEL" } }), { status: 401, headers: { "content-type": "application/json" } });
    const delta = mode === "tool"
      ? { tool_calls: [{ index: 0, id: "fixture-tool", type: "function", function: { name: "unsupported", arguments: "{}" } }] }
      : { content: mode === "empty" ? "" : "Recovered response." };
    const chunks = [
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: mode === "tool" ? "tool_calls" : "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const request: RunActorTurnRequest = {
    draftId: "draft", ownerScope: "owner", simulationId: "sim", branchId: "main",
    basisHeadCommitId: "head", contentRevisionId: "content", actorId: "actor", audience: [],
    context: {}, contextHash: "context-hash", prompt: "Speak briefly.", promptHash: "prompt-hash",
    runtimeProfile: { id: "character", version: "v1" }, promptPolicy: { id: "default", version: "v1" },
    outputSchema: { id: "screenplay", digest: "schema-v1" }, skillDigests: [], capabilityGrant: [],
  };
  const run = async (signal?: AbortSignal) => {
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.runActorTurn(request, signal)) events.push(event);
    return events.at(-1);
  };
  for (const recovery of ["success", "tool", "empty", "pre-abort"] as const) {
    mode = "error";
    assert.deepEqual(await run(), { type: "failed", stopReason: "error" });
    assert.match(runtime.getDiagnostic()!, /authentication failed/);
    assert.doesNotMatch(runtime.getDiagnostic()!, /TEST_SECRET_SENTINEL/);
    const before = calls;
    if (recovery === "pre-abort") {
      assert.deepEqual(await run(AbortSignal.abort()), { type: "failed", stopReason: "aborted" });
      assert.equal(calls, before, "pre-aborted generation must not dispatch");
    } else {
      mode = recovery;
      const result = await run();
      assert.equal(result?.type, recovery === "tool" ? "failed" : "completed");
      assert.equal(result?.stopReason, recovery === "tool" ? "tool_use" : "stop");
    }
    assert.equal(runtime.getDiagnostic(), null, `${recovery} must not retain the earlier auth failure`);
    assert.ok(diagnosticsAtDispatch.every(value => value === null), "old provider feedback must be cleared before dispatch");
  }
});
