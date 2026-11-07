import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolCallId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { DshActorTurnRuntime, DSH_TURN_RESULT_TOOL } from "../src/agent-runtime/dsh.ts";
import { AUDIENCE_PROPOSAL_JSON_SCHEMA } from "../src/core/output-contracts.ts";
import { generateActorTurnDraft } from "../src/core/draft-lifecycle.ts";
import { startBranchSimulation } from "../src/core/branch-kernel.ts";
import { domainId } from "../src/core/domain-rules.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

const workspace = path.resolve("examples/executive-interviews");

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-dsh-runtime-"));
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  const started = await startBranchSimulation(store, {
    ownerScope: "owner",
    simulationId: "sim",
    commandId: "start",
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
  });
  const whisper = store.createStageWhisper({
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "whisper",
    targetActorId: "ceo",
    text: "Use only the current branch context.",
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, started, whisper };
}

function generation(head: string, commandId = "generate") {
  return {
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: head,
    commandId,
    payload: {
      actorId: "ceo",
      audience: ["cfo"],
      stageWhisperIds: [domainId("whisper", "owner", "sim", "whisper")],
      runtimeProfile: { id: "character", version: "v1" },
      promptPolicy: { id: "default", version: "v1" },
      outputSchema: { id: "screenplay", digest: "schema-v1" },
      skillDigests: ["skill-a"],
    },
  };
}


function scriptedRuntime(script: (request: GenerateOptions) => AsyncIterable<StreamChunk>) {
  const calls: GenerateOptions[] = [];
  const runtime = new DshActorTurnRuntime({
    async *stream(request) {
      calls.push(request);
      yield* script(request);
    },
  }, { provider: "fixture-provider", model: "fixture-model" });
  return { runtime, calls };
}

async function* textReply(text: string): AsyncIterable<StreamChunk> {
  yield { type: "text-delta", index: 0, text };
  yield { type: "usage", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } };
  yield { type: "finish", reason: { kind: "stop" } };
}

async function* resultReply(value: unknown, name = DSH_TURN_RESULT_TOOL): AsyncIterable<StreamChunk> {
  yield { type: "block-end", index: 0, block: {
    type: "tool-call", id: ToolCallId("result"), name, arguments: JSON.stringify(value),
  } };
  yield { type: "usage", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

function proposalGeneration(head: string, commandId = "proposal") {
  const request = generation(head, commandId);
  return { ...request, payload: { ...request.payload,
    stageWhisperIds: [],
    promptPolicy: { id: "audience-proposal-v1", version: "v1" },
    outputSchema: { id: "audience-proposal", digest: "v1" },
    routing: { version: 1 as const, initialAudience: ["cfo"], correction: "", correctedAudience: null, preservedText: null, sourceDraftId: null },
  } };
}

test("a DSH response creates a durable ready draft with model and usage provenance", async t => {
  const { store, started } = await fixture(t);
  const { runtime, calls } = scriptedRuntime(() => textReply("  Exact reply.  "));
  const result = await generateActorTurnDraft(store, runtime, generation(started.root.id));
  assert.equal(calls.length, 1);
  assert.equal(result.draft.status, "ready");
  assert.equal(result.draft.artifact?.text, "  Exact reply.  ");
  assert.deepEqual(result.draft.artifact?.provenance.adapter, { id: "dsh-llm", version: "0.2.2-rc.1" });
  assert.equal(result.draft.artifact?.provenance.providerId, "fixture-provider");
  assert.equal(result.draft.artifact?.provenance.modelId, "fixture-model");
  assert.deepEqual(result.draft.artifact?.provenance.usage, { inputTokens: 3, outputTokens: 5, totalTokens: 8 });
});

test("each DSH call contains only the current projected prompt and no previous conversation", async t => {
  const { store, started } = await fixture(t);
  const { runtime, calls } = scriptedRuntime(request => {
    assert.equal(request.messages.length, 1);
    assert.deepEqual(request.tools, []);
    return textReply("reply");
  });
  const first = await generateActorTurnDraft(store, runtime, generation(started.root.id));
  const second = await generateActorTurnDraft(store, runtime, generation(started.root.id, "second"));
  assert.equal(calls.length, 2);
  for (const [index, draft] of [first.draft, second.draft].entries())
    assert.deepEqual(calls[index]!.messages, [{ role: "user", content: [{ type: "text", text: draft.prompt }] }]);
});

test("DSH errors remain private and pre-abort dispatches no model call", async t => {
  const { store, started } = await fixture(t);
  const { runtime, calls } = scriptedRuntime(async function* () {
    yield { type: "finish", reason: { kind: "error", failure: { code: "AUTH", message: "PRIVATE_PROVIDER_DETAIL" } } };
  });
  const failed = await generateActorTurnDraft(store, runtime, generation(started.root.id));
  assert.equal(failed.draft.status, "failed");
  assert.doesNotMatch(JSON.stringify(failed.draft), /PRIVATE_PROVIDER_DETAIL/);
  const aborted = await generateActorTurnDraft(store, runtime, generation(started.root.id, "abort"), { signal: AbortSignal.abort() });
  assert.equal(aborted.draft.status, "failed");
  assert.equal(aborted.draft.failure?.provenance.stopReason, "aborted");
  assert.equal(calls.length, 1);
});

test("consumer cancellation closes the DSH stream and aborts its request", async t => {
  const { store, started } = await fixture(t);
  let signal: AbortSignal | undefined;
  let closed = false;
  let markStarted!: () => void;
  const providerStarted = new Promise<void>(resolve => { markStarted = resolve; });
  const { runtime } = scriptedRuntime(async function* (request) {
    signal = request.signal;
    try {
      markStarted();
      yield { type: "text-delta", index: 0, text: "prefix" };
      await new Promise<void>((resolve, reject) => request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true }));
    } finally { closed = true; }
  });
  const controller = new AbortController();
  const operation = generateActorTurnDraft(store, runtime, generation(started.root.id), { signal: controller.signal });
  await Promise.race([providerStarted, operation.then(() => { throw new Error("Generation completed before cancellation."); })]);
  controller.abort();
  const result = await operation;
  assert.equal(result.draft.status, "failed");
  assert.equal(result.draft.failure?.provenance.stopReason, "aborted");
  assert.equal(signal?.aborted, true);
  assert.equal(closed, true);
});

