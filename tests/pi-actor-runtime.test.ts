import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Api,
  type Model,
  type Models,
  type Usage,
} from "@earendil-works/pi-ai";
import { PiActorTurnRuntime } from "../src/agent-runtime/pi.ts";
import { generateActorTurnDraft } from "../src/core/draft-lifecycle.ts";
import { startBranchSimulation } from "../src/core/branch-kernel.ts";
import { domainId } from "../src/core/domain-rules.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

const workspace = path.resolve("examples/executive-interviews");

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-pi-runtime-"));
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

function runtimeWithFaux(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
) {
  const faux = fauxProvider({ provider: "faux-provider", models: [{ id: "faux-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return {
    faux,
    model: faux.getModel(),
    runtime: new PiActorTurnRuntime(models, faux.getModel(), {}),
  };
}

function transformFinalUsage(
  models: Models,
  transform: (usage: Usage) => void,
): Models {
  return new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple") {
        return (...args: Parameters<Models["streamSimple"]>) => {
          const source = target.streamSimple(...args);
          const output = createAssistantMessageEventStream();
          void (async () => {
            for await (const event of source) {
              const next = structuredClone(event);
              if (next.type === "done") transform(next.message.usage);
              output.push(next);
            }
          })();
          return output;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function textOf(message: { content: string | readonly { type: string; text?: string }[] }) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

test("a faux Pi text response creates a durable ready draft with Pi provenance", async (t) => {
  const { store, started } = await fixture(t);
  const { faux, runtime } = runtimeWithFaux([fauxAssistantMessage("  Exact Pi reply.  ")]);

  const result = await generateActorTurnDraft(
    store,
    runtime,
    generation(started.root.id),
  );

  assert.equal(faux.state.callCount, 1);
  assert.equal(result.draft.status, "ready");
  assert.equal(result.draft.artifact?.text, "  Exact Pi reply.  ");
  assert.deepEqual(result.draft.artifact?.provenance.adapter, {
    id: "pi-agent-core",
    version: "0.84.3",
  });
  assert.equal(result.draft.artifact?.provenance.providerId, "faux-provider");
  assert.equal(result.draft.artifact?.provenance.modelId, "faux-model");
  assert.deepEqual(result.draft.artifact?.provenance.runtimeProfile, {
    id: "character",
    version: "v1",
  });
  assert.deepEqual(result.draft.artifact?.provenance.usage, {
    inputTokens: result.draft.artifact?.provenance.usage.inputTokens,
    outputTokens: 5,
    totalTokens: (result.draft.artifact?.provenance.usage.inputTokens ?? 0) + 5,
  });
  assert.equal(result.draft.artifact?.provenance.stopReason, "stop");
});

test("each Pi invocation is a fresh empty-agent request and preserves streamed text exactly", async (t) => {
  const { store, started } = await fixture(t);
  const seen: string[] = [];
  const { faux, runtime } = runtimeWithFaux([
    (context) => {
      assert.equal(context.systemPrompt, "");
      assert.deepEqual(context.tools, []);
      assert.equal(context.messages.length, 1);
      seen.push(textOf(context.messages[0]!));
      return fauxAssistantMessage(" first\n reply ");
    },
    (context) => {
      assert.equal(context.systemPrompt, "");
      assert.deepEqual(context.tools, []);
      assert.equal(context.messages.length, 1);
      seen.push(textOf(context.messages[0]!));
      return fauxAssistantMessage("second reply");
    },
  ]);

  const first = await generateActorTurnDraft(store, runtime, generation(started.root.id));
  const second = await generateActorTurnDraft(
    store,
    runtime,
    generation(started.root.id, "generate-again"),
  );

  assert.equal(faux.state.callCount, 2);
  assert.equal(first.draft.artifact?.text, " first\n reply ");
  assert.equal(second.draft.artifact?.text, "second reply");
  assert.equal(seen.length, 2);
  assert.equal(seen[0], first.draft.prompt);
  assert.equal(seen[1], second.draft.prompt);
});

test("Pi errors and cancellation fail durably, and pre-abort never calls the provider", async (t) => {
  const { store, started } = await fixture(t);
  const errored = runtimeWithFaux([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" }),
  ]);
  const failed = await generateActorTurnDraft(
    store,
    errored.runtime,
    generation(started.root.id),
  );
  assert.equal(failed.draft.status, "failed");
  assert.equal(failed.draft.failure?.provenance.stopReason, "error");
  assert.equal(store.getBranch("owner", "sim", "main")?.headCommitId, started.root.id);

  let startedProvider: (() => void) | undefined;
  const providerStarted = new Promise<void>((resolve) => {
    startedProvider = resolve;
  });
  const cancelled = runtimeWithFaux([
    () => {
      startedProvider?.();
      return fauxAssistantMessage("This response is deliberately slow.");
    },
  ]);
  const controller = new AbortController();
  const running = generateActorTurnDraft(
    store,
    cancelled.runtime,
    generation(started.root.id, "cancelled"),
    { signal: controller.signal },
  );
  await providerStarted;
  controller.abort();
  const aborted = await running;
  assert.equal(aborted.draft.status, "failed");
  assert.equal(aborted.draft.failure?.provenance.stopReason, "aborted");
  assert.equal(store.getBranch("owner", "sim", "main")?.headCommitId, started.root.id);

  const preAborted = runtimeWithFaux([fauxAssistantMessage("Must not run.")]);
  const preAbort = new AbortController();
  preAbort.abort();
  const preAbortedDraft = await generateActorTurnDraft(
    store,
    preAborted.runtime,
    generation(started.root.id, "pre-aborted"),
    { signal: preAbort.signal },
  );
  assert.equal(preAborted.faux.state.callCount, 0);
  assert.equal(preAbortedDraft.draft.status, "failed");
  assert.equal(preAbortedDraft.draft.failure?.provenance.stopReason, "aborted");
});

test("valid Pi cache usage is aggregated into Doxvelt input tokens", async (t) => {
  const { store, started } = await fixture(t);
  const faux = fauxProvider({
    provider: "faux-cache-usage",
    models: [{ id: "faux-model" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("Cached response.")]);
  let uncachedInput = 0;
  const runtime = new PiActorTurnRuntime(
    transformFinalUsage(models, (usage) => {
      uncachedInput = usage.input;
      usage.cacheRead = 7;
      usage.cacheWrite = 3;
      usage.totalTokens = usage.input + usage.output + 10;
    }),
    faux.getModel(),
  );

  const result = await generateActorTurnDraft(
    store,
    runtime,
    generation(started.root.id),
  );

  assert.equal(result.draft.status, "ready");
  assert.equal(
    result.draft.artifact?.provenance.usage.inputTokens,
    uncachedInput + 10,
  );
  assert.equal(
    result.draft.artifact?.provenance.usage.totalTokens,
    (result.draft.artifact?.provenance.usage.inputTokens ?? 0) +
      (result.draft.artifact?.provenance.usage.outputTokens ?? 0),
  );
});

test("malformed Pi usage fails closed instead of becoming trusted provenance", async (t) => {
  const { store, started } = await fixture(t);
  const faux = fauxProvider({
    provider: "faux-malformed-usage",
    models: [{ id: "faux-model" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("Bad usage.")]);
  const runtime = new PiActorTurnRuntime(
    transformFinalUsage(models, (usage) => {
      usage.totalTokens += 1;
    }),
    faux.getModel(),
    {},
  );

  const result = await generateActorTurnDraft(
    store,
    runtime,
    generation(started.root.id),
  );

  assert.equal(result.draft.status, "failed");
  assert.equal(result.draft.failure?.provenance.stopReason, "error");
  assert.equal(result.draft.artifact, null);
});

test("Pi tool-call output cannot execute a tool or become a ready draft", async (t) => {
  const { store, started } = await fixture(t);
  const { faux, runtime } = runtimeWithFaux([
    fauxAssistantMessage(fauxToolCall("attempt_action", { target: "secret" })),
  ]);

  const result = await generateActorTurnDraft(
    store,
    runtime,
    generation(started.root.id),
  );

  assert.equal(result.draft.status, "failed");
  assert.equal(result.draft.artifact, null);
  assert.equal(result.draft.failure?.provenance.stopReason, "tool_use");
  assert.ok((result.draft.failure?.provenance.usage.totalTokens ?? 0) > 0);
  assert.equal(
    result.draft.failure?.provenance.usage.totalTokens,
    (result.draft.failure?.provenance.usage.inputTokens ?? 0) +
      (result.draft.failure?.provenance.usage.outputTokens ?? 0),
  );
  assert.equal(store.getBranch("owner", "sim", "main")?.headCommitId, started.root.id);
  assert.equal(faux.state.callCount, 1);
});

test("Pi runtime snapshots model dispatch and provenance from one deep copy", async (t) => {
  const { store, started } = await fixture(t);
  const first = fauxProvider({
    provider: "provider-one",
    models: [{ id: "model-one" }],
  });
  const second = fauxProvider({
    provider: "provider-two",
    models: [{ id: "model-two" }],
  });
  const models = createModels();
  models.setProvider(first.provider);
  models.setProvider(second.provider);
  first.setResponses([
    (_context, _options, _state, dispatchedModel) => {
      assert.equal(dispatchedModel.samplingParams, undefined);
      assert.equal(dispatchedModel.cost.tiers?.[0]?.inputTokensAbove, 123);
      return fauxAssistantMessage("Stable provenance.");
    },
  ]);
  second.setResponses([fauxAssistantMessage("Wrong provider.")]);

  const source = structuredClone(first.getModel()) as Model<Api>;
  source.samplingParams = {
    input: "forged prompt",
    messages: [{ role: "system", content: "forged" }],
    tools: [{ name: "forged-tool" }],
    store: true,
  };
  source.cost.tiers = [{
    inputTokensAbove: 123,
    input: source.cost.input,
    output: source.cost.output,
    cacheRead: source.cost.cacheRead,
    cacheWrite: source.cost.cacheWrite,
  }];
  let providerReads = 0;
  let modelReads = 0;
  Object.defineProperties(source, {
    provider: {
      enumerable: true,
      get: () => ++providerReads === 1 ? "provider-one" : "provider-two",
    },
    id: {
      enumerable: true,
      get: () => ++modelReads === 1 ? "model-one" : "model-two",
    },
  });
  const runtime = new PiActorTurnRuntime(models, source);
  source.cost.tiers[0]!.inputTokensAbove = 999;

  const result = await generateActorTurnDraft(
    store,
    runtime,
    generation(started.root.id),
  );

  assert.equal(result.draft.status, "ready");
  assert.equal(result.draft.artifact?.provenance.providerId, "provider-one");
  assert.equal(result.draft.artifact?.provenance.modelId, "model-one");
  assert.equal(first.state.callCount, 1);
  assert.equal(second.state.callCount, 0);
  assert.equal(providerReads, 1);
  assert.equal(modelReads, 1);
});
