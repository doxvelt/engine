import assert from "node:assert/strict";
import test from "node:test";
import { StageSession } from "../src/local-ui/lib/stage-session.ts";
import { StageRecovery, type BrowserStorage } from "../src/local-ui/lib/stage-recovery.ts";
import { validStageBuffer } from "../src/local-ui/lib/stage-buffer.ts";
import type { StageProjection, StageAlternativeDetail, StageDraft } from "../src/local-api/stage-contracts.ts";

class MemoryStorage implements BrowserStorage {
  values = new Map<string, string>();
  denied = false;
  get length() { return this.values.size; }
  key(i: number) { return [...this.values.keys()][i] ?? null; }
  getItem(k: string) { if (this.denied) throw new Error("Storage denied"); return this.values.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.denied) throw new Error("Quota exceeded"); this.values.set(k, v); }
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function fixture() {
  const storage = new MemoryStorage();
  const scope = { apiBase: "http://stage.invalid", simulationId: "sim", branchId: "main" };
  const identity = { installationId: "installation", ownerId: "owner" };
  const turn = { id: "version", messageVersionId: "version", logicalMessageId: "logical", commitId: "turn", simulationId: "sim", actorId: "actor", text: "Immutable text", audience: ["actor"], episodeId: null, createdAt: "2026-01-01" };
  const projection = { scenarioName: "Scene", branch: { id: "main", headCommitId: "later" }, transcript: [turn], audience: [], actors: [{ id: "actor", name: "Actor", kind: "agent" }, { id: "other", name: "Other", kind: "agent" }] } as unknown as StageProjection;
  const draft = { id: "draft", branchId: "main", basisHeadCommitId: "later", actorId: "actor", audience: ["actor"], status: "ready", artifact: { text: "Saved continuation" }, failure: null, createdAt: "2026-01-01", generationCommandId: "generate",
    routingReview: { completeWhisper: "Candidate direction", initialAudience: null, correctedAudience: null, originalWhisper: [], correction: "", sourceDraftId: null, sourceAudience: null, originalDraftId: "draft", preserved: false } } as unknown as StageDraft;
  const operations: StageAlternativeDetail[] = [];
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  let origin: string | null = "Only latest complete whisper";
  let loseResponse = false, failProjection = false, stale = false, missingProjection = false, failOrigin = false;
  let holdOrigin: ReturnType<typeof deferred> | null = null, holdGeneration: ReturnType<typeof deferred> | null = null;
  let generations = 0;
  const fetcher: typeof fetch = async (url, options) => {
    const parsed = new URL(String(url)), path = parsed.pathname;
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : null;
    calls.push({ path, body });
    if (path === "/recovery-identity") return Response.json(identity);
    if (path.endsWith("/stage")) {
      if (parsed.searchParams.get("branchId") !== "main") {
        if (missingProjection) { missingProjection = false; return Response.json({ error: "Projection temporarily unavailable" }, { status: 404 }); }
        if (failProjection) { failProjection = false; throw new Error("Projection unavailable"); }
        const op = operations.find(o => o.outcome?.branchId === parsed.searchParams.get("branchId"))!;
        return Response.json({ ...projection, branch: { ...projection.branch, id: op.outcome!.branchId, headCommitId: op.outcome!.commitId }, transcript: [{ ...turn, commitId: op.outcome!.commitId, text: op.review.text }] });
      }
      return Response.json(projection);
    }
    if (path.endsWith("/drafts") && !body) return Response.json({ drafts: draft.status === "ready" ? [draft] : [] });
    if (path.endsWith("/drafts/draft")) return Response.json(draft);
    if (path.endsWith("/drafts/draft/accept")) { draft.status = "accepted"; projection.branch.headCommitId = "accepted"; if (loseResponse) { loseResponse = false; throw new Error("Lost response"); } return Response.json({}); }
    if (path.endsWith("/alternatives/origin")) {
      if (failOrigin) { failOrigin = false; throw new Error("Origin temporarily offline"); }
      await holdOrigin?.promise;
      return Response.json({ kind: origin === null ? "manual" : "generated", state: origin === null ? "none" : "complete", completeWhisper: origin, recordedWhispers: [], legacyCorrection: null });
    }
    if (path.endsWith("/alternatives") && !body) return Response.json({ parentCommitId: "parent", operations,
      paths: [{ branchId: "main", headCommitId: projection.branch.headCommitId, commitId: turn.commitId, messageVersionId: turn.id, logicalMessageId: turn.logicalMessageId, actorId: turn.actorId, text: turn.text, audience: turn.audience },
        ...operations.filter(o => o.outcome).map(o => ({ branchId: o.outcome!.branchId, headCommitId: o.outcome!.commitId, commitId: o.outcome!.commitId, messageVersionId: o.outcome!.commitId, logicalMessageId: turn.logicalMessageId, actorId: turn.actorId, text: o.review.text, audience: turn.audience }))] });
    if (path.endsWith("/alternatives") && body) {
      let op = operations.find(o => o.commandId === body.commandId);
      if (!op) {
        if (stale) return Response.json({ error: "Expected branch head differs" }, { status: 409 });
        generations++;
        op = { ...body, id: `op${generations}`, parentCommitId: "parent", status: "saved", outcome: { branchId: `alternative${generations}`, commitId: `replacement${generations}` }, review: { completeWhisper: body.completeWhisper ?? null, text: body.manualText ?? "Generated alternative", audience: ["actor"], attribution: body.action, runtime: null } } as StageAlternativeDetail;
        operations.push(op);
      }
      await holdGeneration?.promise;
      if (loseResponse) { loseResponse = false; throw new Error("Lost response"); }
      return Response.json({ operation: op });
    }
    if (path.includes("/alternatives/op")) {
      const op = operations.find(o => path.includes(o.id))!;
      if (path.endsWith("/discard")) op.status = "discarded";
      return Response.json(op);
    }
    throw new Error(`Unexpected ${path}`);
  };
  const session = () => new StageSession(scope, fetcher);
  return { storage, scope, identity, turn, projection, draft, operations, calls, session,
    get generations() { return generations; },
    failOrigin: () => { failOrigin = true; }, missingProjection: () => { missingProjection = true; }, noOrigin: () => { origin = null; }, lose: () => { loseResponse = true; }, failProjection: () => { failProjection = true; }, stale: () => { stale = true; },
    holdOrigin: () => (holdOrigin = deferred()), holdGeneration: () => (holdGeneration = deferred()) };
}
async function loaded(f: ReturnType<typeof fixture>) { const s = f.session(); await s.refresh(); await s.enableRecovery(f.storage); return s; }