test("unexpected tools cannot execute or create an actor artifact", async t => {
  const { store, started } = await fixture(t);
  const { runtime } = scriptedRuntime(() => resultReply({ path: "/private" }, "read_file"));
  const result = await generateActorTurnDraft(store, runtime, generation(started.root.id));
  assert.equal(result.draft.status, "failed");
  assert.equal(result.draft.artifact, null);
  assert.equal(store.getBranch("owner", "sim", "main")!.headCommitId, started.root.id);
});

test("DSH result declarations use the Doxvelt schema and produce a validated audience", async t => {
  const { store, started } = await fixture(t);
  const { runtime, calls } = scriptedRuntime(request => {
    assert.deepEqual(request.tools, [{ name: DSH_TURN_RESULT_TOOL, description: "Report the complete character turn and the characters who can perceive it.", parameters: AUDIENCE_PROPOSAL_JSON_SCHEMA }]);
    return resultReply({ text: "Private response.", audience: ["ceo", "cfo"] });
  });
  const result = await generateActorTurnDraft(store, runtime, proposalGeneration(started.root.id));
  assert.equal(calls.length, 1);
  assert.equal(result.draft.status, "ready");
  assert.equal(result.draft.artifact?.text, "Private response.");
  assert.deepEqual(result.draft.artifact?.proposedAudience, ["ceo", "cfo"]);
});

test("malformed, extra-key and unauthorized audience proposals cannot publish", async t => {
  const { store, started } = await fixture(t);
  const cases = [
    { text: "reply", audience: ["intruder"] },
    { text: "reply", audience: ["ceo", "cfo"], extra: true },
    { text: 12, audience: ["ceo"] },
  ];
  for (const [index, value] of cases.entries()) {
    const { runtime } = scriptedRuntime(() => resultReply(value));
    const result = await generateActorTurnDraft(store, runtime, proposalGeneration(started.root.id, "bad-" + index));
    assert.equal(result.draft.status, "failed");
    assert.equal(result.draft.artifact, null);
  }
});

test("structured generation rejects prose, duplicate result calls and unknown tools without retry", async t => {
  const { store, started } = await fixture(t);
  const scripts = [
    () => textReply(JSON.stringify({ text: "reply", audience: ["ceo"] })),
    async function* () {
      yield { type: "text-delta" as const, index: 1, text: "Extra prose" };
      yield* resultReply({ text: "reply", audience: ["ceo"] });
    },
    async function* () {
      yield { type: "block-end" as const, index: 1, block: { type: "tool-call" as const, id: ToolCallId("extra"), name: DSH_TURN_RESULT_TOOL, arguments: "{}" } };
      yield* resultReply({ text: "reply", audience: ["ceo"] });
    },
    () => resultReply({ text: "reply", audience: ["ceo"] }, "write_file"),
  ];
  for (const [index, script] of scripts.entries()) {
    const { runtime, calls } = scriptedRuntime(script);
    const result = await generateActorTurnDraft(store, runtime, proposalGeneration(started.root.id, "unexpected-" + index));
    assert.equal(result.draft.status, "failed");
    assert.equal(calls.length, 1);
  }
});

test("incomplete streams and inconsistent token usage fail instead of publishing partial output", async t => {
  const { store, started } = await fixture(t);
  const scripts = [
    async function* () { yield { type: "text-delta" as const, index: 0, text: "unfinished" }; },
    async function* () {
      yield { type: "text-delta" as const, index: 0, text: "reply" };
      yield { type: "usage" as const, usage: { inputTokens: 3, outputTokens: 5, totalTokens: 999 } };
      yield { type: "finish" as const, reason: { kind: "stop" as const } };
    },
  ];
  for (const [index, script] of scripts.entries()) {
    const { runtime } = scriptedRuntime(script);
    const result = await generateActorTurnDraft(store, runtime, generation(started.root.id, "invalid-" + index));
    assert.equal(result.draft.status, "failed");
    assert.equal(result.draft.artifact, null);
  }
});

