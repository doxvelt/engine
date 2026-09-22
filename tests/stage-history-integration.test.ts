import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { reactive } from "vue";
import { StageSession } from "../src/local-ui/lib/stage-session.ts";
import { stageHistoryBrowserFixture } from "../scripts/stage-history-browser-fixture.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import type { BrowserStorage } from "../src/local-ui/lib/stage-recovery.ts";
import type { StageRecoveryIdentity } from "../src/local-api/stage-contracts.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage-history-integration-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const dbPath = path.join(root, "original.sqlite");
  const { server, requests } = stageHistoryBrowserFixture(dbPath, "http://stage.invalid");
  const fetcher: typeof fetch = async (url, options) => new Promise<Response>(resolve => {
    const parsed = new URL(String(url));
    const request = Object.assign(Readable.from(options?.body ? [Buffer.from(String(options.body))] : []), {
      method: options?.method ?? "GET", url: parsed.pathname + parsed.search, headers: { "content-type": "application/json" },
    });
    let status = 0;
    server.emit("request", request, { setHeader() {}, writeHead(value: number) { status = value; }, end(bytes: string) { resolve(new Response(bytes, { status })); } });
  });
  const call = async (suffix: string, body?: Record<string, unknown>) => {
    const response = await fetcher(`http://stage.invalid${suffix}`, body ? { method: "POST", body: JSON.stringify(body) } : {});
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  await call("/simulations/start", { simulationId: "sim", branchId: "main", commandId: "start", workspacePath: path.resolve("examples/executive-interviews"), scenarioId: "executive-interviews" });
  const values = new Map<string, string>();
  const storage: BrowserStorage = { get length() { return values.size; }, key(i) { return [...values.keys()][i] ?? null; }, getItem(k) { return values.get(k) ?? null; }, setItem(k, v) { values.set(k, v); } };
  const session = async (branchId: string) => {
    // Exercise the same proxied class graph as Nuxt, including Maps and cycles.
    const s = reactive(new StageSession({ apiBase: "http://stage.invalid", simulationId: "sim", branchId }, fetcher)) as unknown as StageSession;
    await s.refresh(); await s.enableRecovery(storage); assert.equal(s.recoveryBlocked, false, s.recoveryWarning || s.recovery?.warning); return s;
  };
  return { root, dbPath, call, session, requests, values };
}

test("real serialized identity is stable across reopen, owner-bound and excluded from exported simulation history", async t => {
  const f = await fixture(t);
  const first = await f.call("/recovery-identity") as StageRecoveryIdentity;
  assert.deepEqual(Object.keys(first).sort(), ["installationId", "ownerId"]);
  assert.equal(first.ownerId, "local");
  const reopened = await openBranchStore(f.dbPath).open();
  assert.deepEqual(reopened.getRecoveryIdentity("local"), first);
  assert.equal(reopened.getRecoveryIdentity("another-owner").ownerId, "another-owner");
  const archive = reopened.exportSimulation("local", "sim");
  assert.ok(!JSON.stringify(archive).includes(first.installationId)); reopened.close();
  const other = await openBranchStore(path.join(f.root, "replacement.sqlite")).open();
  other.importSimulation(archive);
  assert.notEqual(other.getRecoveryIdentity("local").installationId, first.installationId); other.close();
  assert.deepEqual(await f.call("/recovery-identity"), first);
});

