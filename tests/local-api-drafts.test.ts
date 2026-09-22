import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const { base, dbPath } = await fixture(t, runtime);
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
  assert.deepEqual(Object.keys(acceptedResult.commit), ["id"]);
  const inspection = await openBranchStore(dbPath).open();
  const acceptedMessage = inspection.getCommit("local", "sim", acceptedResult.commit.id)!.events.find(
    event => event.type === "message_accepted",
  )?.message;
  inspection.close();
  assert.equal(acceptedMessage?.text, "Edited final");
  assert.equal(acceptedMessage?.provenance.mode, "generated");
  if (acceptedMessage?.provenance.mode !== "generated") throw new Error("Missing generated provenance.");
  assert.equal(acceptedMessage.provenance.finalTextSource, "acceptor_edited");
  assert.ok(acceptedMessage.provenance.sourceArtifactDigest);
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


test("Stage discovery is branch scoped, deterministic and durable without a browser pointer", async (t) => {
  const { base, dbPath } = await fixture(t, new DeterministicFakeRuntime([
    { type: "completed", text: "A draft.", stopReason: "stop" },
  ]));
  const start = await started(base);
  const drafts = [];
  for (const command of ["first", "second"]) {
    const response = await post(base, "/simulations/sim/drafts", generate(start.root.id, command));
    drafts.push((await response.json()).draft);
  }
  const discover = await fetch(`${base}/simulations/sim/drafts?branchId=main`);
  assert.equal(discover.status, 200);
  assert.deepEqual((await discover.json()).drafts.map((draft: { id: string }) => draft.id), drafts.map(draft => draft.id));
  for (const route of ["/simulations/sim/drafts?branchId=wrong", "/simulations/wrong/drafts?branchId=main"])
    assert.equal((await fetch(base + route)).status, 404);
  const reopened = await openBranchStore(dbPath).open();
  try {
    assert.deepEqual(reopened.listRecoverableActorTurnDrafts("wrong", "sim", "main"), []);
    assert.deepEqual(reopened.listRecoverableActorTurnDrafts("local", "sim", "wrong"), []);
    assert.equal(reopened.listRecoverableActorTurnDrafts("local", "sim", "main").length, 2);
  } finally { reopened.close(); }
  await post(base, `/simulations/sim/drafts/${drafts[0].id}/discard`, { commandId: "discard-first" });
  await post(base, `/simulations/sim/drafts/${drafts[1].id}/accept`, { commandId: "accept-second" });
  assert.deepEqual((await (await fetch(`${base}/simulations/sim/drafts?branchId=main`)).json()).drafts, []);
});

test("authored stateless actors own restricted first and later turns through Perform and Direct", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-scene-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(workspace, root, { recursive: true });
  await mkdir(path.join(root, "entities", "scene"));
  await writeFile(path.join(root, "entities", "scene", "IDENTITY.md"), "---\nid: scene\nname: Scene\nkind: stateless\nvisibility: public\n---\nAn authored scene-setting actor.\n");
  const runtime = new DeterministicFakeRuntime([
    { type: "completed", text: "The room falls quiet.", stopReason: "stop" },
  ], request => {
    assert.equal(request.actorId, "scene");
    assert.doesNotMatch(request.prompt, /operations team is hiding|may replace @ceo/);
  });
  const { base } = await fixture(t, runtime);
  for (const firstMode of ["manual", "generated"]) {
    const sim = `scene-${firstMode}`;
    const start = await post(base, "/simulations/start", { simulationId: sim, workspacePath: root, scenarioId: "executive-interviews", branchId: "main", commandId: "start" });
    assert.equal(start.status, 200);
    let head = (await start.json()).root.id;
    for (const mode of [firstMode, firstMode === "manual" ? "generated" : "manual"]) {
      const input = { branchId: "main", expectedHead: head, commandId: mode, actorId: "scene", audience: ["cfo"], stageWhisperIds: [] };
      if (mode === "manual") {
        const body = { ...input, manualText: "A chair scrapes the floor." };
        const response = await post(base, `/simulations/${sim}/turns`, body);
        assert.equal(response.status, 200);
        const replay = await post(base, `/simulations/${sim}/turns`, body);
        assert.equal(replay.status, 200, "lost manual response must replay after the head advanced");
        assert.equal((await replay.json()).replayed, true);
      } else {
        const before = await (await fetch(`${base}/simulations/${sim}/transcript`)).json();
        const response = await post(base, `/simulations/${sim}/drafts`, input);
        assert.equal(response.status, 200);
        const draft = (await response.json()).draft;
        assert.equal(draft.status, "ready");
        assert.deepEqual((await (await fetch(`${base}/simulations/${sim}/transcript`)).json()).transcript, before.transcript);
        assert.equal((await post(base, `/simulations/${sim}/drafts/${draft.id}/accept`, { commandId: "accept" })).status, 200);
      }
      const projection = await (await fetch(`${base}/simulations/${sim}/transcript`)).json();
      head = projection.branch.headCommitId;
      assert.equal(projection.transcript.at(-1).actorId, "scene");
      assert.deepEqual(projection.transcript.at(-1).audience.toSorted(), ["cfo", "scene"]);
      const excluded = await (await fetch(`${base}/simulations/${sim}/context/ceo`)).json();
      assert.equal(excluded.subjective.transcript.length, 0);
    }
    assert.equal((await (await fetch(`${base}/simulations/${sim}/transcript`)).json()).transcript.length, 2);
  }
});

