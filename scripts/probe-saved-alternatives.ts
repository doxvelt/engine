/** Real HTTP + process/SQLite restart + logical package import/export probe.
 * Run with Node24: node scripts/probe-saved-alternatives.ts
 * No model/network dependency beyond the loopback API socket. */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { fork } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalApiServer } from "../src/local-api/server.ts";
import type { ActorTurnRuntime } from "../src/agent-runtime/contracts.ts";

const filename = fileURLToPath(import.meta.url);
if (process.argv[2] === "--serve") {
  const dbPath = process.argv[3]!, countFile = process.argv[4]!;
  const runtime = probeRuntime(countFile);
  const server = createLocalApiServer({ dbPath, actorTurnRuntime: runtime });
  server.once("error", error => { process.send?.({ error: `${error.name}: ${error.message}` }); process.exitCode = 1; process.disconnect?.(); });
  server.listen(0, "127.0.0.1", () => { const address = server.address(); if (address && typeof address !== "string") process.send?.({ port: address.port }); });
  process.on("message", message => { if (message === "stop") server.close(() => { process.disconnect?.(); }); });
} else if (path.resolve(process.argv[1] || "") === filename) {
  await runSavedAlternativeProbe(process.argv[2] === "--in-process");
}

function probeRuntime(countFile: string): ActorTurnRuntime {
  return { identity: { id: "probe-deterministic", version: "v1" }, async *runActorTurn(request) {
    await appendFile(countFile, "call\n");
    if (request.prompt.includes("PROBE-FAIL")) { yield { type: "failed", stopReason: "error" }; return; }
    const text = request.outputSchema.id === "audience-proposal" ? JSON.stringify({ text: "Probe performance", audience: ["ceo"] }) : "Legacy probe performance";
    yield { type: "completed", text, stopReason: "stop" };
  } };
}

export async function runSavedAlternativeProbe(inProcess = false) {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(path.resolve(".scratch/http-alternatives-"));
  const db = path.join(root, "original.sqlite"), count = path.join(root, "provider-calls.txt");
  let api = await start(db, count, inProcess);
  try {
    const started = await api.post("/simulations/start", { simulationId: "sim", branchId: "main", commandId: "start", workspacePath: path.resolve("examples/executive-interviews"), scenarioId: "executive-interviews" });
    const head = started.root.id;
    const whisper = await api.post("/simulations/sim/whispers", { commandId: "whisper", branchId: "main", expectedHead: head, targetActorId: "ceo", text: "EXACT-ORIGIN" });
    const legacy = await api.post("/simulations/sim/drafts", { commandId: "legacy", branchId: "main", expectedHead: head, actorId: "ceo", audience: ["ceo"], stageWhisperIds: [whisper.id] });
    assertDraft(legacy.draft);
    assertDraft(await api.get(`/simulations/sim/drafts/${legacy.draft.id}`));
    const retry = await api.post(`/simulations/sim/drafts/${legacy.draft.id}/retry`, { commandId: "legacy-retry" }); assertDraft(retry.draft);
    const discarded = await api.post(`/simulations/sim/drafts/${retry.draft.id}/discard`, { commandId: "legacy-discard" }); assertDraft(discarded.draft);
    for (const draft of (await api.get("/simulations/sim/drafts?branchId=main")).drafts) assertDraft(draft);
    const accepted = await api.post(`/simulations/sim/drafts/${legacy.draft.id}/accept`, { commandId: "accept" });
    assert.deepEqual(Object.keys(accepted).sort(), ["branch", "commit", "replayed"]);
    assert.deepEqual(Object.keys(accepted.commit), ["id"]);
    const transcript = await api.get("/simulations/sim/transcript");
    const turn = transcript.transcript[0];
    const selection = { sourceBranchId: "main", expectedHead: accepted.commit.id, sourceCommitId: turn.commitId,
      messageVersionId: turn.messageVersionId, logicalMessageId: turn.logicalMessageId, actorId: "ceo" };
    const origin = await api.post("/simulations/sim/alternatives/origin", selection);
    assert.equal(origin.completeWhisper, "EXACT-ORIGIN");
    assert.deepEqual(Object.keys(origin).sort(), ["completeWhisper", "kind", "legacyCorrection", "recordedWhispers", "state"]);
    const request = { ...selection, commandId: "historical", action: "generate", audience: ["ceo"], completeWhisper: "REPLACEMENT-ONLY" };
    const saved = await api.post("/simulations/sim/alternatives", request); assertOperation(saved.operation);
    assert.equal(saved.operation.status, "saved");
    const failed = await api.post("/simulations/sim/alternatives", { ...request, commandId: "failed", completeWhisper: "PROBE-FAIL" });
    assertOperation(failed.operation); assert.equal(failed.operation.status, "failed");
    const failedRetry = await api.post(`/simulations/sim/alternatives/${failed.operation.id}/retry`, { commandId: "failed-retry" });
    assertOperation(failedRetry.operation); assert.equal(failedRetry.operation.status, "failed");
    assertOperation(await api.post(`/simulations/sim/alternatives/${failedRetry.operation.id}/discard`, {}));
    assertOperation(await api.get(`/simulations/sim/alternatives/${saved.operation.id}`));
    const discovery = await api.get(`/simulations/sim/alternatives?${new URLSearchParams(selection)}`);
    assert.equal(discovery.paths.length, 2); for (const op of discovery.operations) assertOperation(op, false);
    const failWhisper = await api.post("/simulations/sim/whispers", { commandId: "legacy-fail-input", branchId: "main", expectedHead: accepted.commit.id, targetActorId: "ceo", text: "PROBE-FAIL" });
    const legacyFailure = await api.post("/simulations/sim/drafts", { commandId: "legacy-failure", branchId: "main", expectedHead: accepted.commit.id, actorId: "ceo", audience: ["ceo"], stageWhisperIds: [failWhisper.id] });
    assertDraft(legacyFailure.draft); assert.equal(legacyFailure.draft.status, "failed");
    const callsBeforeRestart = await readFile(count, "utf8");
    await api.stop(); api = await start(db, count, inProcess);
    const replay = await api.post("/simulations/sim/alternatives", request);
    assert.equal(replay.replayed, true); assertOperation(replay.operation);
    assert.equal(await readFile(count, "utf8"), callsBeforeRestart);
    const packageDir = path.join(root, "package");
    await api.post("/packages/export", { simulationId: "sim", targetDir: packageDir });
    const importedDb = path.join(root, "imported.sqlite");
    await api.post("/packages/import", { packageDir, targetSourceDir: path.join(root, "source"), targetDbPath: importedDb });
    await api.stop(); api = await start(importedDb, count, inProcess);
    const portableReplay = await api.post("/simulations/sim/alternatives", request);
    assert.equal(portableReplay.replayed, true); assert.deepEqual(portableReplay.operation.outcome, saved.operation.outcome);
    assert.equal(await readFile(count, "utf8"), callsBeforeRestart);
    assert.equal((await api.post("/simulations/sim/alternatives/origin", selection)).completeWhisper, "EXACT-ORIGIN");
    const acceptedReplay = await api.post(`/simulations/sim/drafts/${legacy.draft.id}/accept`, { commandId: "accept" });
    assert.equal(acceptedReplay.replayed, true); assert.deepEqual(acceptedReplay.commit, accepted.commit);
    const all = await api.get("/simulations/sim/alternatives");
    assert.equal(all.operations.length, 1, "Only accepted operations travel in archive");
    console.log(`PASS ${inProcess ? "serialized handler (no socket/process-restart claim)" : "real HTTP, process/SQLite restart"}, export/import and exact provider-free replay: ${root}`);
  } finally { await api.stop(); }
}

