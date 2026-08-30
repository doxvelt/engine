import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createLocalOpenAICompatibleRuntime,
  LOCAL_OPENAI_COMPATIBLE_KEYLESS_TRANSPORT_KEY,
} from "../src/agent-runtime/local-openai-compatible.ts";
import { domainId } from "../src/core/domain-rules.ts";
import type { ActorTurnRuntime } from "../src/agent-runtime/contracts.ts";
import { createLocalApiServer } from "../src/local-api/server.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";

const workspace = path.resolve("examples/executive-interviews");
const run = promisify(execFile);

async function fixture(
  t: test.TestContext,
  runtime?: ActorTurnRuntime,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-local-drafts-"));
  const dbPath = path.join(root, "runtime.sqlite");
  const server = createLocalApiServer({
    dbPath,
    ...(runtime ? { actorTurnRuntime: runtime } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing API address.");
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  return { dbPath, base: `http://127.0.0.1:${address.port}` };
}

function post(base: string, route: string, body: unknown) {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawPost(base: string, route: string, body: unknown): Promise<number> {
  const target = new URL(base);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: route,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode || 0));
    });
    request.once("error", reject);
    request.end(payload);
  });
}

async function started(base: string) {
  const response = await post(base, "/simulations/start", {
    simulationId: "sim",
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
    commandId: "start",
  });
  assert.equal(response.status, 200);
  return (await response.json()) as { root: { id: string } };
}

function generate(head: string, commandId = "generate") {
  return {
    branchId: "main",
    expectedHead: head,
    commandId,
    actorId: "ceo",
    audience: ["cfo"],
  };
}