test("Stage retry captures original routing and whispers; failed drafts can be dismissed", async (t) => {
  let fail = false;
  const runtime: ActorTurnRuntime = {
    identity: { id: "deterministic-test", version: "1" },
    async *runActorTurn(request) {
      assert.equal(request.actorId, "ceo");
      assert.match(request.prompt, /Keep the answer brief/);
      if (fail) throw new Error("deliberate runtime failure");
      yield { type: "completed", text: "A measured answer.", stopReason: "stop" };
    },
  };
  const { base, dbPath } = await fixture(t, runtime);
  const start = await started(base);
  const whisper = await (await post(base, "/simulations/sim/whispers", { branchId: "main", expectedHead: start.root.id, commandId: "whisper", targetActorId: "ceo", text: "Keep the answer brief" })).json();
  const original = (await (await post(base, "/simulations/sim/drafts", { ...generate(start.root.id), stageWhisperIds: [whisper.id] })).json()).draft;
  const response = await post(base, `/simulations/sim/drafts/${original.id}/retry`, { commandId: "retry" });
  assert.equal(response.status, 200);
  const candidate = (await response.json()).draft;
  assert.notEqual(candidate.id, original.id);
  assert.deepEqual(candidate.audience, original.audience);
  assert.ok(!Object.hasOwn(candidate, "stageWhispers"));
  assert.ok(!Object.hasOwn(original, "stageWhispers"));
  const inspection = await openBranchStore(dbPath).open();
  assert.deepEqual(inspection.getActorTurnDraft("local", "sim", candidate.id)!.stageWhispers,
    inspection.getActorTurnDraft("local", "sim", original.id)!.stageWhispers);
  inspection.close();
  const replay = await post(base, `/simulations/sim/drafts/${original.id}/retry`, { commandId: "retry" });
  assert.equal((await replay.json()).draft.id, candidate.id);
  const rejected = await post(base, `/simulations/sim/drafts/${original.id}/retry`, { commandId: "bad", actorId: "coo" });
  assert.equal(rejected.status, 400);
  fail = true;
  const failed = (await (await post(base, `/simulations/sim/drafts/${original.id}/retry`, { commandId: "fail" })).json()).draft;
  assert.equal(failed.status, "failed");
  assert.equal((await post(base, `/simulations/sim/drafts/${failed.id}/discard`, { commandId: "dismiss" })).status, 200);
  const state = await (await fetch(`${base}/simulations/sim/stage?branchId=main`)).json();
  assert.equal(state.scenarioName, "Executive Interviews");
  assert.deepEqual(state.transcript, []);
  assert.equal(JSON.stringify(state).includes("operations team is hiding"), false);
  assert.ok(state.actors.every((actor: object) => Object.keys(actor).toSorted().join() === "id,kind,name"));
});

test("draft discovery survives API restart with ready, failed and in-progress records", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-stage-restart-"));
  const dbPath = path.join(root, "runtime.sqlite");
  let finish: () => void = () => {};
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let mode = "ready";
  const runtime: ActorTurnRuntime = {
    identity: { id: "restart-test", version: "1" },
    async *runActorTurn() {
      if (mode === "failed") throw new Error("Deliberate failure");
      if (mode === "waiting") await waiting;
      yield { type: "completed", text: "Saved result", stopReason: "stop" };
    },
  };
  let server = createLocalApiServer({ dbPath, actorTurnRuntime: runtime });
  const listen = async () => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  let base = await listen();
  t.after(async () => { finish(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const start = await started(base);
  await post(base, "/simulations/sim/drafts", generate(start.root.id, "ready"));
  mode = "failed";
  await post(base, "/simulations/sim/drafts", generate(start.root.id, "failed"));
  mode = "waiting";
  const inProgress = post(base, "/simulations/sim/drafts", generate(start.root.id, "waiting")).catch(() => null);
  let snapshot: { drafts: { id: string; status: string }[] } = { drafts: [] };
  for (let attempt = 0; attempt < 50; attempt++) {
    snapshot = await (await fetch(`${base}/simulations/sim/drafts?branchId=main`)).json();
    if (snapshot.drafts.length === 3) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(snapshot.drafts.map(draft => draft.status), ["ready", "failed", "generating"]);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  server = createLocalApiServer({ dbPath, actorTurnRuntime: runtime });
  base = await listen();
  const recovered = await (await fetch(`${base}/simulations/sim/drafts?branchId=main`)).json();
  assert.deepEqual(recovered, snapshot);
  // A restarted API can discard stranded work without adding canonical events.
  const pending = snapshot.drafts.find(draft => draft.status === "generating")!;
  assert.equal((await post(base, `/simulations/sim/drafts/${pending.id}/discard`, { commandId: "discard-stranded" })).status, 200);
  finish(); await inProgress;
  assert.deepEqual((await (await fetch(`${base}/simulations/sim/transcript`)).json()).transcript, []);
});
