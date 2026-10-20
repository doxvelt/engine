/** Optional live acceptance harness. Uses actual bun run dev + API + Nuxt and a localhost fixture, never a real model. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createPortProbe } from "node:net";
import { mkdtemp, writeFile, readFile, readdir, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { LOCAL_OPENAI_COMPATIBLE_KEYLESS_TRANSPORT_KEY } from "../src/agent-runtime/local-openai-compatible.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-39-live-"));
const configFile = path.join(root, "inference.json");
const dbPath = path.join(root, "runtime.sqlite");
const secret = "TEST_ONLY_DOXVELT_39_SECRET_SENTINEL";
const override = "TEST_ONLY_DOXVELT_39_ENV_SENTINEL";
const modelId = "fixture/model:Q4_K_M";
const apiPort = await freePort();
let uiPort = await freePort();
while (uiPort === apiPort) uiPort = await freePort();
const base = `http://127.0.0.1:${apiPort}`;
let expectedKey = secret;
let calls = 0;
let badAuth = false;
const upstream = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    calls++;
    try {
      assert.equal(request.headers.authorization, `Bearer ${expectedKey}`);
      assert.equal(JSON.parse(body).model, modelId, "model ID must reach fixture exactly");
      assert.ok(!body.includes(secret) && !body.includes(override));
      if (badAuth) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `Unauthorized ${secret} ${override}` } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const text = JSON.stringify({ text: "Deterministic fixture performance.", audience: ["ceo", "cfo"] });
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch { response.writeHead(400); response.end("Fixture request assertion failed."); }
  });
});
let launch: ChildProcess | undefined;
let exited: Promise<number | null> | undefined;
const logs: string[] = [];
const childPids: number[] = [];
const fixtureReady = new Promise<void>((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(0, "127.0.0.1", resolve);
});
try {
  await fixtureReady;
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const config = { baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId, contextWindow: 8192, maxTokens: 256, apiKey: secret };
  await writeFile(configFile, "{}\n", { mode: 0o600 });
  const occupied = createPortProbe();
  await new Promise<void>((resolve, reject) => { occupied.once("error", reject); occupied.listen(uiPort, "127.0.0.1", resolve); });
  try {
    const blocked = spawn("bun", ["run", "dev", "--", "--runtime-config", configFile, "--port", String(apiPort), "--ui-port", String(uiPort)], { stdio: "ignore" });
    if (blocked.pid) childPids.push(blocked.pid);
    const blockedExit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { blocked.kill(); reject(new Error("Occupied-port startup did not fail promptly")); }, 5000);
      blocked.once("exit", code => { clearTimeout(timer); resolve(code); });
      blocked.once("error", error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(blockedExit, 1);
    assert.equal(occupied.listening, true, "unrelated port owner must remain alive");
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  console.log("PASS occupied UI port fails without stopping the unrelated listener");
  await start();
  assert.equal((await request("/runtime")).configured, false);
  const started = await request("/simulations/start", { simulationId: "startup-fixture", workspacePath: path.resolve("examples/executive-interviews"), scenarioId: "executive-interviews", branchId: "main", commandId: "start" });
  let head = started.root.id;
  const manual = await request("/simulations/startup-fixture/turns", { branchId: "main", expectedHead: head, commandId: "manual", actorId: "ceo", audience: ["cfo"], stageWhisperIds: [], manualText: "Manual play needs no runtime.", knowledgePolicy: "actor-knowledge-v1" });
  assert.ok(manual.commit.id);
  head = manual.commit.id;
  await stop("SIGINT");
  console.log("PASS unconfigured manual play, actual UI, SIGINT shutdown");

  await writeFile(configFile, JSON.stringify(config));
  await start();
  const draft = await generate("authenticated", head);
  assert.equal(draft.status, "ready");
  await stop("SIGTERM");
  await start();
  const recovered = await request(`/simulations/startup-fixture/drafts/${draft.id}`);
  assert.equal(recovered.id, draft.id);
  assert.equal((await generate("after-restart", head)).status, "ready");
  await stop("SIGTERM");
  console.log("PASS file authentication, restart recovery and generation, SIGTERM shutdown");

  expectedKey = override;
  await start(override);
  assert.equal((await generate("env-override", head)).status, "ready");
  badAuth = true;
  assert.equal((await generate("bad-auth", head)).status, "failed");
  assert.match((await request("/runtime")).diagnostic, /authentication failed/);
  badAuth = false;
  await stop("SIGTERM");
  expectedKey = LOCAL_OPENAI_COMPATIBLE_KEYLESS_TRANSPORT_KEY;
  await start("");
  assert.equal((await generate("keyless-env", head)).status, "ready");
  await stop("SIGTERM");
  const { apiKey: _key, ...keyless } = config;
  await writeFile(configFile, JSON.stringify(keyless));
  await start();
  assert.equal((await generate("keyless-file", head)).status, "ready");
  await stop("SIGTERM");
  console.log("PASS environment override, empty override, keyless file and safe bad-auth diagnostics");

  await new Promise<void>(resolve => upstream.close(() => resolve()));
  await start();
  assert.equal((await generate("unavailable", head)).status, "failed");
  assert.match((await request("/runtime")).diagnostic, /unavailable/);
  await stop("SIGTERM");
  const store = await openBranchStore(dbPath).open();
  try {
    const archive = store.exportSimulation("local", "startup-fixture");
    clean(JSON.stringify(archive));
    assert.ok(!JSON.stringify(archive).includes(configFile));
    assert.ok(!JSON.stringify(archive).includes(config.baseUrl));
    await writeFile(path.join(root, "portable-archive.json"), JSON.stringify(archive));
  } finally { store.close(); }
  for (const log of logs) clean(await readFile(log, "utf8"));
  await scanAssets(path.resolve("src/local-ui/.output/public"));
  console.log(`PASS unavailable diagnostics, durable failures/archive/assets/log secret exclusion; fixture requests=${calls}`);
  console.log(`Evidence directory: ${root}`);
} finally {
  await stop("SIGTERM");
  upstream.closeAllConnections();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  await writeFile(path.join(root, "child-pids.json"), JSON.stringify(childPids));
}

async function freePort(): Promise<number> {
  const server = createPortProbe();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
async function start(key?: string) {
  const logFile = path.join(root, `launch-${logs.length}.log`);
  logs.push(logFile);
  const log = await open(logFile, "wx", 0o600);
  const env = { ...process.env };
  delete env.DOXVELT_RUNTIME_API_KEY;
  delete env.NODE_TEST_CONTEXT;
  if (key !== undefined) env.DOXVELT_RUNTIME_API_KEY = key;
  launch = spawn("bun", ["run", "dev", "--", "--runtime-config", configFile, "--db", dbPath, "--port", String(apiPort), "--ui-port", String(uiPort)], { env, stdio: ["ignore", log.fd, log.fd] });
  exited = new Promise(resolve => { launch!.once("error", () => resolve(1)); launch!.once("exit", resolve); });
  if (launch.pid) childPids.push(launch.pid);
  await log.close();
  const until = Date.now() + 90_000;
  while (true) {
    if (launch.exitCode !== null) throw new Error(`Actual bun run dev exited; inspect ${logFile}`);
    try {
      const status = await fetch(base + "/runtime", { signal: AbortSignal.timeout(2000) });
      const ui = await fetch(`http://127.0.0.1:${uiPort}/`, { signal: AbortSignal.timeout(3000) });
      clean(await ui.text());
      if (status.ok && ui.ok) break;
    } catch { /* Startup in progress. */ }
    if (Date.now() > until) throw new Error(`Actual dev startup timed out; inspect ${logFile}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const logText = await readFile(logFile, "utf8");
  const pids = /API (\d+), UI (\d+)/.exec(logText);
  assert.ok(pids, "launcher must record real child PIDs");
  childPids.push(Number(pids[1]), Number(pids[2]));
  if (process.platform === "linux") {
    const uiEnv = await readFile(`/proc/${pids[2]}/environ`, "utf8");
    clean(uiEnv);
    assert.ok(!uiEnv.includes("DOXVELT_RUNTIME_API_KEY="));
  }
}
async function stop(signal: NodeJS.Signals) {
  if (!launch) return;
  const child = launch;
  launch = undefined;
  child.kill(signal);
  await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Launcher did not stop within 8 seconds")), 8000); timer.unref(); })]);
  for (const pid of childPids) assert.throws(() => process.kill(pid, 0), "started process must be gone");
}
function clean(text: string) {
  assert.ok(!text.includes(secret) && !text.includes(override), "Secret sentinel escaped server configuration");
}
async function request(route: string, body?: unknown): Promise<any> {
  const response = await fetch(base + route, { ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  clean(text);
  assert.equal(response.status, 200, "API request must succeed");
  return JSON.parse(text);
}
async function generate(commandId: string, expectedHead: string) {
  return (await request("/simulations/startup-fixture/drafts", { branchId: "main", commandId, expectedHead, actorId: "ceo", audience: ["cfo"], draftingPolicy: "actor-knowledge-v1", completeWhisper: "Respond briefly to the CFO." })).draft;
}
async function scanAssets(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await scanAssets(file);
    else clean(await readFile(file, "utf8"));
  }
}
