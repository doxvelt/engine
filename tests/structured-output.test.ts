import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalOpenAICompatibleRuntime } from "../src/agent-runtime/local-openai-compatible.ts";
import type { RunActorTurnRequest } from "../src/agent-runtime/contracts.ts";
import { commitManualTurn, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { createSavedAlternative, type AlternativeRequest } from "../src/core/saved-alternatives.ts";
import { acceptActorTurnDraft, generateActorTurnDraft } from "../src/core/draft-lifecycle.ts";
import { decodeActorTurnDraftRecord } from "../src/core/draft-contracts.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import type { GenerateActorTurnDraftCommand } from "../src/core/ports.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

const expectedFormat = {
  type: "json_schema",
  json_schema: {
    name: "audience_proposal_v1", strict: true,
    schema: { type: "object", properties: { text: { type: "string" }, audience: { type: "array", items: { type: "string" } } },
      required: ["text", "audience"], additionalProperties: false },
  },
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-42-"));
  const store = await openBranchStore(path.join(root, "store.sqlite")).open();
  const started = await startBranchSimulation(store, { ownerScope: "owner", simulationId: "sim", commandId: "start",
    workspacePath: path.resolve("examples/executive-interviews"), scenarioId: "executive-interviews", branchId: "main" });
  const payloads: Record<string, any>[] = [];
  let output = JSON.stringify({ text: "A performance.", audience: ["ceo", "cfo"] });
  let status = 200;
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of request) body += chunk;
    payloads.push(JSON.parse(body));
    if (status !== 200) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "response_format json_schema unsupported REJECTED_SECRET_SENTINEL" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunks = [
      { id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: output }, finish_reason: null }] },
      { id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ];
    response.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const runtime = createLocalOpenAICompatibleRuntime({ baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: "conforming-model" });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const command = (commandId: string): GenerateActorTurnDraftCommand => ({
    ownerScope: "owner", simulationId: "sim", branchId: "main", expectedHead: started.root.id, commandId,
    payload: { actorId: "ceo", audience: ["cfo"], stageWhisperIds: [], runtimeProfile: { id: "character", version: "v1" },
      promptPolicy: { id: "actor-knowledge-v1", version: "v1" }, outputSchema: { id: "audience-proposal", digest: "v1" }, skillDigests: [],
      routing: { version: 3, initialAudience: ["cfo"], completeWhisper: "", correction: "", correctedAudience: null, preservedText: null, sourceDraftId: null } },
  });
  return { root, store, runtime, payloads, command, respond: (text: string, code = 200) => { output = text; status = code; } };
}

function assertPayload(payload: Record<string, any>, prompt: string) {
  assert.deepEqual(payload.response_format, expectedFormat);
  assert.deepEqual(payload.messages, [{ role: "user", content: [{ type: "text", text: prompt }] }]);
  assert.ok(payload.tools === undefined || payload.tools.length === 0);
}

test("production Pi request enforces the exact audience schema, frozen prompt, empty tools and empty whisper", async t => {
  const f = await fixture(t);
  const before = f.store.exportSimulation("owner", "sim");
  const command = f.command("valid");
  const draft = (await generateActorTurnDraft(f.store, f.runtime, command)).draft;
  assert.equal(draft.status, "ready");
  assert.equal(draft.routing!.completeWhisper, "");
  assert.equal(draft.artifact!.text, "A performance.");
  assert.deepEqual(draft.artifact!.proposedAudience, ["ceo", "cfo"]);
  assert.equal(f.payloads.length, 1);
  assertPayload(f.payloads[0]!, draft.prompt);
  assert.deepEqual(f.store.exportSimulation("owner", "sim"), before);
  assert.equal((await generateActorTurnDraft(f.store, f.runtime, command)).replayed, true);
  assert.equal(f.payloads.length, 1);
  const accept = { ownerScope: "owner", simulationId: "sim", branchId: "main", expectedHead: command.expectedHead, draftId: draft.id, commandId: "accept" };
  acceptActorTurnDraft(f.store, accept);
  assert.equal(acceptActorTurnDraft(f.store, accept).replayed, true);
  assert.equal(f.payloads.length, 1, "Accept and command replay never infer");
  validateSimulationArchive(f.store.exportSimulation("owner", "sim"));
});

