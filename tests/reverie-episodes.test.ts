import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalApiServer } from "../src/local-api/server.ts";
import { EpisodeMemory, type EpisodeMemoryOptions } from "../src/memory/episodes.ts";
import type { ActorTurnRuntime } from "../src/agent-runtime/contracts.ts";

const executable = process.env.DOXVELT_REVERIE_EXECUTABLE;
test("episode publications follow perceptions, fictional chronology and the selected story path", {
  skip: !executable && "Set DOXVELT_REVERIE_EXECUTABLE to run the native episode integration.",
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "doxvelt-episodes-"));
  const seen: string[] = [];
  const prompts: string[] = [];
  const options: EpisodeMemoryOptions = { directory: path.join(root, "memory"), executable: executable!,
    modelKey: "scripted", async reflect(request) {
      const input = JSON.stringify(request.input);
      seen.push(input);
      assert.match(request.system, /speaker, recipients, and performance/);
      const native = JSON.stringify((request.input as { nativeEpisode: unknown }).nativeEpisode);
      const gist = native.includes("red lantern") ? "I remember the red lantern agreement."
        : native.includes("blue lantern") ? "I remember the blue lantern agreement."
        : "I remember the ferry's departure.";
      return JSON.stringify({ memories: [{ gist, detail: "", feeling: "", cues: ["lantern", "ferry"],
        salience: 0.9, confidence: 0.8, sourceMessageIds: ["m1"] }], impressions: [] });
    },
  };
  const runtime: ActorTurnRuntime = { identity: { id: "reverie-episode-fixture", version: "1" },
    async *runActorTurn(request) {
      prompts.push(request.prompt);
      yield { type: "completed", text: JSON.stringify({ text: "I hear you.", audience: [request.actorId] }), stopReason: "stop" };
    },
  };
  let memory = new EpisodeMemory(options);
  const dbPath = path.join(root, "story.sqlite");
  let server = createLocalApiServer({ dbPath, episodeMemory: memory, actorTurnRuntime: runtime });
  t.after(async () => { server.close(); memory.close(); await rm(root, { recursive: true, force: true }); });
  const api = async (url: string, body?: Record<string, unknown>) => {
    const req = new IncomingMessage(new Socket());
    req.url = url;
    req.method = body ? "POST" : "GET";
    req.headers = { "content-type": "application/json" };
    if (body) req.push(JSON.stringify(body));
    req.push(null);
    const result = await new Promise<{ code: number; value: any }>(resolve => {
      const res = new ServerResponse(req);
      res.end = ((text: string) => { resolve({ code: res.statusCode, value: JSON.parse(text) }); return res; }) as typeof res.end;
      server.emit("request", req, res);
    });
    assert.equal(result.code, 200, JSON.stringify(result.value));
    return result.value;
  };
  const base = "/simulations/example-last-crossing";
  const started = await api("/examples/last-crossing/play", {});
  assert.equal(started.branchId, "main");
  const rootHead = (await api(base + "/stage")).branch.headCommitId as string;
  let sequence = 0;
  const command = (branchId: string, expectedHead: string, body: Record<string, unknown> = {}) =>
    ({ branchId, expectedHead, commandId: "action-" + ++sequence, ...body });
  const play = (branch: string, head: string, text: string, audience: string) =>
    api(base + "/turns", command(branch, head, { actorId: "corin", audience: [audience], manualText: text,
      stageWhisperIds: [], knowledgePolicy: "actor-knowledge-v1" }));
  const date = (branch: string, head: string, slot: string, value: string) =>
    api(base + "/episode-memory/date", command(branch, head, { slot, date: value }));
  const memorize = (branch: string, head: string, slot: string) =>
    api(base + "/episode-memory/memorize", command(branch, head, { slot }));
  const close = (branch: string, head: string, label: string) =>
    api(base + "/episodes/request-closure", command(branch, head, { label }));
  const generate = async (branch: string, head: string, actorId: string) => {
    const result = await api(base + "/drafts", command(branch, head, {
      actorId, completeWhisper: "Think about the lantern.", stageWhisperIds: [], audience: null, draftingPolicy: "actor-knowledge-v1",
    }));
    assert.equal(result.draft.status, "ready");
    return prompts.at(-1)!;
  };

  const first = await play("main", rootHead, "The red lantern agreement is ours alone.", "nell");
  const mainHead = first.branch.headCommitId as string;
  await date("main", mainHead, "first", "2000-03-01");
  const original = await memorize("main", mainHead, "first");
  assert.equal(original.status, "published");
  assert.deepEqual(original.memories.map((item: { characterId: string }) => item.characterId).sort(), ["corin", "nell"]);
  assert.ok(seen.every(input => input.includes("Corin") && !input.includes("Mara")));
  assert.equal((await memorize("main", mainHead, "first")).status, "current");
  assert.equal(seen.length, 2);
  const same = await generate("main", mainHead, "nell");
  assert.match(same, /The red lantern agreement is ours alone/);
  assert.doesNotMatch(same, /I remember the red lantern agreement/);

  const closed = await close("main", mainHead, "Ferry agreement");
  const mainSequel = closed.branch.headCommitId as string;
  const mainSlot = closed.job.episodeId as string;
  await date("main", mainSequel, mainSlot, "1999-03-01");
  assert.doesNotMatch(await generate("main", mainSequel, "nell"), /red lantern agreement/);
  await date("main", mainSequel, mainSlot, "2001-03-01");
  const sequel = await generate("main", mainSequel, "nell");
  assert.match(sequel, /I remember the red lantern agreement/);
  assert.doesNotMatch(sequel, /The red lantern agreement is ours alone/);
  assert.doesNotMatch(await generate("main", mainSequel, "mara"), /red lantern agreement/);

  await api(base + "/fork", command("main", mainSequel, { atCommitId: rootHead, newBranchId: "alternate" }));
  const alternate = await play("alternate", rootHead, "The blue lantern agreement is ours alone.", "mara");
  const alternateHead = alternate.branch.headCommitId as string;
  assert.equal((await api(base + "/episode-memory?branchId=alternate")).episodes[0].status, "drifted");
  assert.doesNotMatch(await generate("alternate", alternateHead, "nell"), /red lantern agreement|blue lantern agreement/);
  assert.equal(seen.length, 2);
  const alternateClosed = await close("alternate", alternateHead, "Alternative agreement");
  const alternateSequel = alternateClosed.branch.headCommitId as string;
  await date("alternate", alternateSequel, alternateClosed.job.episodeId, "2001-03-01");
  assert.doesNotMatch(await generate("alternate", alternateSequel, "mara"), /red lantern agreement|blue lantern agreement/);
  const replacement = await memorize("alternate", alternateSequel, "first");
  assert.deepEqual(replacement.memories.map((item: { characterId: string }) => item.characterId).sort(), ["corin", "mara"]);
  assert.match(await generate("alternate", alternateSequel, "mara"), /I remember the blue lantern agreement/);
  assert.doesNotMatch(await generate("alternate", alternateSequel, "nell"), /red lantern agreement|blue lantern agreement/);

  server.close();
  memory.close();
  memory = new EpisodeMemory(options);
  server = createLocalApiServer({ dbPath, episodeMemory: memory, actorTurnRuntime: runtime });
  assert.equal((await api(base + "/episode-memory?branchId=main")).episodes[0].status, "current");
  assert.match(await generate("main", mainSequel, "nell"), /I remember the red lantern agreement/);
  assert.equal(seen.length, 4);

  const departure = await play("main", mainSequel, "The ferry has left the dock.", "nell");
  const departureHead = departure.branch.headCommitId as string;
  await memorize("main", departureHead, mainSlot);
  assert.equal(seen.length, 6);
  assert.match(seen.at(-1)!, /earlierSubjectiveMemory.*I remember the red lantern agreement/);
  const closedDeparture = await close("main", departureHead, "Departure");
  const thirdHead = closedDeparture.branch.headCommitId as string;
  await date("main", thirdHead, closedDeparture.job.episodeId, "2003-03-01");
  const both = await generate("main", thirdHead, "nell");
  assert.match(both, /I remember the red lantern agreement/);
  assert.match(both, /I remember the ferry's departure/);

  await date("main", thirdHead, "first", "2004-03-01");
  const drift = (await api(base + "/episode-memory?branchId=main")).episodes;
  assert.equal(drift[0].status, "drifted");
  assert.equal(drift[1].status, "drifted");
  assert.doesNotMatch(await generate("main", thirdHead, "nell"), /red lantern agreement|ferry's departure/);
  await date("main", thirdHead, "first", "2000-03-01");
  assert.match(await generate("main", thirdHead, "nell"), /I remember the ferry's departure/);
  assert.equal(seen.length, 6);
});