function noRawFields(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!["prompt", "context", "promptHash", "contextHash", "stageWhispers", "payload", "request", "commandResults"].includes(key), key);
    noRawFields(child);
  }
}
function assertOperation(value: Record<string, unknown>, detail = true) {
  noRawFields(value);
  assert.deepEqual(Object.keys(value).sort(), ["id", "commandId", "sourceBranchId", "expectedHead", "sourceCommitId", "messageVersionId", "logicalMessageId", "actorId", "action", "retryOf", "parentCommitId", "status", "failure", "outcome", "createdAt", "updatedAt", ...(detail ? ["review"] : [])].sort());
  if (!detail) assert.ok(!JSON.stringify(value).includes("REPLACEMENT-ONLY"));
  else assert.deepEqual(Object.keys(value.review as object).sort(), ["attribution", "audience", "completeWhisper", "runtime", "text"]);
}
function assertDraft(value: Record<string, unknown>) {
  noRawFields(value);
  assert.deepEqual(Object.keys(value).sort(), ["id", "branchId", "basisHeadCommitId", "actorId", "audience", "status", "artifact", "failure", "createdAt", "generationCommandId"].sort());
  assert.ok(!JSON.stringify(value).includes("EXACT-ORIGIN"));
  for (const field of ["prompt", "context", "stageWhispers", "routing", "receipt"]) assert.ok(!(field in value));
}
async function start(db: string, count: string, inProcess: boolean) {
  if (inProcess) {
    // Exercise real handler JSON serialization without claiming socket/process evidence.
    const server = createLocalApiServer({ dbPath: db, actorTurnRuntime: probeRuntime(count) });
    const call = async (route: string, body?: unknown) => new Promise<any>(resolve => {
      const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
        method: body === undefined ? "GET" : "POST", url: route, headers: { "content-type": "application/json" },
      });
      let status = 0;
      const response = { setHeader() {}, writeHead(value: number) { status = value; }, end(bytes: string) {
        resolve({ status, json: JSON.parse(bytes) });
      } };
      server.emit("request", request, response);
    });
    const checked = async (route: string, body?: unknown) => { const response = await call(route, body); assert.equal(response.status, 200, JSON.stringify(response.json)); return response.json; };
    return { post: (route: string, body: unknown) => checked(route, body), get: (route: string) => checked(route), stop: async () => {} };
  }
  const child = fork(filename, ["--serve", db, count], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr?.on("data", chunk => { stderr += String(chunk); });
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => { reject(new Error(`Probe API exited ${code}: ${stderr}`)); });
    child.once("message", message => {
      const result = message as { port?: number; error?: string };
      if (result.error) reject(new Error(`Loopback probe blocked: ${result.error}`));
      else if (result.port) resolve(result.port);
      else reject(new Error("Probe API returned no port."));
    });
  });
  const call = async (route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json(); assert.equal(response.status, 200, JSON.stringify(json)); return json;
  };
  let stopped = false;
  return { post: (route: string, body: unknown) => call(route, body), get: (route: string) => call(route), stop: async () => {
    if (stopped) return; stopped = true;
    await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.send("stop"); });
  } };
}
