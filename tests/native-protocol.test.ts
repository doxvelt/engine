import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalApiServer } from "../src/local-api/server.ts";

test("invalid Unicode in workspace payloads is rejected before sending and valid text still works", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "doxvelt-protocol-"));
  const server = createLocalApiServer({});
  try {
    await server.workspace(root, "activate");
    const object = { kind: "world", id: "river", name: "River", body: "PRIVATE\ud800" };
    await assert.rejects(server.workspace(root, "source.create", object), error => /well-formed Unicode/.test(String(error)) && !String(error).includes("PRIVATE"));
    await assert.rejects(server.workspace(root, "source.create", { ...object, body: "Valid", ["\ud800"]: "value" }), /well-formed Unicode/);
    await server.workspace(root, "source.create", { ...object, body: "A river 🌊 with a literal escape \\ud800." });
    assert.match(await readFile(path.join(root, "worlds/river.md"), "utf8"), /A river 🌊 with a literal escape \\ud800/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid Unicode in a callback returns a correlated failure and leaves the bridge usable", { timeout: 10_000 }, async () => {
  let invalid = true;
  const server = createLocalApiServer({ runtimeDiagnostic: () => invalid ? "\ud800" : null });
  try {
    server.listen(); await once(server, "listening");
    const url = `http://127.0.0.1:${server.address()!.port}/runtime`;
    const failed = await fetch(url, { signal: AbortSignal.timeout(3000) });
    assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /ud800/);
    invalid = false;
    const recovered = await fetch(url, { signal: AbortSignal.timeout(3000) });
    assert.equal(recovered.status, 200); await recovered.json();
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("an id-less native error rejects every pending caller instead of hanging", { timeout: 10_000 }, async t => {
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", () => spawn(process.execPath, ["-e", 'process.stdin.once("data",()=>process.stdout.write(JSON.stringify({error:{code:"INVALID_JSON"}})+"\\n")); process.stdin.resume();'], { stdio: "pipe", windowsHide: true }));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const server = createLocalApiServer({});
  try {
    const calls = [server.workspace("unused", "activate"), server.workspace("unused", "collection")];
    for (const result of await Promise.allSettled(calls)) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.match(String(result.reason), /rejected a protocol envelope/);
    }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