test("immutable selected turn and latest complete input; suspended modes and candidate overlays survive reopen/cancel", async () => {
  const f = fixture(), s = await loaded(f);
  s.direction = "Later unrelated whisper"; s.performance = "Perform buffer";
  s.actorId = "actor"; s.audienceMode = "selected"; s.audienceIds = ["other"];
  s.mode = "perform"; s.actorId = "other";
  s.reviewText = "Edited continuation"; s.correctionText = "Edited candidate input"; s.editing = true;
  await s.history.open(f.turn);
  assert.equal(s.history.editor!.whisper, "Only latest complete whisper");
  assert.deepEqual(s.history.editor!.selection, { sourceBranchId: "main", expectedHead: "later", sourceCommitId: "turn", messageVersionId: "version", logicalMessageId: "logical", actorId: "actor" });
  s.history.editor!.performance = "Unsent historical text"; s.history.touch(); s.dispose();
  f.draft.status = "discarded";
  const reopened = await loaded(f);
  assert.equal(reopened.history.editor!.performance, "Unsent historical text");
  assert.equal(reopened.selectedDraft!.status, "discarded");
  assert.equal(reopened.reviewText, "Edited continuation");
  assert.equal(reopened.correctionText, "Edited candidate input");
  reopened.history.cancel();
  assert.equal(reopened.actorId, "other"); assert.equal(reopened.mode, "perform");
  assert.equal(reopened.performance, "Perform buffer");
  reopened.mode = "direct";
  assert.equal(reopened.actorId, "actor"); assert.deepEqual(reopened.audienceIds, ["other"]);
  assert.equal(reopened.direction, "Later unrelated whisper");
  assert.equal(reopened.selectedDraft!.basisHeadCommitId, "later");
  assert.ok(f.calls.filter(c => c.path.endsWith("/origin")).every(c => c.body?.sourceCommitId === "turn"));
  assert.ok(!f.calls.some(c => c.path.includes("/context")));
});

