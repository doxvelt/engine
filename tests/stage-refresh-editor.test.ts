import assert from "node:assert/strict";
import test from "node:test";
import { StageSession } from "../src/local-ui/lib/stage-session.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const ready = (id: string) => ({ id, generationCommandId: id, branchId: "main", basisHeadCommitId: "head", actorId: "scene", audience: ["scene"], status: "ready", artifact: { text: `Saved ${id}` }, failure: null, createdAt: "2026-01-01" });
  const records = [ready("other"), ready("third")];
  const commands: string[] = [];
  let loseResponse = true;
  const holds = new Map<string, { entered: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<void>> }>();
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/stage")) return Response.json({ scenarioName: "Scene", branch: { id: "main", headCommitId: "head" }, transcript: [], audience: [], actors: [{ id: "scene", name: "Scene", kind: "stateless" }] });
    if (path.endsWith("/drafts") && options?.method === "POST") {
      const { commandId } = JSON.parse(String(options.body)) as { commandId: string };
      commands.push(commandId);
      let record = records.find(item => item.generationCommandId === commandId);
      if (!record) { record = { ...ready(`generated-${commands.length}`), generationCommandId: commandId, status: "generating" }; records.push(record); }
      if (loseResponse) { loseResponse = false; throw new Error("Lost POST response"); }
      return Response.json({ draft: record });
    }
    if (path.endsWith("/drafts")) return Response.json({ drafts: records.filter(item => !["accepted", "discarded"].includes(item.status)) });
    const id = path.split("/").at(-1)!;
    const record = records.find(item => item.id === id);
    assert.ok(record);
    const response = Response.json(record);
    const hold = holds.get(id);
    if (hold) { holds.delete(id); hold.entered.resolve(); await hold.response.promise; }
    return response;
  };
  return {
    session: new StageSession({ apiBase: "http://stage.invalid", simulationId: "sim", branchId: "main" }, fetcher), records, commands,
    hold(id: string) {
      const hold = { entered: deferred<void>(), response: deferred<void>() };
      holds.set(id, hold);
      return { entered: hold.entered.promise, release: () => hold.response.resolve() };
    },
  };
}
async function generating(f: ReturnType<typeof fixture>) {
  await f.session.refresh();
  f.session.compose();
  await f.session.generate();
  assert.equal(f.session.needsReconcile, true);
  await f.session.resume();
  assert.equal(f.session.needsReconcile, false);
  return f.records.find(item => item.status === "generating")!;
}

test("terminal generation lookup preserves text typed into another ready editor while refresh waits", async () => {
  const f = fixture();
  const generated = await generating(f);
  f.session.selectDraft("other"); f.session.editing = true;
  generated.status = "discarded";
  const hold = f.hold(generated.id);
  const refreshing = f.session.refresh(); await hold.entered;
  f.session.reviewText = "New wording during terminal lookup";
  hold.release(); await refreshing;
  assert.equal(f.session.selectedDraftId, "other");
  assert.equal(f.session.reviewText, "New wording during terminal lookup");
  assert.equal(f.session.unsavedReview, true);
  assert.equal(f.session.editing, true);
  f.session.compose(); await f.session.generate();
  assert.notEqual(f.commands.at(-1), f.commands[0], "terminal generation still releases its converged lease");
});

for (const change of ["edit", "switch", "compose", "revert"] as const) {
  test(`selected terminal lookup applies current editor state: ${change}`, async () => {
    const f = fixture(); await f.session.refresh();
    f.session.reviewText = "Initial unsaved text"; f.session.editing = true;
    f.records[0]!.status = "accepted";
    const hold = f.hold("other");
    const refreshing = f.session.refresh(); await hold.entered;
    if (change === "edit") f.session.reviewText = "Latest unsaved text";
    if (change === "switch") { f.session.selectDraft("third"); f.session.editing = true; f.session.reviewText = "Third unsaved text"; }
    if (change === "compose") { f.session.compose(); f.session.performance = "Compose text"; }
    if (change === "revert") f.session.reviewText = "Saved other";
    hold.release(); await refreshing;
    if (change === "edit") {
      assert.equal(f.session.selectedDraft?.status, "accepted");
      assert.equal(f.session.reviewText, "Latest unsaved text");
      assert.equal(f.session.unsavedReview, true);
    } else {
      assert.equal(f.session.drafts.some(item => item.id === "other"), false, "do not revive the former terminal selection");
      assert.equal(f.session.selectedDraftId, change === "switch" ? "third" : null);
      assert.equal(f.session.reviewText, change === "switch" ? "Third unsaved text" : "");
      assert.equal(f.session.unsavedReview, change === "switch");
      if (change === "compose") assert.equal(f.session.performance, "Compose text");
    }
  });
}

test("selection changed during a terminal lookup is itself refreshed before applying dirty terminal text", async () => {
  const f = fixture(); await f.session.refresh();
  f.session.reviewText = "Other edit";
  f.records[0]!.status = "accepted"; f.records[1]!.status = "discarded";
  const first = f.hold("other");
  const refreshing = f.session.refresh(); await first.entered;
  f.session.selectDraft("third"); f.session.editing = true; f.session.reviewText = "Third edit";
  first.release(); await refreshing;
  assert.equal(f.session.selectedDraftId, "third");
  assert.equal(f.session.selectedDraft?.status, "discarded");
  assert.equal(f.session.reviewText, "Third edit");
  assert.equal(f.session.unsavedReview, true);
  assert.equal(f.session.drafts.some(item => item.id === "other"), false);
});

for (const lookup of ["generation", "selected"] as const) {
  for (const invalidation of ["newer refresh", "dispose"] as const) {
    test(`${lookup} terminal lookup ignores completion after ${invalidation}`, async () => {
      const f = fixture();
      let id = "other";
      if (lookup === "generation") { const generated = await generating(f); generated.status = "discarded"; id = generated.id; f.session.selectDraft("other"); }
      else { await f.session.refresh(); f.records[0]!.status = "accepted"; }
      f.session.reviewText = "Before wait";
      const hold = f.hold(id);
      const refreshing = f.session.refresh(); await hold.entered;
      if (invalidation === "dispose") f.session.dispose(); else await f.session.refresh();
      f.session.reviewText = "After invalidation";
      const drafts = f.session.drafts;
      const projection = f.session.projection;
      hold.release(); await refreshing;
      assert.equal(f.session.drafts, drafts);
      assert.equal(f.session.projection, projection);
      assert.equal(f.session.reviewText, "After invalidation");
      assert.equal(f.session.unsavedReview, true);
    });
  }
}

test("both terminal awaits finish before applying a changed selection and its latest dirty text", async () => {
  const f = fixture();
  const generated = await generating(f);
  f.session.selectDraft("other"); f.session.reviewText = "Other edit";
  generated.status = "discarded"; f.records[0]!.status = "accepted";
  const generationRead = f.hold(generated.id);
  const selectedRead = f.hold("other");
  const refreshing = f.session.refresh(); await generationRead.entered;
  generationRead.release(); await selectedRead.entered;
  f.session.selectDraft("third"); f.session.editing = true;
  f.session.reviewText = "Typed during the second await";
  selectedRead.release(); await refreshing;
  assert.equal(f.session.selectedDraftId, "third");
  assert.equal(f.session.reviewText, "Typed during the second await");
  assert.equal(f.session.unsavedReview, true);
  assert.equal(f.session.editing, true);
  assert.deepEqual(f.session.drafts.map(item => item.id), ["third"]);
});
