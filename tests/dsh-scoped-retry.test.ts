import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

type Claim = { submit(args: string): Promise<{ kind: string; text?: string }> };
type Source = { trigger: string; onPick(input: unknown): { claim: Claim } };

async function client(storage: Map<string, string>, fetcher: typeof fetch) {
  const sources: Source[] = [];
  const plugin = runInNewContext(await readFile("scripts/dsh-gui-spike/client.js", "utf8"), {
    window: { __ModuleLoader__: { load: (definition: { factory(require: () => unknown): unknown }) => definition.factory(() => ({})) } },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    crypto: { randomUUID }, fetch: fetcher,
  });
  plugin.apply({ effect(fn: () => void) { fn(); }, inputTriggers: { registerSource(source: Source) { sources.push(source); } },
    uiConversation: { events: { register() {} } }, slots: { inject() {} } });
  return sources.find(source => source.trigger === "/")!.onPick({ session: { sessionId: "episode" }, candidate: { name: "perform" } }).claim;
}

test("DSH persists exact scoped acceptance across lost responses and reload, without rebinding newer text", async () => {
  const storage = new Map<string, string>();
  const calls: Record<string, unknown>[] = [];
  let lost = false;
  const fetcher: typeof fetch = async (_url, options) => {
    const command = JSON.parse(String(options?.body)) as Record<string, unknown>;
    calls.push(command);
    if (command.mode === "scene-status") return Response.json({ expectedHead: "original-head" });
    if (!lost) { lost = true; throw new Error("Accepted response lost"); }
    return Response.json({ ok: true });
  };
  const first = await client(storage, fetcher);
  const text = "@Corin #Mara,Nell Shared #Mara(secret) after";
  assert.equal((await first.submit(text)).kind, "error");
  assert.ok(storage.has("doxvelt:scoped-perform:episode"));
  const reopened = await client(storage, fetcher);
  assert.match((await reopened.submit("@Corin #Nell New unsent text")).text!, /pending performance/);
  assert.equal(calls.length, 2, "newer text must not cause another transmission");
  assert.equal((await reopened.submit(text)).kind, "success");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], calls[1]);
  assert.equal(calls[2]!.expectedHead, "original-head");
  assert.equal(calls[2]!.audience, "!unset");
  assert.equal(storage.has("doxvelt:scoped-perform:episode"), false);
});

test("invalid saved DSH requests cannot replay a different workspace operation", async () => {
  const storage = new Map([["doxvelt:scoped-perform:episode", JSON.stringify({ input: { mode: "perform" }, command: { mode: "collection-save" } })]]);
  let transmissions = 0;
  const claim = await client(storage, async () => { transmissions++; return Response.json({}); });
  assert.match((await claim.submit("@Corin #Mara text")).text!, /invalid/);
  assert.equal(transmissions, 0);
});
