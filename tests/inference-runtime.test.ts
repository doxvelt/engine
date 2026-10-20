import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiActorTurnRuntime } from "../src/agent-runtime/pi.ts";
import { safeRuntimeDiagnostic } from "../src/agent-runtime/local-openai-compatible.ts";
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