test("lost historical response reopens frozen payload separately from newer edits, no second generation or selection theft", async () => {
  const f = fixture(), s = await loaded(f);
  await s.history.open(f.turn);
  s.history.editor!.action = "generate"; s.history.editor!.whisper = "Submitted input"; s.history.touch();
  f.lose(); await s.history.submit();
  assert.ok(s.history.command);
  s.history.editor!.whisper = "Newer unsent input"; s.history.touch(); s.dispose();
  const reopened = await loaded(f);
  assert.equal(reopened.history.editor!.whisper, "Newer unsent input");
  assert.equal(reopened.history.command!.body.completeWhisper, "Submitted input");
  await reopened.history.resume();
  assert.equal(f.generations, 1); assert.equal(reopened.history.target, null);
  const posts = f.calls.filter(c => c.path.endsWith("/alternatives") && c.body);
  assert.deepEqual(posts[0]!.body, posts[1]!.body);
  assert.equal(reopened.history.command, null);
});

test("projection failure retains command identity until exact saved outcome converges", async () => {
  const f = fixture(), s = await loaded(f); await s.history.open(f.turn);
  f.failProjection(); await s.history.submit();
  assert.ok(s.history.command); assert.equal(s.history.target, null);
  await s.history.resume();
  assert.equal(f.generations, 1); assert.equal(s.history.command, null);
  assert.equal(s.history.target!.branch.id, "alternative1");
  assert.equal(f.turn.text, "Immutable text"); assert.equal(f.projection.branch.headCommitId, "later");
});

test("manual/missing origin requires explicit replacement including deliberate empty; manual sends no whisper", async () => {
  const f = fixture(); f.noOrigin(); const s = await loaded(f); await s.history.open(f.turn);
  s.history.editor!.action = "generate"; await s.history.submit(); assert.equal(f.generations, 0);
  s.history.editor!.confirmed = true; s.history.touch(); await s.history.submit();
  assert.equal(f.calls.find(c => c.body?.action === "generate")!.body!.completeWhisper, "");
  s.history.cancel(); await s.history.open(f.turn); await s.history.submit();
  const manual = f.calls.find(c => c.body?.action === "manual")!.body!;
  assert.equal(manual.manualText, "Immutable text"); assert.ok(!("completeWhisper" in manual));
});

test("late originating input cannot replace typing or reopen a cancelled editor", async () => {
  const f = fixture(), s = await loaded(f), hold = f.holdOrigin();
  const opening = s.history.open(f.turn);
  s.history.editor!.whisper = "Typed while reading origin"; s.history.touch();
  hold.release(); await opening;
  assert.equal(s.history.editor!.whisper, "Typed while reading origin");
  const hold2 = f.holdOrigin(), refresh = s.history.refresh(); s.history.cancel(); hold2.release(); await refresh;
  assert.equal(s.history.editor, null); assert.equal(s.history.origin, null);
});

test("late saved generation after cancel reconciles its operation without switching branches", async () => {
  const f = fixture(), s = await loaded(f); await s.history.open(f.turn); const hold = f.holdGeneration();
  const generating = s.history.submit(); s.history.cancel(); hold.release(); await generating;
  assert.equal(s.history.target, null); assert.equal(s.history.editor, null); assert.equal(f.generations, 1);
});

test("stale source conflict retains text and original source basis without implicit rebase", async () => {
  const f = fixture(), s = await loaded(f); await s.history.open(f.turn); f.stale();
  s.history.editor!.performance = "Keep this"; s.history.touch(); await s.history.submit();
  assert.match(s.history.error, /Expected branch/); assert.equal(s.history.editor!.performance, "Keep this");
  assert.equal(s.history.editor!.selection.expectedHead, "later"); assert.equal(f.generations, 0);
});

test("continuation acceptance lost response replays exact frozen wording after reopen and retains terminal dirty overlay", async () => {
  const f = fixture(), s = await loaded(f);
  s.reviewText = "Submitted performance"; f.lose(); await s.accept();
  s.reviewText = "New terminal wording"; s.autosave(); s.dispose();
  const reopened = await loaded(f);
  assert.equal(reopened.selectedDraft!.status, "accepted"); assert.equal(reopened.reviewText, "New terminal wording");
  assert.equal(reopened.needsReconcile, true); await reopened.resume();
  const posts = f.calls.filter(c => c.path.endsWith("/accept"));
  assert.deepEqual(posts[0]!.body, posts[1]!.body); assert.equal(posts[1]!.body!.finalText, "Submitted performance");
  assert.equal(reopened.reviewText, "New terminal wording");
});

