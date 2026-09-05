import assert from "node:assert/strict";
import test from "node:test";
import { StageSession } from "../src/local-ui/lib/stage-session.ts";

const draft = { id: "draft", generationCommandId: "generate", branchId: "main", basisHeadCommitId: "head", actorId: "scene", audience: ["scene", "a"], status: "ready", artifact: { text: "Saved opening." }, failure: null, createdAt: "2026-01-01" };
function fixture() {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  let drafts = [structuredClone(draft)];
  let head = "head";
  let failProjection = false;
  const fetcher: typeof fetch = async (input, options) => {
    const path = String(input);
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    calls.push({ path, body });
    if (path.includes("/stage?")) {
      if (failProjection) { failProjection = false; throw new Error("projection offline"); }
      return Response.json({ scenarioName: "Pinned scene", branch: { id: "main", headCommitId: head }, transcript: [], audience: [{ actorId: "a", status: "active" }, { actorId: "b", status: "inactive" }], actors: [{ id: "scene", name: "Scene", kind: "stateless" }, { id: "a", name: "A", kind: "agent" }] });
    }
    if (path.includes("/drafts?")) return Response.json({ drafts });
    if (path.endsWith("/drafts/draft")) return Response.json({ ...draft, status: "accepted" });
    if (path.endsWith("/accept")) { head = "accepted"; drafts = []; return Response.json({}); }
    if (path.endsWith("/turns")) { head = "performed"; return Response.json({}); }
    return Response.json({ draft });
  };
  const session = new StageSession({ apiBase: "http://stage.invalid", simulationId: "sim", branchId: "main" }, fetcher);
  return { session, calls, failNextProjection: () => { failProjection = true; }, setHead: (value: string) => { head = value; }, retireDraft: () => { drafts = []; head = "accepted"; } };
}

test("recovery preserves unsaved edits across refresh and exposes captured routing", async () => {
  const { session, setHead } = fixture();
  await session.refresh();
  assert.equal(session.selectedDraft?.id, "draft");
  assert.equal(session.actorId, "scene", "recovery restores the captured actor for continuation");
  session.reviewText = "Unsaved revision.";
  session.actorId = "a";
  await session.refresh();
  assert.equal(session.reviewText, "Unsaved revision.");
  assert.equal(session.unsavedReview, true);
  assert.equal(session.selectedDraft?.actorId, "scene");
  setHead("another");
  await session.refresh();
  assert.equal(session.stale, true);
});

test("acceptance freezes command and text until mutation and projection converge", async () => {
  const { session, calls, failNextProjection } = fixture();
  await session.refresh();
  session.reviewText = "Edited opening.";
  failNextProjection();
  await session.accept();
  assert.equal(session.needsReconcile, true);
  session.reviewText = "A later unsent edit";
  await session.resume();
  const accepts = calls.filter(call => call.path.endsWith("/accept"));
  assert.equal(accepts.length, 2);
  assert.deepEqual(accepts[0]?.body, accepts[1]?.body);
  assert.equal(accepts[1]?.body?.finalText, "Edited opening.");
  assert.equal(session.needsReconcile, false);
});

test("Perform sends only its buffer and explicit available audience, retaining Actor and Direct text", async () => {
  const { session, calls } = fixture();
  await session.refresh();
  session.compose();
  session.actorId = "scene";
  session.direction = "Private instruction";
  session.performance = "Authored opening";
  session.mode = "perform";
  await session.perform();
  const turn = calls.find(call => call.path.endsWith("/turns"))?.body;
  assert.equal(turn?.manualText, "Authored opening");
  assert.deepEqual(turn?.stageWhisperIds, []);
  assert.deepEqual(turn?.audience, ["scene", "a"]);
  assert.equal(JSON.stringify(turn).includes("Private instruction"), false);
  assert.equal(session.direction, "Private instruction");
  assert.equal(session.actorId, "scene");
  assert.equal(session.performance, "");
});

