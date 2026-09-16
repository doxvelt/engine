import assert from "node:assert/strict";
import test from "node:test";
import { StageSession } from "../src/local-ui/lib/stage-session.ts";

function fixture() {
  const records: { id: string; generationCommandId: string; branchId: string; basisHeadCommitId: string; actorId: string; audience: string[]; status: string; artifact: null; failure: null; createdAt: string; routingReview?: import("../src/local-api/stage-contracts.ts").StageDraft["routingReview"] }[] = [];
  const commands: string[] = [];
  const discardCommands: string[] = [];
  let loseResponse = true;
  let failProjection = false;
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/stage")) {
      if (failProjection) { failProjection = false; throw new Error("Projection unavailable"); }
      return Response.json({ scenarioName: "Scene", branch: { id: "main", headCommitId: "head" }, transcript: [], audience: [], actors: [{ id: "scene", name: "Scene", kind: "stateless" }, { id: "z", name: "Z", kind: "agent" }] });
    }
    if (path.endsWith("/drafts") && options?.method === "POST") {
      const { commandId, actorId, audience } = JSON.parse(String(options.body)) as { commandId: string; actorId: string; audience: string[] | null };
      commands.push(commandId);
      let record = records.find(item => item.generationCommandId === commandId);
      if (!record) {
        record = { id: `draft-${records.length}`, generationCommandId: commandId, branchId: "main", basisHeadCommitId: "head", actorId, audience: [actorId, ...(audience || []).filter(id => id !== actorId)], status: "generating", artifact: null, failure: null, createdAt: "2026-01-01" };
        // Mirror the v1 proposal API: null direction is distinct from normalized draft delivery.
        record.routingReview = { initialAudience: audience, correctedAudience: null, originalWhisper: [], correction: "",
          sourceDraftId: null, sourceAudience: null, originalDraftId: record.id, preserved: false };
        records.push(record);
      }
      if (loseResponse) { loseResponse = false; throw new Error("Lost POST response"); }
      return Response.json({ draft: record });
    }
    if (path.endsWith("/drafts")) return Response.json({ drafts: records.filter(item => !["accepted", "discarded"].includes(item.status)) });
    const record = records.find(item => path.includes(`/drafts/${item.id}`));
    assert.ok(record);
    if (path.endsWith("/discard")) {
      discardCommands.push((JSON.parse(String(options?.body)) as { commandId: string }).commandId);
      record.status = "discarded";
    }
    return Response.json(record);
  };
  return {
    session: new StageSession({ apiBase: "http://stage.invalid", simulationId: "sim", branchId: "main" }, fetcher),
    records, commands, discardCommands,
    failProjection: () => { failProjection = true; },
  };
}

async function reconciledGenerating(f: ReturnType<typeof fixture>) {
  await f.session.refresh();
  await f.session.generate();
  assert.equal(f.session.needsReconcile, true);
  await f.session.resume();
  assert.equal(f.session.needsReconcile, false);
  assert.equal(f.records.length, 1);
  assert.deepEqual(f.commands, [f.commands[0], f.commands[0]]);
}

test("lost generation response, generating replay, discard, then identical generation creates a new candidate", async () => {
  const f = fixture();
  await reconciledGenerating(f);
  await f.session.discard();
  assert.equal(f.session.needsReconcile, false);
  assert.equal(f.session.drafts.length, 0);
  await f.session.generate();
  assert.notEqual(f.commands.at(-1), f.commands[0], "discarded generation must release its matching lease after convergence");
  assert.equal(f.records.length, 2);
  assert.equal(f.session.selectedDraft?.status, "generating");
});

for (const status of ["accepted", "discarded"] as const) {
  for (const selection of ["compose", "another"] as const) {
    test(`matching external ${status} releases generation lease while ${selection} is selected`, async () => {
      const f = fixture();
      await reconciledGenerating(f);
      if (selection === "compose") f.session.compose();
      else {
        f.records.push({ ...f.records[0]!, id: "other", generationCommandId: "other-command" });
        await f.session.refresh();
        f.session.selectDraft("other");
      }
      f.records[0]!.status = status;
      await f.session.refresh();
      assert.equal(f.session.selectedDraftId, selection === "compose" ? null : "other");
      assert.equal(f.session.drafts.some(item => item.id === f.records[0]!.id), false);
      f.session.compose();
      await f.session.generate();
      assert.notEqual(f.commands.at(-1), f.commands[0]);
    });
  }
}

test("terminal discovery during a failed discard projection preserves the pending discard command", async () => {
  const f = fixture();
  await reconciledGenerating(f);
  f.failProjection();
  await f.session.discard();
  assert.equal(f.session.needsReconcile, true);
  await f.session.refresh();
  assert.equal(f.session.needsReconcile, true);
  await f.session.resume();
  assert.deepEqual(f.discardCommands, [f.discardCommands[0], f.discardCommands[0]]);
  await f.session.generate();
  assert.notEqual(f.commands.at(-1), f.commands[0]);
});

test("terminal generation replay cannot release the original command until failed projection converges", async () => {
  const f = fixture();
  await f.session.refresh();
  await f.session.generate();
  await f.session.refresh();
  f.records[0]!.status = "discarded";
  await f.session.refresh();
  assert.equal(f.session.needsReconcile, true);
  f.failProjection();
  await f.session.resume();
  assert.equal(f.session.needsReconcile, true);
  await f.session.refresh();
  await f.session.resume();
  assert.deepEqual(f.commands, [f.commands[0], f.commands[0], f.commands[0]]);
  assert.equal(f.session.needsReconcile, false);
  await f.session.generate();
  assert.notEqual(f.commands.at(-1), f.commands[0]);
});

test("discarding a nonmatching draft does not release a still-generating lease", async () => {
  const f = fixture();
  await reconciledGenerating(f);
  f.records.push({ ...f.records[0]!, id: "other", generationCommandId: "other-command" });
  await f.session.refresh();
  f.session.selectDraft("other");
  await f.session.discard();
  await f.session.generate();
  assert.equal(f.commands.at(-1), f.commands[0]);
  assert.equal(f.session.selectedDraft?.id, f.records[0]!.id);
  assert.equal(f.records.length, 2);
});


test("a terminal response supplies the missing generation identity when discovery never saw it", async () => {
  const f = fixture();
  await f.session.refresh();
  await f.session.generate();
  f.records[0]!.status = "discarded";
  await f.session.refresh();
  assert.equal(f.session.drafts.length, 0);
  assert.equal(f.session.needsReconcile, true);
  await f.session.resume();
  assert.deepEqual(f.commands, [f.commands[0], f.commands[0]]);
  assert.equal(f.session.needsReconcile, false);
  await f.session.generate();
  assert.notEqual(f.commands.at(-1), f.commands[0]);
});

test("terminalizing an older candidate cannot settle a newer generating command", async () => {
  const f = fixture();
  await reconciledGenerating(f);
  f.session.compose();
  f.session.actorId = "z";
  await f.session.generate();
  const newerCommand = f.commands.at(-1);
  assert.notEqual(newerCommand, f.commands[0]);
  f.records[0]!.status = "discarded";
  f.session.compose();
  await f.session.refresh();
  await f.session.generate();
  assert.equal(f.commands.at(-1), newerCommand);
  assert.equal(f.records.length, 2);
});