test("prose and invalid proposals fail safely without artifacts, history advancement or silent repair", async t => {
  const f = await fixture(t);
  const before = f.store.exportSimulation("owner", "sim");
  const cases = [
    "REJECTED_PROSE_SENTINEL: I will speak now.",
    JSON.stringify({ text: "shape", audience: ["ceo"], extra: true }),
    JSON.stringify({ text: "shape", audience: "cfo" }),
    JSON.stringify({ text: 7, audience: ["ceo", "cfo"] }),
    JSON.stringify({ audience: ["ceo", "cfo"] }),
    JSON.stringify({ text: "   ", audience: ["ceo", "cfo"] }),
    JSON.stringify({ text: "unknown", audience: ["ceo", "missing"] }),
    JSON.stringify({ text: "duplicate", audience: ["ceo", "cfo", "cfo"] }),
    JSON.stringify({ text: "", audience: ["ceo", "cfo"] }),
  ];
  for (const [index, output] of cases.entries()) {
    f.respond(output);
    const command = f.command(`invalid-${index}`);
    const draft = (await generateActorTurnDraft(f.store, f.runtime, command)).draft;
    assert.equal(draft.status, "failed");
    assert.equal(draft.artifact, null);
    assert.equal(draft.failure!.code, "output_contract");
    assert.equal(draft.failure!.message, "Runtime output did not satisfy the required JSON performance and audience contract.");
    assert.doesNotMatch(JSON.stringify(draft), /REJECTED_PROSE_SENTINEL/);
    assert.deepEqual(decodeActorTurnDraftRecord(draft), draft);
    assert.deepEqual(f.store.exportSimulation("owner", "sim"), before);
    assert.equal(f.payloads.length, index + 1);
    assertPayload(f.payloads[index]!, draft.prompt);
    if (index === 0) {
      for (const code of ["runtime_failure", "invalid_stream"] as const) {
        const old = structuredClone(draft);
        old.failure!.code = code;
        old.failure!.message = code === "invalid_stream" ? "Runtime output was invalid." : "Runtime generation failed.";
        assert.deepEqual(decodeActorTurnDraftRecord(old), old, "old safe failures decode unchanged");
      }
      const unknown = structuredClone(draft) as any;
      unknown.failure.code = "unknown_failure";
      assert.throws(() => decodeActorTurnDraftRecord(unknown), /failure code/);
    }
  }
  const sourceCommand = f.command("invalid-0");
  const source = (await generateActorTurnDraft(f.store, f.runtime, sourceCommand)).draft;
  f.respond(JSON.stringify({ text: "Retry succeeded.", audience: ["ceo", "cfo"] }));
  const retry = { ...sourceCommand, commandId: "exact-retry" };
  const ready = (await generateActorTurnDraft(f.store, f.runtime, retry, { retryDraftId: source.id })).draft;
  assert.equal(ready.status, "ready");
  for (const key of ["prompt", "promptHash", "contextHash", "context", "outputSchema"] as const) assert.deepEqual(ready[key], source[key]);
  assert.deepEqual(f.payloads.at(-1), f.payloads[0], "Retry sends the same saved request");
  assert.equal((await generateActorTurnDraft(f.store, f.runtime, retry, { retryDraftId: source.id })).replayed, true);
  assert.equal(f.payloads.length, cases.length + 1);
  const accept = { ownerScope: "owner", simulationId: "sim", branchId: "main", expectedHead: retry.expectedHead, draftId: ready.id, commandId: "accept-retry" };
  acceptActorTurnDraft(f.store, accept);
  const archive = f.store.exportSimulation("owner", "sim");
  validateSimulationArchive(archive);
  const imported = await openBranchStore(path.join(f.root, "import.sqlite")).open();
  try {
    imported.importSimulation(archive);
    assert.equal(acceptActorTurnDraft(imported, accept).replayed, true);
  } finally { imported.close(); }
});

test("director-corrected audience remains authoritative with schema-constrained output", async t => {
  const f = await fixture(t);
  const original = f.command("source");
  const source = (await generateActorTurnDraft(f.store, f.runtime, original)).draft;
  assert.equal(source.status, "ready");
  const before = f.store.exportSimulation("owner", "sim");
  const corrected = f.command("corrected");
  corrected.payload.routing!.sourceDraftId = source.id;
  corrected.payload.routing!.correctedAudience = ["cfo"];
  f.respond(JSON.stringify({ text: "REJECTED_CORRECTION_SENTINEL", audience: ["ceo"] }));
  const failed = (await generateActorTurnDraft(f.store, f.runtime, corrected)).draft;
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure!.code, "output_contract");
  assert.equal(failed.artifact, null);
  assert.equal(f.payloads.length, 2);
  assertPayload(f.payloads[1]!, failed.prompt);
  assert.doesNotMatch(JSON.stringify(failed), /REJECTED_CORRECTION_SENTINEL/);
  assert.deepEqual(decodeActorTurnDraftRecord(failed), failed);
  assert.deepEqual(f.store.exportSimulation("owner", "sim"), before);
});