test("disposed sessions ignore late projection responses", async () => {
  const { session } = fixture();
  const loading = session.refresh();
  session.dispose();
  await loading;
  assert.equal(session.projection, null);
});

test("an empty persistent roster still exposes authored actors for explicit whole-turn routing", async () => {
  const fetcher: typeof fetch = async input => String(input).includes('/stage?')
    ? Response.json({ scenarioName: 'Scene', branch: { id: 'main', headCommitId: 'head' }, transcript: [], audience: [], actors: [{ id: 'scene', name: 'Scene', kind: 'stateless' }, { id: 'a', name: 'A', kind: 'agent' }] })
    : Response.json({ drafts: [] });
  const session = new StageSession({ apiBase: 'http://stage.invalid', simulationId: 'sim', branchId: 'main' }, fetcher);
  await session.refresh();
  session.actorId = 'scene';
  assert.deepEqual(session.availableAudience.map(actor => actor.id), ['a', 'scene']);
  assert.deepEqual(session.resolvedAudience, ['scene', 'a']);
});

test("lost mutation responses and double click retry the same frozen command", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const bodies: unknown[] = [];
  let first = true;
  const fetcher: typeof fetch = async (input, options) => {
    if (String(input).endsWith('/turns')) {
      bodies.push(JSON.parse(String(options?.body)));
      if (first) { first = false; await gate; throw new Error('Response lost after commit'); }
      return Response.json({ replayed: true });
    }
    if (String(input).includes('/stage?')) return Response.json({ scenarioName: 'Scene', branch: { id: 'main', headCommitId: 'head' }, transcript: [], audience: [], actors: [{ id: 'scene', name: 'Scene', kind: 'stateless' }] });
    return Response.json({ drafts: [] });
  };
  const session = new StageSession({ apiBase: 'http://stage.invalid', simulationId: 'sim', branchId: 'main' }, fetcher);
  await session.refresh(); session.performance = 'Opening';
  const firstRequest = session.perform();
  await session.perform();
  release(); await firstRequest;
  assert.equal(bodies.length, 1);
  assert.equal(session.needsReconcile, true);
  session.performance = 'Another unsent text';
  await session.resume();
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(session.performance, 'Another unsent text');
});


test("external acceptance preserves unsaved text without presenting a terminal record as pending", async () => {
  const { session, retireDraft } = fixture();
  await session.refresh();
  session.reviewText = "Unsaved alternate wording";
  retireDraft();
  await session.refresh();
  assert.equal(session.selectedDraft?.status, "accepted");
  assert.equal(session.reviewText, "Unsaved alternate wording");
  assert.equal(session.unsavedReview, true);
});

