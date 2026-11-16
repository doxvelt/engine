import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalApiServer } from "../src/local-api/server.ts";
import { once } from "node:events";

const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-native-startup-"));
const server = createLocalApiServer({ dbPath: path.join(root, "runtime.sqlite") });
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address()!.port}`;
  assert.deepEqual(await (await fetch(origin + "/health")).json(), { ok: true });
  const runtime = await (await fetch(origin + "/runtime")).json();
  assert.equal(runtime.configured, false);
  assert.equal((await fetch(origin + "/simulations/start", { method: "POST", body: "{}" })).status, 415);
  assert.equal((await fetch(origin + "/health", { headers: { origin: "https://untrusted.invalid" } })).status, 403);
  const child = spawn(process.execPath, ["scripts/dev.js", "--help"], { windowsHide: true, stdio: "pipe" });
  let text = ""; child.stdout.on("data", bytes => { text += String(bytes); });
  assert.equal((await once(child, "close"))[0], 0);
  assert.match(text, /DSH/);
  console.log("Native API startup, manual mode, request boundary, and DSH launch help verified.");
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