test("quota failure preserves memory and prevents a mutation whose identity cannot be persisted", async () => {
  const f = fixture(), s = await loaded(f); await s.history.open(f.turn);
  s.history.editor!.performance = "Copy me"; f.storage.denied = true; await s.history.submit();
  assert.equal(f.generations, 0); assert.equal(s.history.editor!.performance, "Copy me");
  assert.equal(s.recovery!.saved, false); assert.ok(s.recovery!.warning);
  f.storage.denied = false; assert.equal(s.autosave(), true); await s.history.resume(); assert.equal(f.generations, 1);
});

test("installation/owner mismatch never restores private text and blocks in-flight mutations", async () => {
  const f = fixture(), s = await loaded(f); s.direction = "Private owner text"; s.autosave();
  f.identity.ownerId = "different";
  const other = await loaded(f); assert.equal(other.direction, "");
  await s.history.open(f.turn); await s.history.submit();
  assert.equal(f.generations, 0); assert.match(s.recoveryWarning, /installation or owner changed/);
});

test("corrupt/unsupported recovery remains stored, visible and blocks submission", async () => {
  const f = fixture(), s = await loaded(f); s.direction = "Memory"; s.autosave(); s.dispose();
  const key = f.storage.key(0)!; f.storage.values.set(key, '{"version":99}');
  const reopened = await loaded(f);
  assert.match(reopened.recovery!.warning, /Corrupt|unsupported/);
  assert.equal(reopened.recoveryBlocked, true); assert.equal(f.storage.getItem(key), '{"version":99}');
  assert.equal(validStageBuffer({ credentials: "must not cache" }), false);
});

test("two tabs retain both versions and require explicit resolution after server reconciliation", async () => {
  const f = fixture(), a = await loaded(f), b = await loaded(f);
  a.direction = "Tab A"; assert.equal(a.autosave(), true);
  b.direction = "Tab B"; assert.equal(b.autosave(), false);
  a.recovery!.check();
  assert.ok(a.recovery!.conflicts.length >= 2);
  const texts = [...f.storage.values.values()].map(v => JSON.parse(v).data.direction);
  assert.ok(texts.includes("Tab A")); assert.ok(texts.includes("Tab B"));
  const reopened = await loaded(f); assert.equal(reopened.recoveryBlocked, true);
  const index = reopened.recovery!.conflicts.findIndex(r => r.data.direction === "Tab B");
  await reopened.resolveRecovery(index);
  assert.equal(reopened.direction, "Tab B"); assert.equal(reopened.recoveryBlocked, false);
  assert.equal((await loaded(f)).direction, "Tab B");
});

test("storage record validators reject nested wrong types and unknown private fields", () => {
  const f = fixture(), s = f.session(), b = s.snapshot();
  assert.equal(validStageBuffer(b), true);
  assert.equal(validStageBuffer({ ...b, requests: [{ suffix: '/context', body: { commandId: 'x' } }] }), false);
  assert.equal(validStageBuffer({ ...b, routing: { ...b.routing, direct: { ...b.routing.direct, audienceIds: [42] } } }), false);
  assert.equal(validStageBuffer({ ...b, rawPrompt: "secret" }), false);
  const storage = new MemoryStorage(), scope = { ...f.scope, ...f.identity };
  const recovery = new StageRecovery(scope, storage, validStageBuffer, "one"); recovery.save(b);
  const record = JSON.parse(storage.getItem(storage.key(0)!)!); record.scope.installationId = "wrong";
  storage.setItem(storage.key(0)!, JSON.stringify(record));
  assert.equal(new StageRecovery(scope, storage, validStageBuffer, "two").load(), null);
});

test("evicted unchanged data is written again before claiming local durability", async () => {
  const f = fixture(), s = await loaded(f); s.direction = "Eviction recovery"; s.autosave();
  f.storage.values.clear(); assert.equal(s.autosave(), true);
  assert.ok(f.storage.length > 0); assert.equal((await loaded(f)).direction, "Eviction recovery");
});

