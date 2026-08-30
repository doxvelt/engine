import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  editAcceptedMessage,
  startBranchSimulation,
} from "../src/core/branch-kernel.ts";
import { DomainValidationError } from "../src/core/ports.ts";
import { initWorkspace } from "../src/core/init.ts";
import { createLocalApiServer } from "../src/local-api/server.ts";
import type { ActorTurnRuntime } from "../src/agent-runtime/contracts.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { exportSimulationPackage } from "../src/store/portable.ts";

async function temp(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-api-security-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, dbPath: path.join(root, "runtime.sqlite") };
}

async function apiFixture(
  t: test.TestContext,
  dbPath: string,
  allowedOrigins?: readonly string[],
  actorTurnRuntime?: ActorTurnRuntime,
) {
  const server = createLocalApiServer({
    dbPath,
    ...(allowedOrigins ? { allowedOrigins } : {}),
    ...(actorTurnRuntime ? { actorTurnRuntime } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing API address.");
  return `http://127.0.0.1:${address.port}`;
}

function jsonPost(base: string, route: string, body: unknown, origin?: string) {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("local API rejects cross-site writes and enforces JSON mutation media types", async (t) => {
  const { root, dbPath } = await temp(t);
  const base = await apiFixture(t, dbPath);
  const workspace = path.join(root, "workspace");
  await initWorkspace(workspace);
  const hostileOrigin = "https://hostile.example";
  const evilPath = path.join(workspace, "worlds", "evil.md");
  const body = JSON.stringify({
    workspacePath: workspace,
    path: "worlds/evil.md",
    text: "hostile write",
  });

  const hostilePlain = await fetch(`${base}/source/file`, {
    method: "POST",
    headers: { origin: hostileOrigin, "content-type": "text/plain" },
    body,
  });
  assert.equal(hostilePlain.status, 403);
  const hostileJson = await fetch(`${base}/source/file`, {
    method: "POST",
    headers: { origin: hostileOrigin, "content-type": "application/json" },
    body,
  });
  assert.equal(hostileJson.status, 403);
  const hostilePreflight = await fetch(`${base}/source/file`, {
    method: "OPTIONS",
    headers: {
      origin: hostileOrigin,
      "access-control-request-method": "POST",
    },
  });
  assert.equal(hostilePreflight.status, 403);
  await assert.rejects(readFile(evilPath, "utf8"), /ENOENT/);

  const allowedPlain = await fetch(`${base}/source/file`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "text/plain",
    },
    body,
  });
  assert.equal(allowedPlain.status, 415);

  const allowed = await jsonPost(
    base,
    "/source/file",
    {
      workspacePath: workspace,
      path: "worlds/allowed.md",
      text: "allowed browser write",
    },
    "http://localhost:3000",
  );
  assert.equal(allowed.status, 200);
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    "http://localhost:3000",
  );
  assert.match(allowed.headers.get("vary") || "", /Origin/i);

  const native = await jsonPost(base, "/source/file", {
    workspacePath: workspace,
    path: "worlds/native.md",
    text: "native write",
  });
  assert.equal(native.status, 200);
  assert.equal(native.headers.get("access-control-allow-origin"), null);
  assert.equal(
    await readFile(path.join(workspace, "worlds", "allowed.md"), "utf8"),
    "allowed browser write",
  );
  assert.equal(
    await readFile(path.join(workspace, "worlds", "native.md"), "utf8"),
    "native write",
  );
});

test("local API rejects caller-supplied owner scope across its surface", async (t) => {
  const { root, dbPath } = await temp(t);
  const base = await apiFixture(t, dbPath);
  const workspace = path.join(root, "workspace");
  await initWorkspace(workspace);
  const alternateStart = await jsonPost(base, "/simulations/start", {
    ownerScope: "alternate",
    simulationId: "owned",
    workspacePath: workspace,
    branchId: "main",
    commandId: "alternate-start",
  });
  assert.equal(alternateStart.status, 400);

  const started = await jsonPost(base, "/simulations/start", {
    simulationId: "owned",
    workspacePath: workspace,
    branchId: "main",
    commandId: "local-start",
  });
  assert.equal(started.status, 200);
  const startedBody = (await started.json()) as { root: { id: string } };
  const alternateRead = await fetch(
    `${base}/simulations/owned/actors?ownerScope=alternate`,
  );
  assert.equal(alternateRead.status, 400);
  const alternateMutation = await jsonPost(base, "/simulations/owned/turns", {
    ownerScope: "alternate",
    branchId: "main",
    expectedHead: startedBody.root.id,
    commandId: "alternate-turn",
    actorId: "actor",
    manualText: "forbidden",
    stageWhisperIds: [],
  });
  assert.equal(alternateMutation.status, 400);
  const exportDir = path.join(root, "alternate-export");
  const alternateExport = await jsonPost(base, "/packages/export", {
    ownerScope: "alternate",
    simulationId: "owned",
    targetDir: exportDir,
  });
  assert.equal(alternateExport.status, 400);
  await assert.rejects(readFile(exportDir, "utf8"), /ENOENT/);

  const alternateDb = path.join(root, "alternate.sqlite");
  const alternateStore = await openBranchStore(alternateDb).open();
  await startBranchSimulation(alternateStore, {
    ownerScope: "alternate",
    simulationId: "foreign-package",
    workspacePath: workspace,
    branchId: "main",
    commandId: "foreign-start",
  });
  alternateStore.close();
  const alternatePackage = path.join(root, "alternate-package");
  await exportSimulationPackage({
    dbPath: alternateDb,
    ownerScope: "alternate",
    simulationId: "foreign-package",
    targetDir: alternatePackage,
  });
  const importedSource = path.join(root, "foreign-import-source");
  const alternateImport = await jsonPost(base, "/packages/import", {
    packageDir: alternatePackage,
    targetSourceDir: importedSource,
  });
  assert.equal(alternateImport.status, 400);
  await assert.rejects(readFile(importedSource, "utf8"), /ENOENT/);

  const store = await openBranchStore(dbPath).open();
  try {
    assert.equal(store.getSimulation("alternate", "owned"), null);
    assert.equal(store.getSimulation("alternate", "foreign-package"), null);
    assert.equal(store.getSimulation("local", "owned")?.id, "owned");
    assert.equal(store.exportSimulation("local", "owned").commits.length, 1);
  } finally {
    store.close();
  }
});

async function modelServer(t: test.TestContext): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "draft",
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Snapshot-bound draft" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing model address.");
  return `http://127.0.0.1:${address.port}/v1`;
}