test("real Stage controllers preserve independent nested paths, suspended candidates and complete-input subtraction", async t => {
  const f = await fixture(t), original = await f.session("main");
  original.mode = "perform"; original.actorId = "ceo"; original.audienceMode = "selected"; original.audienceIds = [];
  original.performance = "FIRST-ORIGINAL"; await original.perform();
  original.performance = "LATER-ORIGINAL"; await original.perform();
  const originalHead = original.projection!.branch.headCommitId;
  original.mode = "direct"; original.actorId = "ceo"; original.direction = "UNRELATED-CONTINUATION-WHISPER";
  await original.generate();
  assert.equal(original.selectedDraft!.status, "ready");
  const candidateId = original.selectedDraftId;
  original.reviewText = "CONTINUATION-LOCAL-EDIT";
  original.performance = "SUSPENDED-PERFORM"; original.direction = "SUSPENDED-DIRECTION";
  await original.history.open(original.projection!.transcript[0]!);
  original.history.editor!.performance = "FIRST-MANUAL-ALTERNATIVE"; original.history.touch(); await original.history.submit();
  assert.equal(original.history.error, "");
  const firstBranch = original.history.target!.branch.id;
  assert.equal(f.requests.length, 1, "historical manual performs no model call");
  original.history.cancel(); original.dispose();
  const first = await f.session(firstBranch);
  first.mode = "perform"; first.actorId = "ceo"; first.performance = "ALTERNATIVE-CONTINUATION"; await first.perform();
  const firstHead = first.projection!.branch.headCommitId;
  await first.history.open(first.projection!.transcript[1]!);
  first.history.editor!.action = "generate"; first.history.editor!.whisper = "ELEPHANT-TO-DELETE"; first.history.editor!.confirmed = true; first.history.touch();
  await first.history.submit(); assert.equal(first.history.error, "");
  const laterBranch = first.history.target!.branch.id;
  first.history.cancel(); first.dispose();
  const later = await f.session(laterBranch);
  await later.history.open(later.projection!.transcript[0]!);
  later.history.editor!.action = "generate"; later.history.editor!.whisper = "LATEST-COMPLETE-ONLY"; later.history.editor!.confirmed = true; later.history.touch();
  await later.history.submit(); assert.equal(later.history.error, "");
  const earlierBranch = later.history.target!.branch.id;
  later.history.cancel(); later.dispose();
  const earlier = await f.session(earlierBranch);
  assert.deepEqual(earlier.projection!.transcript.map(t => t.text), ["Fixture performance: LATEST-COMPLETE-ONLY"]);
  await earlier.history.open(earlier.projection!.transcript[0]!);
  assert.equal(earlier.history.editor!.whisper, "LATEST-COMPLETE-ONLY");
  earlier.history.editor!.action = "generate"; earlier.history.editor!.whisper = ""; earlier.history.touch(); await earlier.history.submit();
  const request = f.requests.at(-1)!;
  assert.equal((request.context as { routingDirection: { completeWhisper: string } }).routingDirection.completeWhisper, "");
  for (const deleted of ["ELEPHANT-TO-DELETE", "LATEST-COMPLETE-ONLY", "FIRST-MANUAL-ALTERNATIVE", "UNRELATED-CONTINUATION-WHISPER", "SUSPENDED-DIRECTION"]) assert.ok(!request.prompt.includes(deleted), deleted);
  const paths = earlier.history.discovery!.paths;
  assert.ok(paths.some(p => p.branchId === "main")); assert.ok(paths.some(p => p.branchId === firstBranch)); assert.ok(paths.some(p => p.branchId === laterBranch));
  await earlier.history.cycle(paths.find(p => p.branchId === firstBranch)!);
  assert.equal(earlier.history.target!.branch.headCommitId, firstHead);
  assert.deepEqual(earlier.history.target!.transcript.map(t => t.text), ["FIRST-MANUAL-ALTERNATIVE", "ALTERNATIVE-CONTINUATION"]);
  const back = await f.session("main");
  assert.equal(back.projection!.branch.headCommitId, originalHead);
  assert.equal(back.selectedDraftId, candidateId); assert.equal(back.selectedDraft!.basisHeadCommitId, originalHead);
  assert.equal(back.reviewText, "CONTINUATION-LOCAL-EDIT"); assert.equal(back.performance, "SUSPENDED-PERFORM"); assert.equal(back.direction, "SUSPENDED-DIRECTION");
  assert.deepEqual(back.projection!.transcript.map(t => t.text), ["FIRST-ORIGINAL", "LATER-ORIGINAL"]);
});

test("failed historical work remains discoverable; retry uses captured input and discard persists separately from newer typing", async t => {
  const f = await fixture(t), s = await f.session("main");
  s.mode = "perform"; s.actorId = "ceo"; s.performance = "Original"; await s.perform();
  await s.history.open(s.projection!.transcript[0]!);
  s.history.editor!.action = "generate"; s.history.editor!.whisper = "DETERMINISTIC-FAIL"; s.history.editor!.confirmed = true; s.history.touch(); await s.history.submit();
  const failed = s.history.discovery!.operations[0]!; assert.equal(failed.status, "failed");
  s.history.editor!.whisper = "Newer, not retry input"; s.history.touch(); await s.history.retry(failed.id);
  assert.equal(s.history.discovery!.operations.length, 2);
  assert.ok(s.history.discovery!.operations.every(o => o.status === "failed"));
  assert.ok(f.requests.every(r => (r.context as { routingDirection: { completeWhisper: string } }).routingDirection.completeWhisper === "DETERMINISTIC-FAIL"));
  await s.history.discard(failed.id);
  assert.equal(s.history.discovery!.operations.find(o => o.id === failed.id)!.status, "discarded");
  s.dispose(); const reopened = await f.session("main");
  assert.equal(reopened.history.editor!.whisper, "Newer, not retry input");
  assert.equal(reopened.history.discovery!.operations.length, 2);
});