test("conflict choice cannot erase another tab's frozen request; explicit exact reconciliation unlocks resolution", async () => {
  const f = fixture(), a = await loaded(f), b = await loaded(f);
  await a.history.open(f.turn); f.lose(); await a.history.submit();
  b.direction = "Independent tab text"; b.autosave(); a.recovery!.check();
  const withoutCommand = a.recovery!.conflicts.findIndex(r => !r.data.history.command);
  await a.resolveRecovery(withoutCommand);
  assert.match(a.recoveryWarning, /unresolved requests/);
  const pending = a.recovery!.conflicts.findIndex(r => !!r.data.history.command);
  await a.reconcileConflict(pending);
  assert.equal(f.generations, 1);
  assert.equal(a.history.command, null);
  const choice = a.recovery!.conflicts.findIndex(r => r.data.direction === "Independent tab text");
  await a.resolveRecovery(choice);
  assert.equal(a.direction, "Independent tab text"); assert.equal(a.recoveryBlocked, false);
});

test("pending historical operation is discoverable after replay without pretending a worker resumed", async () => {
  const f = fixture(), s = await loaded(f); await s.history.open(f.turn);
  const hold = f.holdGeneration(), submitting = s.history.submit();
  // Reach the POST after the identity read. Simulate a stranded durable pending operation.
  while (!f.operations.length) await new Promise(resolve => setImmediate(resolve));
  f.operations[0]!.status = "pending"; f.operations[0]!.outcome = null;
  hold.release(); await submitting;
  assert.equal(s.history.command, null); assert.equal(s.history.target, null);
  assert.match(s.history.notice, /no running worker/);
  assert.equal(s.history.discovery!.operations[0]!.status, "pending");
  await s.history.discard(f.operations[0]!.id);
  assert.equal(s.history.discovery!.operations[0]!.status, "discarded");
});

test("owner change during refresh cannot apply a new owner's projection over private local overlays", async () => {
  const f = fixture(), s = await loaded(f); s.direction = "Private local buffer"; s.autosave();
  const previous = s.projection!.branch.headCommitId;
  f.identity.installationId = "replacement-database"; f.projection.branch.headCommitId = "foreign-head";
  await assert.rejects(s.refresh(), /installation or owner changed/);
  assert.equal(s.projection!.branch.headCommitId, previous); assert.equal(s.direction, "Private local buffer");
  assert.equal(s.recoveryBlocked, true);
});

test("cycling and saving one historical mode preserve unsubmitted wording in the other mode", async () => {
  const f = fixture(), s = await loaded(f); await s.history.open(f.turn);
  s.history.editor!.whisper = "Unsubmitted whisper while editing performance"; s.history.touch();
  s.history.editor!.performance = "Submitted manual text"; s.history.touch(); await s.history.submit();
  assert.ok(s.history.target); s.history.leaveForTarget();
  assert.equal(s.history.editor!.whisper, "Unsubmitted whisper while editing performance");
  s.dispose(); const reopened = await loaded(f);
  assert.equal(reopened.history.editor!.whisper, "Unsubmitted whisper while editing performance");
  await reopened.history.cycle(reopened.history.discovery!.paths.find(p => p.branchId === "main")!);
  reopened.history.leaveForTarget(); assert.ok(reopened.history.editor);
});

test("a saved outcome followed by projection HTTP 404 retains the exact command instead of permitting a duplicate", async () => {
  const f = fixture(), s = await loaded(f); await s.history.open(f.turn); f.missingProjection(); await s.history.submit();
  assert.ok(s.history.command); assert.equal(s.history.target, null);
  const id = s.history.command.body.commandId; await s.history.resume();
  assert.equal(f.generations, 1); assert.equal(s.history.command, null);
  assert.ok(f.calls.filter(c => c.path.endsWith('/alternatives') && c.body).every(c => c.body!.commandId === id));
});

test("reopen applies no partial overlay before authoritative origin/status reads; failed recovery retains copy-out and retries", async () => {
  const f = fixture(), s = await loaded(f); s.direction = "Recover this direction"; await s.history.open(f.turn);
  s.history.editor!.performance = "Recover this history edit"; s.history.touch(); s.dispose();
  f.failOrigin(); const reopened = await loaded(f);
  assert.equal(reopened.recoveryReady, false); assert.equal(reopened.history.editor, null);
  assert.equal(reopened.direction, "");
  assert.ok(JSON.stringify(reopened.copyOut()).includes("Recover this history edit"));
  await reopened.retryRecovery();
  assert.equal(reopened.recoveryReady, true); assert.equal(reopened.recoveryBlocked, false);
  assert.equal(reopened.direction, "Recover this direction"); assert.equal(reopened.history.editor!.performance, "Recover this history edit");
});