test("durable local API drafts generate, replay, retrieve, and accept verbatim", async (t) => {
  const runtime = new DeterministicFakeRuntime([
    { type: "text_delta", text: "Exact generated reply." },
    { type: "usage", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
    { type: "completed", text: "Exact generated reply.", stopReason: "stop" },
  ]);
  const { base } = await fixture(t, runtime);
  const simulation = await started(base);

  const first = await post(base, "/simulations/sim/drafts", generate(simulation.root.id));
  assert.equal(first.status, 200);
  const generated = (await first.json()) as {
    replayed: boolean;
    draft: { id: string; status: string; artifact: { text: string } };
  };
  assert.equal(generated.replayed, false);
  assert.equal(generated.draft.status, "ready");
  assert.equal(generated.draft.artifact.text, "Exact generated reply.");
  assert.equal(runtime.calls, 1);

  const replay = await post(base, "/simulations/sim/drafts", generate(simulation.root.id));
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);
  assert.equal(runtime.calls, 1);

  const fetched = await fetch(`${base}/simulations/sim/drafts/${generated.draft.id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(await fetched.json(), generated.draft);

  for (const action of ["accept", "discard"] as const) {
    const extra = await post(
      base,
      `/simulations/sim/drafts/${generated.draft.id}/${action}/unexpected`,
      { commandId: `extra-${action}` },
    );
    assert.equal(extra.status, 404);
    assert.equal(
      await rawPost(
        base,
        `/simulations/sim/drafts/${generated.draft.id}/${action}/%2e`,
        { commandId: `encoded-${action}` },
      ),
      404,
    );
  }
  const stillReady = await fetch(
    `${base}/simulations/sim/drafts/${generated.draft.id}`,
  );
  assert.equal(
    ((await stillReady.json()) as { status: string }).status,
    "ready",
  );
  const beforeAccept = await fetch(
    `${base}/simulations/sim/transcript?branchId=main`,
  );
  assert.deepEqual(
    ((await beforeAccept.json()) as { transcript: unknown[] }).transcript,
    [],
  );

  const accepted = await post(base, `/simulations/sim/drafts/${generated.draft.id}/accept`, {
    commandId: "accept",
  });
  assert.equal(accepted.status, 200);
  const receipt = (await accepted.json()) as { replayed: boolean; branch: { headCommitId: string } };
  assert.equal(receipt.replayed, false);
  const transcript = await fetch(`${base}/simulations/sim/transcript?branchId=main`);
  assert.equal(transcript.status, 200);
  assert.equal(((await transcript.json()) as { transcript: Array<{ text: string }> }).transcript.at(-1)?.text, "Exact generated reply.");

  const acceptedReplay = await post(base, `/simulations/sim/drafts/${generated.draft.id}/accept`, {
    commandId: "accept",
  });
  assert.equal(acceptedReplay.status, 200);
  assert.equal(((await acceptedReplay.json()) as { replayed: boolean }).replayed, true);
});

test("edited acceptance preserves generated artifact and discard remains non-canonical", async (t) => {
  const runtime = new DeterministicFakeRuntime([
    { type: "usage", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
    { type: "completed", text: "Generated original", stopReason: "stop" },
  ]);
  const { base } = await fixture(t, runtime);
  const simulation = await started(base);
  const discardedDraft = (await (await post(base, "/simulations/sim/drafts", generate(simulation.root.id, "discard-generate"))).json()) as {
    draft: { id: string };
  };
  const discarded = await post(base, `/simulations/sim/drafts/${discardedDraft.draft.id}/discard`, { commandId: "discard" });
  assert.equal(discarded.status, 200);
  assert.equal(((await discarded.json()) as { draft: { status: string } }).draft.status, "discarded");
  const afterDiscard = await fetch(
    `${base}/simulations/sim/transcript?branchId=main`,
  );
  const discardedProjection = (await afterDiscard.json()) as {
    branch: { headCommitId: string };
    transcript: unknown[];
  };
  assert.equal(discardedProjection.branch.headCommitId, simulation.root.id);
  assert.deepEqual(discardedProjection.transcript, []);

  const generated = (await (await post(base, "/simulations/sim/drafts", generate(simulation.root.id, "edited-generate"))).json()) as {
    draft: { id: string };
  };
  const accepted = await post(base, `/simulations/sim/drafts/${generated.draft.id}/accept`, {
    commandId: "edited-accept",
    finalText: "Edited final",
  });
  assert.equal(accepted.status, 200);
  const acceptedResult = (await accepted.json()) as {
    branch: { headCommitId: string };
    commit: {
      id: string;
      events: Array<{
        type: string;
        message?: {
          text: string;
          provenance: { finalTextSource?: string; sourceArtifactDigest?: string };
        };
      }>;
    };
  };
  assert.equal(acceptedResult.branch.headCommitId, acceptedResult.commit.id);
  const acceptedMessage = acceptedResult.commit.events.find(
    (event) => event.type === "message_accepted",
  )?.message;
  assert.equal(acceptedMessage?.text, "Edited final");
  assert.equal(acceptedMessage?.provenance.finalTextSource, "acceptor_edited");
  assert.ok(acceptedMessage?.provenance.sourceArtifactDigest);
  const stored = await fetch(`${base}/simulations/sim/drafts/${generated.draft.id}`);
  const draft = (await stored.json()) as { artifact: { text: string }; acceptance?: { acceptedText: string } };
  assert.equal(draft.artifact.text, "Generated original");
});

test("unconfigured and caller-selected runtime requests fail before generation", async (t) => {
  const { base, dbPath } = await fixture(t);
  const simulation = await started(base);
  const unavailable = await post(base, "/simulations/sim/drafts", generate(simulation.root.id));
  assert.equal(unavailable.status, 503);
  const store = await openBranchStore(dbPath).open();
  assert.equal(store.getActorTurnDraft("local", "sim", domainId("actor_turn_draft", "local", "sim", "generate")), null);
  store.close();

  const runtime = new DeterministicFakeRuntime([]);
  const injected = await fixture(t, runtime);
  const injectedSimulation = await started(injected.base);
  for (const selection of [
    { modelId: "other" }, { baseUrl: "http://evil.test" }, { runtimeProfile: "other" },
    { promptPolicy: "other" }, { outputSchema: "other" }, { skills: [] }, { apiKey: "secret" }, { ownerScope: "other" },
  ]) {
    const response = await post(injected.base, "/simulations/sim/drafts", { ...generate(injectedSimulation.root.id), ...selection });
    assert.equal(response.status, 400);
  }
  assert.equal(runtime.calls, 0);
});

test("local runtime configuration rejects credential, endpoint, and unsupported model IDs", () => {
  for (const config of [
    { baseUrl: "ftp://localhost/v1", modelId: "model" },
    { baseUrl: "http://user:password@localhost/v1", modelId: "model" },
    { baseUrl: "http://localhost/v1?token=secret", modelId: "model" },
    { baseUrl: "http://localhost/v1", modelId: "https://host/model" },
    { baseUrl: "http://localhost/v1", modelId: "sk_live_not-a-model" },
    { baseUrl: "http://localhost/v1", modelId: "gpt-oss:20b" },
  ]) assert.throws(() => createLocalOpenAICompatibleRuntime(config));
});

test("local API startup rejects incomplete and orphan runtime flags", async () => {
  for (const args of [
    ["--runtime-max-tokens", "0"],
    ["--runtime-context-window"],
    ["--runtime-max-tokens", "10", "--runtime-max-tokens"],
    ["--runtime-base-url"],
    ["--runtime-base-url", "http://localhost:8000/v1"],
  ]) {
    await assert.rejects(
      run(process.execPath, ["src/local-api/index.ts", ...args]),
      (error: unknown) => {
        const stderr = String((error as { stderr?: string }).stderr || error);
        assert.match(stderr, /runtime|Runtime/);
        return true;
      },
    );
  }
});

test("local OpenAI-compatible factory streams through Pi without exposing deployment secrets", async (t) => {
  const secret = "local-test-secret";
  let body = "";
  let authorization = "";
  const upstream = createServer((request, response) => {
    authorization = request.headers.authorization || "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"sse-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"SSE reply"},"finish_reason":null}]}\n\n');
      response.write('data: {"id":"sse-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"."},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n');
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream address.");
  t.after(() => new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
  const runtime = createLocalOpenAICompatibleRuntime({
    baseUrl: `http://127.0.0.1:${address.port}/v1/`,
    modelId: "local-model",
    apiKey: secret,
    transport: "sse",
  });
  const { base } = await fixture(t, runtime);
  const status = await fetch(`${base}/runtime`);
  assert.equal(status.status, 200);
  const runtimeStatus = JSON.stringify(await status.json());
  assert.doesNotMatch(runtimeStatus, /127\.0\.0\.1|local-test-secret/);
  const simulation = await started(base);
  const response = await post(base, "/simulations/sim/drafts", generate(simulation.root.id));
  assert.equal(response.status, 200);
  const result = JSON.stringify(await response.json());
  const upstreamRequest = JSON.parse(body) as {
    stream?: boolean;
    store?: boolean;
    tools?: unknown;
    messages?: unknown;
  };
  assert.equal(upstreamRequest.stream, true);
  assert.notEqual(upstreamRequest.store, true);
  assert.equal(upstreamRequest.tools, undefined);
  assert.match(JSON.stringify(upstreamRequest.messages), /Answer in first person/);
  assert.doesNotMatch(body, /local-test-secret/);
  assert.equal(authorization, `Bearer ${secret}`);
  assert.doesNotMatch(result, /local-test-secret/);
  assert.doesNotMatch(result, /127\.0\.0\.1/);

  body = "";
  authorization = "";
  const keylessRuntime = createLocalOpenAICompatibleRuntime({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    modelId: "keyless-model",
    transport: "sse",
  });
  const keyless = await fixture(t, keylessRuntime);
  const keylessSimulation = await started(keyless.base);
  const keylessResponse = await post(
    keyless.base,
    "/simulations/sim/drafts",
    generate(keylessSimulation.root.id, "keyless-generate"),
  );
  assert.equal(keylessResponse.status, 200);
  assert.equal(
    authorization,
    `Bearer ${LOCAL_OPENAI_COMPATIBLE_KEYLESS_TRANSPORT_KEY}`,
  );
  assert.doesNotMatch(
    JSON.stringify(await keylessResponse.json()),
    new RegExp(LOCAL_OPENAI_COMPATIBLE_KEYLESS_TRANSPORT_KEY),
  );
});
test("draft validation maps stale, actor, audience, whisper, and command conflicts without invoking Pi", async (t) => {
  const runtime = new DeterministicFakeRuntime([
    { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    { type: "completed", text: "Ready", stopReason: "stop" },
  ]);
  const { base } = await fixture(t, runtime);
  const simulation = await started(base);

  const stale = await post(base, "/simulations/sim/drafts", generate("stale-head", "stale"));
  assert.equal(stale.status, 409);
  const missingActor = await post(base, "/simulations/sim/drafts", {
    ...generate(simulation.root.id, "missing-actor"),
    actorId: "missing",
  });
  assert.equal(missingActor.status, 404);
  const missingAudience = await post(base, "/simulations/sim/drafts", {
    ...generate(simulation.root.id, "missing-audience"),
    audience: ["missing"],
  });
  assert.equal(missingAudience.status, 404);
  const missingWhisper = await post(base, "/simulations/sim/drafts", {
    ...generate(simulation.root.id, "missing-whisper"),
    stageWhisperIds: ["missing"],
  });
  assert.equal(missingWhisper.status, 400);
  assert.equal(runtime.calls, 0);

  const ready = await post(base, "/simulations/sim/drafts", generate(simulation.root.id, "reused"));
  assert.equal(ready.status, 200);
  const reused = await post(base, "/simulations/sim/drafts", {
    ...generate(simulation.root.id, "reused"),
    actorId: "cfo",
  });
  assert.equal(reused.status, 409);
  assert.equal(runtime.calls, 1);

  const retired = await post(base, "/simulations/sim/turn-draft", { modelId: "ignored" });
  assert.equal(retired.status, 410);
  assert.equal(runtime.calls, 1);
});