test("accepted API drafts consume only their captured whisper snapshot", async (t) => {
  const { root, dbPath } = await temp(t);
  const modelBaseUrl = await modelServer(t);
  const workspace = path.join(root, "workspace");
  await initWorkspace(workspace);
  await writeFile(
    path.join(workspace, "models", "snapshot.md"),
    `---\nid: snapshot\nprovider: openai-compatible\nbase_url: ${modelBaseUrl}\nmodel: test-model\n---\n`,
  );
  const runtime = new DeterministicFakeRuntime([
    { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    { type: "completed", text: "Snapshot-bound draft", stopReason: "stop" },
  ]);
  const base = await apiFixture(t, dbPath, undefined, runtime);
  const started = await jsonPost(base, "/simulations/start", {
    simulationId: "snapshot",
    workspacePath: workspace,
    branchId: "main",
    commandId: "start",
  });
  assert.equal(started.status, 200);
  const rootHead = ((await started.json()) as { root: { id: string } }).root.id;
  const stage = async (commandId: string, text: string) => {
    const response = await jsonPost(base, "/simulations/snapshot/whispers", {
      branchId: "main",
      expectedHead: rootHead,
      commandId,
      targetActorId: "actor",
      text,
    });
    assert.equal(response.status, 200);
    return (await response.json()) as { id: string };
  };
  const whisperA = await stage("whisper-a", "Whisper A");
  const draftResponse = await jsonPost(
    base,
    "/simulations/snapshot/drafts",
    {
      branchId: "main",
      expectedHead: rootHead,
      commandId: "generate-draft",
      actorId: "actor",
      stageWhisperIds: [whisperA.id],
    },
  );
  assert.equal(draftResponse.status, 200);
  const draft = (await draftResponse.json()) as {
    draft: { id: string; stageWhispers: Array<{ id: string }> };
  };
  assert.deepEqual(draft.draft.stageWhispers.map((whisper) => whisper.id), [whisperA.id]);
  const whisperB = await stage("whisper-b", "Whisper B");
  const setupStore = await openBranchStore(dbPath).open();
  const foreignActorWhisper = setupStore.createStageWhisper({
    ownerScope: "local",
    simulationId: "snapshot",
    branchId: "main",
    expectedHead: rootHead,
    commandId: "foreign-actor-whisper",
    targetActorId: "other-actor",
    text: "Foreign actor direction",
  });
  setupStore.createBranch({
    ownerScope: "local",
    simulationId: "snapshot",
    sourceBranchId: "main",
    expectedHead: rootHead,
    branchId: "foreign-branch",
    atCommitId: rootHead,
    commandId: "foreign-branch",
  });
  const foreignBranchWhisper = setupStore.createStageWhisper({
    ownerScope: "local",
    simulationId: "snapshot",
    branchId: "foreign-branch",
    expectedHead: rootHead,
    commandId: "foreign-branch-whisper",
    targetActorId: "actor",
    text: "Foreign branch direction",
  });
  setupStore.close();
  const invalidSnapshot = await jsonPost(base, "/simulations/snapshot/drafts", {
    branchId: "main",
    expectedHead: rootHead,
    commandId: "invalid-snapshot",
    actorId: "actor",
    stageWhisperIds: ["missing-whisper"],
  });
  assert.equal(invalidSnapshot.status, 400);
  assert.equal(runtime.calls, 1);
  const acceptedResponse = await jsonPost(
    base,
    `/simulations/snapshot/drafts/${draft.draft.id}/accept`,
    { commandId: "accept-draft" },
  );
  assert.equal(acceptedResponse.status, 200);
  const accepted = (await acceptedResponse.json()) as {
    commit: { id: string; events: Array<{ type: string; whisperId?: string }> };
  };
  const consumed = accepted.commit.events
    .filter((event) => event.type === "stage_whisper_consumed")
    .map((event) => event.whisperId);
  assert.deepEqual(consumed, [whisperA.id]);

  const store = await openBranchStore(dbPath).open();
  try {
    const pendingAtDraftHead = store.listPendingStageWhispers(
      "local",
      "snapshot",
      "main",
      rootHead,
      "actor",
    );
    assert.ok(pendingAtDraftHead.some((whisper) => whisper.id === whisperB.id));
    const wrongHeadWhisper = store.createStageWhisper({
      ownerScope: "local",
      simulationId: "snapshot",
      branchId: "main",
      expectedHead: accepted.commit.id,
      commandId: "wrong-head-whisper",
      targetActorId: "actor",
      text: "Later direction",
    });
    for (const [label, stageWhisperIds] of [
      ["missing", ["missing-whisper"]],
      ["duplicate", [whisperB.id, whisperB.id]],
      ["foreign-actor", [foreignActorWhisper.id]],
      ["foreign-branch", [foreignBranchWhisper.id]],
      ["wrong-head", [wrongHeadWhisper.id]],
    ] as const) {
      assert.throws(
        () =>
          editAcceptedMessage(store, {
            ownerScope: "local",
            simulationId: "snapshot",
            sourceBranchId: "main",
            expectedHead: accepted.commit.id,
            sourceCommitId: accepted.commit.id,
            branchId: `invalid-${label}`,
            commandId: `invalid-${label}`,
            payload: {
              actorId: "actor",
              text: "Invalid alternative",
              audience: [],
              stageWhisperIds: [...stageWhisperIds],
            },
          }),
        DomainValidationError,
      );
      assert.equal(
        store.getBranch("local", "snapshot", `invalid-${label}`),
        null,
      );
    }
    const alternative = editAcceptedMessage(store, {
      ownerScope: "local",
      simulationId: "snapshot",
      sourceBranchId: "main",
      expectedHead: accepted.commit.id,
      sourceCommitId: accepted.commit.id,
      branchId: "alternative",
      commandId: "alternative-with-b",
      payload: {
        actorId: "actor",
        text: "Alternative response",
        audience: [],
        stageWhisperIds: [whisperB.id],
      },
    });
    assert.deepEqual(
      alternative.commit.events
        .filter((event) => event.type === "stage_whisper_consumed")
        .map((event) => event.whisperId),
      [whisperB.id],
    );
  } finally {
    store.close();
  }
});