for (const [createdStatus, discoveredStatus] of [
  ["ready", "ready"],
  ["failed", "failed"],
  ["generating", "ready"],
  ["generating", "generating"],
] as const) {
  test(`generation replay survives refresh after a lost response (${createdStatus} -> ${discoveredStatus})`, async () => {
    const saved = (commandId: string, status: string) => ({
      ...draft,
      id: `draft-${commandId}`,
      generationCommandId: commandId,
      status,
      artifact: status === "ready" ? draft.artifact : null,
      failure: status === "failed" ? { message: "Runtime failed" } : null,
    });
    const records: ReturnType<typeof saved>[] = [];
    const commands: string[] = [];
    const fetcher: typeof fetch = async (url, options) => {
      const path = String(url);
      if (path.endsWith("/drafts")) {
        const body = JSON.parse(String(options?.body)) as { commandId: string };
        commands.push(body.commandId);
        let record = records.find(item => item.generationCommandId === body.commandId);
        if (!record) {
          record = saved(body.commandId, createdStatus);
          records.push(record);
        }
        if (commands.length === 1) throw new Error("Lost response after durable draft generation");
        return Response.json({ draft: record });
      }
      if (path.includes("/stage?")) return Response.json({ scenarioName: "Scene", branch: { id: "main", headCommitId: "head" }, transcript: [], audience: [], actors: [{ id: "scene", name: "Scene", kind: "stateless" }] });
      if (path.includes("/drafts?")) return Response.json({ drafts: records });
      throw new Error(`Unexpected request ${path}`);
    };
    const session = new StageSession({ apiBase: "http://stage.invalid", simulationId: "sim", branchId: "main" }, fetcher);
    await session.refresh();
    await session.generate();
    assert.equal(session.needsReconcile, true);
    assert.equal(records.length, 1);
    const originalCommand = commands[0]!;
    records[0] = saved(originalCommand, discoveredStatus);
    await session.refresh();
    assert.equal(session.needsReconcile, true, "discovery alone does not converge the mutation");
    await session.resume();
    assert.deepEqual(commands, [originalCommand, originalCommand]);
    assert.equal(records.length, 1, "reconciliation must reuse the durable draft");
    assert.equal(session.needsReconcile, false);
    assert.equal(session.selectedDraft?.id, records[0]!.id);

    if (discoveredStatus === "generating") {
      // A received but still-generating draft retains the existing lease until completion.
      session.compose();
      await session.generate();
      assert.equal(commands.at(-1), originalCommand);
      assert.equal(records.length, 1);
      records[0] = saved(originalCommand, "ready");
      await session.refresh();
    }
    session.compose();
    await session.generate();
    assert.notEqual(commands.at(-1), originalCommand, "a subsequent generation gets a new command after convergence and completion");
    assert.equal(records.length, 2);
    assert.equal(session.needsReconcile, false);
  });
}

test("success notices stay with their action and clear for a new proposal or compose context", async () => {
  const records = [structuredClone(draft)];
  let head = "head";
  let release: () => void = () => {};
  const generationGate = new Promise<void>(resolve => { release = resolve; });
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/stage")) return Response.json({ scenarioName: "Scene", branch: { id: "main", headCommitId: head }, transcript: [], audience: [], actors: [{ id: "scene", name: "Scene", kind: "stateless" }, { id: "a", name: "A", kind: "agent" }] });
    if (path.endsWith("/drafts") && options?.method === "POST") {
      await generationGate;
      const body = JSON.parse(String(options.body)) as { commandId: string };
      const next = { ...draft, id: "next-draft", generationCommandId: body.commandId, basisHeadCommitId: head };
      records.push(next);
      return Response.json({ draft: next });
    }
    if (path.endsWith("/drafts")) return Response.json({ drafts: records.filter(record => record.status === "ready") });
    const record = records.find(item => path.includes(`/drafts/${item.id}`));
    assert.ok(record);
    if (path.endsWith("/accept")) { record.status = "accepted"; head = "accepted-head"; }
    if (path.endsWith("/discard")) record.status = "discarded";
    return Response.json(record);
  };
  const session = new StageSession({ apiBase: "http://stage.invalid", simulationId: "sim", branchId: "main" }, fetcher);
  await session.refresh();
  await session.accept();
  assert.equal(session.notice, "Accepted.", "the completed action retains its feedback");
  await session.refresh();
  assert.equal(session.notice, "Accepted.", "same-context refresh preserves successful feedback");

  const generating = session.generate();
  const noticeAtStart = session.notice;
  release();
  await generating;
  assert.equal(noticeAtStart, "", "a new operation clears the previous success immediately");
  assert.equal(session.selectedDraft?.id, "next-draft");
  assert.equal(session.notice, "", "the pending proposal must not be labelled Accepted");
  const recovered = { ...session.selectedDraft!, id: "recovered-draft" };
  await session.discard();
  assert.equal(session.notice, "Discarded.");

  // A recovered proposal is a different context, but its recovery error stays visible.
  session.error = "Recovery unavailable";
  session.drafts.push(recovered);
  session.selectDraft(recovered.id);
  assert.equal(session.notice, "");
  assert.equal(session.error, "Recovery unavailable");
  session.notice = "New draft selected.";
  session.compose();
  assert.equal(session.notice, "");
  assert.equal(session.error, "Recovery unavailable");
});
