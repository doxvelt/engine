import assert from "node:assert/strict";
import test from "node:test";
import { NativeModelHost } from "../src/agent-runtime/native-host.ts";
import { RuntimeSelectionError } from "../src/agent-runtime/selection.ts";
import type { ActorTurnRuntime, RunActorTurnRequest } from "../src/agent-runtime/contracts.ts";
import type { AgentRuntimeEvent } from "../src/agent-runtime/contracts.ts";

function request(): RunActorTurnRequest {
  return { draftId: "draft", ownerScope: "local", simulationId: "story", branchId: "main", basisHeadCommitId: "root", contentRevisionId: "revision", actorId: "corin", audience: ["corin"],
    context: { subjective: { text: "Authorized context." } }, contextHash: "context-hash", prompt: "Frozen prompt.", promptHash: "prompt-hash",
    runtimeProfile: { id: "local-character", version: "v1" }, promptPolicy: { id: "default", version: "v1" }, outputSchema: { id: "screenplay", digest: "v1" }, skillDigests: [], capabilityGrant: [] };
}
test("native model transport freezes requests, selects deployment profiles and excludes credential-shaped identity", async () => {
  const identity = { id: "dsh", version: "v1", providerId: "sk-live-secret", modelId: "safe-model", apiKey: "host-only-value" };
  const runtime: ActorTurnRuntime = { identity, async *runActorTurn(input) {
    assert.equal(input.prompt, "Frozen prompt."); assert.ok(Object.isFrozen(input)); assert.ok(Object.isFrozen(input.context));
    assert.deepEqual(input.capabilityGrant, []);
    yield { type: "text_delta", text: "Words." };
    yield { type: "completed", text: "Words.", stopReason: "stop" };
  } };
  const host = new NativeModelHost({ actorTurnRuntime: runtime }); const signal = new AbortController().signal;
  try {
    assert.deepEqual(await host.call("model.describe", { actorId: "corin" }, signal), { configured: true, profile: { id: "local-character", version: "v1" }, defaultProfile: true });
    await assert.rejects(host.call("model.describe", { actorId: "corin", configuration: "missing" }, signal), RuntimeSelectionError);
    const input = request();
    const opened = await host.call("model.open", { request: input }, signal) as { streamId: string; identity: unknown };
    assert.deepEqual(opened.identity, { id: "dsh", version: "v1", providerId: null, modelId: "safe-model" });
    (input as { prompt: string }).prompt = "Changed after capture.";
    assert.deepEqual(await host.call("model.next", opened, signal), { done: false, event: { type: "text_delta", text: "Words." } });
    assert.deepEqual(await host.call("model.next", opened, signal), { done: false, event: { type: "completed", text: "Words.", stopReason: "stop" } });
    assert.deepEqual(await host.call("model.next", opened, signal), { done: true });
  } finally { host.close(); }
});
test("cancelling a native model read settles even when the provider ignores abort", async () => {
  let closed = 0;
  const runtime: ActorTurnRuntime = { identity: { id: "unresponsive", version: "v1" }, runActorTurn() {
    return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => { closed++; return { done: true, value: undefined }; } }; } };
  } };
  const host = new NativeModelHost({ actorTurnRuntime: runtime });
  const controller = new AbortController();
  const opened = await host.call("model.open", { request: request() }, controller.signal) as { streamId: string };
  const next = host.call("model.next", opened, controller.signal); controller.abort();
  await assert.rejects(next, /Model service failed/); assert.equal(closed, 1);
  await host.call("model.close", { draftId: "draft" }, new AbortController().signal);
  host.close(); assert.equal(closed, 1);
});

test("malformed provider data crosses as rejectable JSON without raw errors or invalid Unicode", async () => {
  const raw = { type: "completed", text: "\ud800", usage: { inputTokens: Infinity, outputTokens: "provider secret" },
    stopReason: { raw: "provider secret" }, debug: "\ud800", message: "provider secret" };
  const runtime: ActorTurnRuntime = { identity: { id: "test", version: "v1" }, async *runActorTurn() { yield raw as unknown as AgentRuntimeEvent; } };
  const host = new NativeModelHost({ actorTurnRuntime: runtime }); const signal = new AbortController().signal;
  try {
    const opened = await host.call("model.open", { request: request() }, signal) as { streamId: string };
    assert.deepEqual(await host.call("model.next", opened, signal), { done: false, event: { type: "completed", text: null,
      usage: { inputTokens: null, outputTokens: null }, stopReason: "invalid_stop_reason" } });
  } finally { host.close(); }
});