test("HTTP400/422 schema rejection makes one request and no prompt-only fallback", async t => {
  const f = await fixture(t);
  const before = f.store.exportSimulation("owner", "sim");
  for (const status of [400, 422]) {
    f.respond("", status);
    const draft = (await generateActorTurnDraft(f.store, f.runtime, f.command(`rejected-${status}`))).draft;
    assert.equal(draft.status, "failed");
    assert.equal(draft.artifact, null);
    assert.equal(draft.failure!.message, "Runtime generation failed.");
    assert.doesNotMatch(JSON.stringify(draft), /REJECTED_SECRET_SENTINEL|response_format/);
    assert.doesNotMatch(f.runtime.getDiagnostic()!, /REJECTED_SECRET_SENTINEL/);
    assert.match(f.runtime.getDiagnostic()!, /compatibility/);
    assert.deepEqual(decodeActorTurnDraftRecord(draft), draft);
    assertPayload(f.payloads.at(-1)!, draft.prompt);
    assert.deepEqual(f.store.exportSimulation("owner", "sim"), before);
  }
  assert.equal(f.payloads.length, 2);
});

test("unknown schema IDs/digests fail closed; legacy unrouted text remains text", async t => {
  const f = await fixture(t);
  const request: RunActorTurnRequest = {
    draftId: "draft", ownerScope: "owner", simulationId: "sim", branchId: "main", basisHeadCommitId: "head", contentRevisionId: "content",
    actorId: "ceo", audience: [], context: {}, contextHash: "context", prompt: "Frozen text prompt.", promptHash: "prompt",
    runtimeProfile: { id: "character", version: "v1" }, promptPolicy: { id: "default", version: "v1" },
    outputSchema: { id: "screenplay", digest: "schema-v1" }, skillDigests: [], capabilityGrant: [],
  };
  for (const outputSchema of [{ id: "audience-proposal", digest: "v2" }, { id: "unknown", digest: "v1" }, { id: "screenplay", digest: "unknown" }]) {
    const events = [];
    for await (const event of f.runtime.runActorTurn({ ...request, outputSchema })) events.push(event);
    assert.deepEqual(events, [{ type: "failed", stopReason: "error" }]);
  }
  assert.equal(f.payloads.length, 0);
  f.respond("Legacy plain performance.");
  const events = [];
  for await (const event of f.runtime.runActorTurn(request)) events.push(event);
  assert.equal(events.at(-1)?.type, "completed");
  assert.equal(f.payloads.length, 1);
  assert.equal(f.payloads[0]!.response_format, undefined);
});

test("historical contract failure preserves the source path; retry uses the same request and saves a portable alternative", async t => {
  const f = await fixture(t);
  const command = f.command("basis");
  const original = commitManualTurn(f.store, { ownerScope: "owner", simulationId: "sim", branchId: "main",
    expectedHead: command.expectedHead, commandId: "manual-source",
    payload: { actorId: "ceo", audience: ["cfo"], text: "Original performance.", knowledgePolicy: "actor-knowledge-v1" } });
  const event = original.commit.events.find(event => event.type === "message_accepted")!;
  assert.equal(event.type, "message_accepted");
  if (event.type !== "message_accepted") throw new Error("Missing message");
  const request: AlternativeRequest = { ownerScope: "owner", simulationId: "sim", sourceBranchId: "main",
    expectedHead: original.commit.id, sourceCommitId: original.commit.id, messageVersionId: event.message.id,
    logicalMessageId: event.message.logicalMessageId, actorId: "ceo", commandId: "historical", action: "generate",
    audience: ["ceo", "cfo"], completeWhisper: "" };
  const before = f.store.exportSimulation("owner", "sim");
  f.respond("REJECTED_HISTORICAL_SENTINEL");
  const failed = (await createSavedAlternative(f.store, f.runtime, request)).operation;
  assert.equal(failed.status, "failed");
  assert.equal(failed.draft!.failure!.code, "output_contract");
  assert.equal(failed.draft!.artifact, null);
  assert.deepEqual(decodeActorTurnDraftRecord(failed.draft), failed.draft);
  assert.doesNotMatch(JSON.stringify(failed), /REJECTED_HISTORICAL_SENTINEL/);
  assert.deepEqual(f.store.exportSimulation("owner", "sim"), before);
  assert.equal(f.payloads.length, 1);
  assertPayload(f.payloads[0]!, failed.draft!.prompt);
  assert.equal((await createSavedAlternative(f.store, f.runtime, request)).replayed, true);
  assert.equal(f.payloads.length, 1);
  f.respond(JSON.stringify({ text: "Alternative performance.", audience: ["ceo", "cfo"] }));
  const retry = { ...request, commandId: "historical-retry", retryOf: failed.id };
  const saved = (await createSavedAlternative(f.store, f.runtime, retry)).operation;
  assert.equal(saved.status, "saved");
  assert.deepEqual(f.payloads[1], f.payloads[0]);
  assert.equal(f.store.getBranch("owner", "sim", "main")!.headCommitId, original.commit.id);
  const archive = f.store.exportSimulation("owner", "sim");
  validateSimulationArchive(archive);
  const imported = await openBranchStore(path.join(f.root, "historical-import.sqlite")).open();
  try {
    imported.importSimulation(archive);
    assert.equal((await createSavedAlternative(imported, f.runtime, retry)).replayed, true);
    assert.equal(f.payloads.length, 2);
  } finally { imported.close(); }
});
