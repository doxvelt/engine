import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// @ts-expect-error The DSH host is a native JavaScript plugin, also loaded by Electron.
import { applyWorkspaceHost, registeredSessionWorkspace } from "../scripts/dsh-gui-spike/workspace-host.mjs";

type Event = { type: string; data: Record<string, unknown> };
function session(id: string, cwd: string) {
  const events: Event[] = [];
  return { id, header: { cwd }, get seq() { return events.length; },
    append(type: string, data: Record<string, unknown>) { events.push({ type, data }); },
    eventAt(index: number) { return events[index]!; } };
}

test("missing registered workspace folders do not block live workspaces or authorize unregistered chats", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-host-registry-"));
  const missing = path.join(root, "missing");
  const ctx = { workspaceRegistry: { list: () => [{ path: missing }, { path: root }] } };
  assert.equal(await registeredSessionWorkspace(ctx, session("live", root)), await realpath(root));
  await assert.rejects(registeredSessionWorkspace({ workspaceRegistry: { list: () => [{ path: missing }] } },
    session("unregistered", root)), { code: "workspace-unregistered" });
  await assert.rejects(registeredSessionWorkspace(ctx, session("missing", missing)), { code: "ENOENT" });
});

test("desktop host scopes activation and source writes to registered chat workspaces and leaves authoring alone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-host-"));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), "doxvelt-host-other-"));
  const unregistered = await mkdtemp(path.join(os.tmpdir(), "doxvelt-host-unregistered-"));
  const chats = new Map([["author", session("author", root)], ["episode", session("episode", root)],
    ["other", session("other", elsewhere)], ["unregistered", session("unregistered", unregistered)]]);
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  let endpoint: (request: Request) => Promise<Response> = async () => { throw new Error("Host not mounted"); };
  const ctx = {
    get() { return undefined; },
    on(name: string, callback: (...args: unknown[]) => unknown) { listeners.set(name, callback); },
    connection: { fetch: { register(config: { fetch: typeof endpoint }) { endpoint = config.fetch; } } },
    sessions: { get: (id: string) => chats.get(id), flush: async () => {} },
    workspaceRegistry: { list: () => [{ path: path.join(root, "missing-workspace") }, { path: root }, { path: elsewhere }] },
    llm: { listProviders: () => [{ id: "fixture", name: "Fixture" }],
      listModels: async () => [{ id: "model", name: "Test model" }],
      async *stream() { throw new Error("No model call is permitted in this check"); } },
  };
  await applyWorkspaceHost(ctx);
  async function request(mode: string, fields: Record<string, unknown> = {}, id = "author", signal?: AbortSignal) {
    return endpoint(new Request("http://localhost/api/doxvelt-fixture", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: id, mode, ...fields }),
      ...(signal ? { signal } : {}) }));
  }
  try {
    assert.equal((await (await request("saved")).json()).workspace.active, false);
    assert.equal((await request("workspace-activate", {}, "unregistered")).status, 409);
    await request("workspace-activate", {}, "author", AbortSignal.abort());
    await assert.rejects(readFile(path.join(root, ".doxvelt/workspace.json")), { code: "ENOENT" });
    assert.equal((await request("workspace-activate", { workspace: elsewhere })).status, 200);
    await assert.rejects(readFile(path.join(elsewhere, ".doxvelt/workspace.json")), { code: "ENOENT" });
    for (const [kind, id, body] of [["world", "river", "The valley."], ["scenario", "crossing", "The ferry."],
      ["format", "script", "Short dialogue."], ["character", "corin", "@corin is a ferryman. :+3"]]) {
      assert.equal((await request("collection-create", { object: { kind, id, name: id, body } })).status, 200);
    }
    const collection = await (await request("collection")).json();
    const created = await (await request("create-story", { setup: { operationId: "story", collectionRevision: collection.revision,
      worldId: "river", scenarioId: "crossing", formatId: "script", characterIds: ["corin"], date: "2000-03-01" } })).json();
    assert.equal(created.status, "complete");
    assert.equal((await request("open-saved", { simulationId: created.simulationId }, "episode")).status, 200);
    let normalCalls = 0;
    const next = async () => { normalCalls++; return { kind: "enter" }; };
    const preStep = listeners.get("agent/pre-step")!;
    assert.deepEqual(await preStep({ agent: { session: chats.get("author") } }, next), { kind: "enter" });
    assert.deepEqual(await preStep({ agent: { session: chats.get("episode") } }, next), { kind: "reject" });
    assert.deepEqual(await preStep({ agent: { session: chats.get("other") } }, next), { kind: "enter" });
    assert.equal(normalCalls, 2);
    const assemble = listeners.get("system-prompt/assemble")!;
    const originalPrompt = { sections: [{ name: "harness", text: "Normal harness instructions" }], contexts: [], variables: {} };
    const authoring = await assemble(originalPrompt, { agent: { session: chats.get("author") } }, async () => originalPrompt) as typeof originalPrompt;
    assert.match(authoring.sections.at(-1)!.text, /entities\/<id>\/IDENTITY\.md/);
    assert.match(authoring.sections.at(-1)!.text, /do not edit or regenerate the runtime SQLite/);
    assert.equal(await assemble(originalPrompt, { agent: { session: chats.get("other") } }, async () => originalPrompt), originalPrompt);
    assert.equal(await assemble(originalPrompt, { agent: { session: chats.get("episode") } }, async () => originalPrompt), originalPrompt);
    const models = await (await request("workspace-models")).json();
    assert.deepEqual(models.models, [{ provider: "fixture", model: "model", label: "Fixture · Test model" }]);
    assert.equal((await request("workspace-save-models", { configuration: { version: 1, actorModel: { provider: "fixture", model: "model" } },
      expectedRevision: models.configurationRevision })).status, 200);
    assert.equal((await request("workspace-save-models", { configuration: { version: 1 }, expectedRevision: models.configurationRevision })).status, 409);
    assert.equal((await (await request("saved", {}, "other")).json()).workspace.active, false);
  } finally { await listeners.get("dispose")!(); }
});
