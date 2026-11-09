import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parsePerformance, type AudienceSyntax } from "../src/core/audience-scopes.ts";
import { commitManualTurn, forkBranch, inspectActorContext, projectBranch, startBranchSimulation } from "../src/core/branch-kernel.ts";
import { requestEpisodeClosure, runEpisodeMemoryJob } from "../src/core/branch-episode.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { correctTurnBody } from "../src/core/turn-correction.ts";
import { EpisodeMemory } from "../src/memory/episodes.ts";
import { createSavedAlternative } from "../src/core/saved-alternatives.ts";
import { projectRoutingContext } from "../src/core/candidate-routing.ts";
import { ACTOR_KNOWLEDGE_POLICY } from "../src/core/types.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

const identities = ["Corin", "Mara", "Nell"].map(name => ({ id: name.toLowerCase(), name }));
const whisper = '@Corin #Mara,Nell He leans in and whispers to Mara: #Mara("The key is under the ferry rope."|[unintelligible]) Then he steps back.';
const visibleWhisper = 'He leans in and whispers to Mara: "The key is under the ferry rope." Then he steps back.';
const heardWhisper = 'He leans in and whispers to Mara: [unintelligible] Then he steps back.';
const movement = '@Corin #Mara,Nell #Mara(He leans toward Mara.) "The key is under the ferry rope."';
const parse = (text: string, audience: string[] | null = ["mara", "nell"], syntax: AudienceSyntax = "scoped-v1") =>
  parsePerformance({ text, audience, syntax, actorId: "corin", identities });
const projected = (result: ReturnType<typeof parse>, actor: string) => result.performance.projections.find(p => p.actorId === actor)?.text;

test("default, turn and span precedence, multiple recipients and return to base", () => {
  const defaults = ["mara"];
  const result = parse("#Nell Before #Mara,Nell(both) after", defaults);
  assert.equal(projected(result, "nell"), "Before both after");
  assert.equal(projected(result, "mara"), "both");
  assert.equal(projected(result, "corin"), "Before both after");
  assert.deepEqual(defaults, ["mara"]);
  assert.deepEqual(result.performance.baseAudience, ["nell"]);
  assert.equal(projected(parse("Next turn", defaults), "mara"), "Next turn");
  assert.equal(projected(parse("Next turn", defaults), "nell"), undefined);
});

test("both authored examples and actor-primary precedence", () => {
  const result = parse(whisper, null, "scoped-fallback-v1");
  assert.equal(projected(result, "mara"), visibleWhisper);
  assert.equal(projected(result, "nell"), heardWhisper);
  assert.equal(projected(result, "corin"), visibleWhisper);
  assert.equal(projected(parse(movement), "nell"), '"The key is under the ferry rope."');
  assert.equal(projected(parse(movement), "mara"), 'He leans toward Mara. "The key is under the ferry rope."');
  const own = parse("#Corin,Nell #Mara(primary|fallback)", null, "scoped-fallback-v1");
  assert.equal(projected(own, "corin"), "primary");
  assert.equal(projected(own, "nell"), "fallback");
});

test("fallback occurrences require primary content, including within a shared performance", () => {
  for (const text of ["#Mara(|she nods)", "#Mara( \n\t|she nods)", "Shared #Mara(|she nods)", "#Mara(|)"])
    assert.throws(() => parse(text, ["mara", "nell"], "scoped-fallback-v1"), /nonempty primary/);
  assert.equal(projected(parse("#Mara(She nods.|she nods)", ["mara", "nell"], "scoped-fallback-v1"), "corin"), "She nods.");
});

test("authored spacing is preserved, including the documented way to scope connective whitespace", () => {
  assert.equal(projected(parse("Hello #Mara(secret) world"), "nell"), "Hello  world");
  const connected = parse("Hello #Mara(secret )world");
  assert.equal(projected(connected, "nell"), "Hello world");
  assert.equal(projected(connected, "mara"), "Hello secret world");
  assert.equal(projected(connected, "corin"), "Hello secret world");
});

test("private thought, fully scoped content, explicit markers and actor override", () => {
  const thought = parse("#Corin(PRIVATE_THOUGHT)");
  assert.deepEqual(thought.audience, ["corin"]);
  assert.equal(projected(thought, "mara"), undefined);
  assert.equal(projected(parse("#Mara(Only Mara)", null), "mara"), "Only Mara");
  assert.equal(projected(parse("#Mara(secret|[not perceived])", ["nell"], "scoped-fallback-v1"), "nell"), "[not perceived]");
  const acting = parse("@Nell #Mara(own primary)", null);
  assert.equal(acting.actorId, "nell");
  assert.equal(projected(acting, "nell"), "own primary");
  assert.equal(projected(acting, "corin"), undefined);
});

test("literal parentheses, nested ordinary parentheses, pipes, backslashes and selectors", () => {
  const result = parse(String.raw`#Mara(The mark (two (joined|split) strokes) means A\|B. Use \( and \). \\ \# \@)`);
  assert.equal(projected(result, "mara"), "The mark (two (joined|split) strokes) means A|B. Use ( and ). \\ # @");
  assert.equal(projected(parse(String.raw`Literal \#Mara\(text\) and \@Corin. C:\notes`), "nell"), "Literal #Mara(text) and @Corin. C:\\notes");
});

test("invalid and unresolved input fails closed, including unratified fallback without opt-in", () => {
  for (const text of ["#Unknown(text)", "@Unknown #Mara text", "#Mara(unclosed", "#Mara(#Nell(nested))", "#Mara,Nell, bad", "#Mara(a|b|c)", "#Mara(a|b)", "#Mara.Nell text", "@Corin, text"])
    assert.throws(() => parse(text), /./, text);
  assert.throws(() => parse("Unscoped", null), /audience/);
  assert.throws(() => parse("#Mara(a|b)", null, "scoped-fallback-v1"), /base audience/);
  assert.throws(() => parsePerformance({ text: "#Mara(text)", actorId: "corin", audience: [], syntax: "scoped-v1",
    identities: [...identities, { id: "duplicate", name: "Mara" }] }), /ambiguous/);
  assert.throws(() => parse("#Mara(a|b|c)", ["nell"], "scoped-fallback-v1"), /one fallback/);
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-scopes-"));
  const db = path.join(root, "source.sqlite");
  let store = await openBranchStore(db).open();
  const started = await startBranchSimulation(store, { ownerScope: "local", simulationId: "scopes", branchId: "main", commandId: "start",
    workspacePath: path.resolve("examples/last-crossing"), scenarioId: "last-crossing" });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db, started, get store() { return store; }, async restart() { store.close(); store = await openBranchStore(db).open(); } };
}
const envelope = (expectedHead: string, commandId: string) => ({ ownerScope: "local", simulationId: "scopes", branchId: "main", expectedHead, commandId });
const payload = (text: string, audienceSyntax: AudienceSyntax = "scoped-fallback-v1"): import("../src/core/ports.ts").ManualTurnPayload => ({ actorId: "corin", audience: ["mara", "nell"], text, audienceSyntax,
  stageWhisperIds: [], knowledgePolicy: ACTOR_KNOWLEDGE_POLICY });

test("one atomic commit persists projections, stable perceptions, restart/retry and legacy interpretation", async t => {
  const f = await fixture(t);
  const command = { ...envelope(f.started.root.id, "whisper"), payload: payload(whisper) };
  const accepted = commitManualTurn(f.store, command);
  assert.equal(accepted.commit.events.length, 1);
  const message = accepted.commit.events[0]!;
  assert.equal(message.type, "message_accepted");
  let projection = projectBranch(f.store, envelope(accepted.commit.id, "read"));
  assert.equal(projection.transcript.length, 1);
  const provenance = projection.perceptions;
  assert.equal(provenance.length, 3);
  assert.equal(new Set(provenance.map(p => p.sourceMessageVersionId)).size, 1);
  for (const [actorId, text] of [["mara", visibleWhisper], ["nell", heardWhisper], ["corin", visibleWhisper]]) {
    const context = inspectActorContext(f.store, { ...envelope(accepted.commit.id, "read"), actorId: actorId!, audience: [] });
    assert.equal(context.subjective.transcript[0]!.text, text);
    assert.deepEqual(context.subjective.transcript[0]!.audience, [actorId]);
    assert.equal("performance" in context.subjective.transcript[0]!, false);
    if (actorId === "nell") assert.doesNotMatch(JSON.stringify(context), /The key is under|baseAudience|projections|fallback|sourceOffset/);
  }
  await f.restart();
  assert.equal(commitManualTurn(f.store, command).replayed, true);
  assert.deepEqual(projectBranch(f.store, envelope(accepted.commit.id, "read")).perceptions, provenance);
  const later = commitManualTurn(f.store, { ...envelope(accepted.commit.id, "different-default"), payload: { ...payload("Later"), audience: [] } });
  assert.equal(inspectActorContext(f.store, { ...envelope(later.commit.id, "read"), actorId: "nell", audience: [] }).subjective.transcript[0]!.text, heardWhisper);
  const legacy = commitManualTurn(f.store, { ...envelope(later.commit.id, "legacy"), payload: { actorId: "corin", audience: ["nell"], text: "#Mara(legacy literal|unchanged)" } });
  projection = projectBranch(f.store, envelope(legacy.commit.id, "read"));
  assert.equal(projection.transcript.at(-1)!.performance, undefined);
  assert.equal(inspectActorContext(f.store, { ...envelope(legacy.commit.id, "read"), actorId: "nell", audience: [] }).subjective.transcript.at(-1)!.text, "#Mara(legacy literal|unchanged)");
  validateSimulationArchive(f.store.exportSimulation("local", "scopes"));
});

test("invalid input and stale heads leave branch/history unchanged; private turns have no observer perception", async t => {
  const f = await fixture(t);
  const before = f.store.exportSimulation("local", "scopes");
  assert.throws(() => commitManualTurn(f.store, { ...envelope(f.started.root.id, "bad"), payload: payload("#Missing(secret)") }));
  assert.throws(() => commitManualTurn(f.store, { ...envelope(f.started.root.id, "empty-primary"), payload: payload("#Mara(|she nods)") }), /nonempty primary/);
  assert.deepEqual(f.store.exportSimulation("local", "scopes"), before);
  const thought = commitManualTurn(f.store, { ...envelope(f.started.root.id, "thought"), payload: payload("#Corin(PRIVATE_THOUGHT)") });
  assert.throws(() => commitManualTurn(f.store, { ...envelope(f.started.root.id, "stale"), payload: payload(whisper) }), /head conflict/);
  const projection = projectBranch(f.store, envelope(thought.commit.id, "read"));
  assert.deepEqual(projection.perceptions.map(p => p.actorId), ["corin"]);
  assert.equal(inspectActorContext(f.store, { ...envelope(thought.commit.id, "read"), actorId: "nell", audience: [] }).subjective.transcript.length, 0);
});

test("memory callbacks and real runtime context receive only the observer projection, with branch-valid provenance", async t => {
  const f = await fixture(t);
  const accepted = commitManualTurn(f.store, { ...envelope(f.started.root.id, "whisper"), payload: payload(whisper) });
  const closure = requestEpisodeClosure(f.store, { ...envelope(accepted.commit.id, "close"), payload: { label: "Whisper" } });
  await assert.rejects(runEpisodeMemoryJob(f.store, { ownerScope: "local", simulationId: "scopes", jobId: closure.job.id }, {
    writeMemory() { throw new Error("Model callback failed"); }, extractBeliefs() { return []; },
  }), /Model callback failed/);
  assert.equal(projectBranch(f.store, envelope(closure.commit.id, "read")).episodeMemories.length, 0);
  assert.equal(projectBranch(f.store, envelope(closure.commit.id, "read")).transcript.length, 1);
  await f.restart();
  let calls = 0;
  await runEpisodeMemoryJob(f.store, { ownerScope: "local", simulationId: "scopes", jobId: closure.job.id }, {
    writeMemory(input) {
      calls++;
      assert.equal(input.turns.length, 1);
      assert.equal("performance" in input.turns[0]!, false);
      if (input.actor.id === "nell") {
        assert.equal(input.turns[0]!.text, heardWhisper);
        assert.doesNotMatch(JSON.stringify(input), /The key is under|baseAudience|projections|fallback/);
      }
      return input.turns.map(t => t.text).join("\n");
    }, extractBeliefs() { return []; },
  });
  assert.equal(calls, 3);
  const runtime = projectRoutingContext(f.store, { ...envelope(closure.commit.id, "runtime"), payload: {
    actorId: "nell", audience: [], stageWhisperIds: [], runtimeProfile: { id: "test", version: "v1" },
    promptPolicy: { id: ACTOR_KNOWLEDGE_POLICY, version: "v1" }, outputSchema: { id: "audience-proposal", digest: "v1" }, skillDigests: [],
    routing: { version: 3, completeWhisper: "", initialAudience: [], correctedAudience: null, correction: "", preservedText: null, sourceDraftId: null },
  } }, []);
  assert.doesNotMatch(JSON.stringify(runtime), /The key is under|baseAudience|sourceOffset|hiddenSpan/);
  const archive = f.store.exportSimulation("local", "scopes");
  validateSimulationArchive(archive);
  const imported = await openBranchStore(path.join(f.root, "imported.sqlite")).open();
  try {
    imported.importSimulation(archive);
    assert.deepEqual(projectBranch(imported, envelope(closure.commit.id, "read")).perceptions, projectBranch(f.store, envelope(closure.commit.id, "read")).perceptions);
    assert.equal(inspectActorContext(imported, { ...envelope(closure.commit.id, "read"), actorId: "nell", audience: [] }).subjective.transcript[0]!.text, heardWhisper);
  } finally { imported.close(); }
});

test("forged stored projections are rejected; historical scoped edits remain sibling-local and portable", async t => {
  const f = await fixture(t);
  const accepted = commitManualTurn(f.store, { ...envelope(f.started.root.id, "whisper"), payload: payload(whisper) });
  const original = accepted.commit.events.find(e => e.type === "message_accepted")!;
  if (original.type !== "message_accepted") throw new Error("missing turn");
  const changed = await createSavedAlternative(f.store, undefined, {
    ownerScope: "local", simulationId: "scopes", sourceBranchId: "main", expectedHead: accepted.commit.id,
    sourceCommitId: accepted.commit.id, messageVersionId: original.message.id, logicalMessageId: original.message.logicalMessageId,
    actorId: "corin", commandId: "edit-scopes", action: "manual", audience: ["mara", "nell"], audienceSyntax: "scoped-v1", manualText: movement,
  });
  assert.equal(changed.operation.status, "saved");
  const alternate = changed.operation.outcome!;
  assert.equal(inspectActorContext(f.store, { ownerScope: "local", simulationId: "scopes", branchId: alternate.branchId, actorId: "nell", audience: [] }).subjective.transcript[0]!.text, '"The key is under the ferry rope."');
  assert.equal(inspectActorContext(f.store, { ...envelope(accepted.commit.id, "read"), actorId: "nell", audience: [] }).subjective.transcript[0]!.text, heardWhisper);
  forkBranch(f.store, { ownerScope: "local", simulationId: "scopes", sourceBranchId: "main", expectedHead: accepted.commit.id,
    atCommitId: f.started.root.id, branchId: "before", commandId: "fork-before" });
  assert.equal(inspectActorContext(f.store, { ownerScope: "local", simulationId: "scopes", branchId: "before", actorId: "nell", audience: [] }).subjective.transcript.length, 0);
  const archive = f.store.exportSimulation("local", "scopes");
  validateSimulationArchive(archive);
  const forged = structuredClone(archive);
  const event = forged.commits.find(c => c.id === accepted.commit.id)!.events[0]!;
  if (event.type !== "message_accepted") throw new Error("missing turn");
  event.message.performance!.projections.find(p => p.actorId === "nell")!.text = visibleWhisper;
  assert.throws(() => validateSimulationArchive(forged));
});

test("CLI scoped authoring commits once, inspects only perceived content and retries the captured turn", async t => {
  const f = await fixture(t);
  const run = promisify(execFile);
  const cli = async (args: string[]) => {
    const result = await run(process.execPath, [path.resolve("src/cli/index.ts"), ...args, "--db", f.db, "--simulation", "scopes", "--json"]);
    return JSON.parse(result.stdout);
  };
  const args = ["turn", "corin", "--manual", whisper, "--audience-syntax", "scoped-fallback-v1",
    "--branch", "main", "--expected-head", f.started.root.id, "--command", "cli-whisper"];
  const accepted = await cli(args);
  const context = await cli(["context", "nell", "--branch", "main"]);
  assert.equal(context.subjective.transcript[0].text, heardWhisper);
  assert.doesNotMatch(JSON.stringify(context), /The key is under|baseAudience|projections|fallback/);
  const replay = await cli(args);
  assert.equal(replay.commit.id, accepted.commit.id);
  assert.equal(replay.turn.id, accepted.turn.id);
  assert.equal(projectBranch(f.store, envelope(accepted.commit.id, "read")).transcript.length, 1);
});

test("body-only correction persists fresh projections and rejects audience changes without affecting the original path", async t => {
  const f = await fixture(t);
  const accepted = commitManualTurn(f.store, { ...envelope(f.started.root.id, "whisper"), payload: payload(whisper) });
  const message = projectBranch(f.store, envelope(accepted.commit.id, "read")).transcript[0]!;
  const corrected = correctTurnBody(f.store, { ownerScope: "local", simulationId: "scopes", sourceBranchId: "main",
    expectedHead: accepted.commit.id, commandId: "correct", payload: { messageVersionId: message.messageVersionId!, text: whisper.replace("ferry rope", "purple lantern") } });
  const query = { ownerScope: "local", simulationId: "scopes", branchId: corrected.branch.id, audience: [] };
  assert.match(inspectActorContext(f.store, { ...query, actorId: "mara" }).subjective.transcript[0]!.text, /purple lantern/);
  assert.equal(inspectActorContext(f.store, { ...query, actorId: "nell" }).subjective.transcript[0]!.text, heardWhisper);
  assert.equal(inspectActorContext(f.store, { ...envelope(accepted.commit.id, "read"), actorId: "mara", audience: [] }).subjective.transcript[0]!.text, visibleWhisper);
  assert.throws(() => correctTurnBody(f.store, { ownerScope: "local", simulationId: "scopes", sourceBranchId: corrected.branch.id,
    expectedHead: corrected.commit.id, commandId: "routing-change", payload: { messageVersionId: message.messageVersionId!, text: whisper.replace('#Mara("', '#Nell("') } }), /Audience changes/);
  validateSimulationArchive(f.store.exportSimulation("local", "scopes"));
  await f.restart();
  assert.match(inspectActorContext(f.store, { ...query, actorId: "corin" }).subjective.transcript[0]!.text, /purple lantern/);
});

test("standalone Reverie source and reflection callbacks receive only the observer projection", {
  skip: !process.env.DOXVELT_REVERIE_EXECUTABLE && "Set DOXVELT_REVERIE_EXECUTABLE for native source/reflection verification.",
}, async t => {
  const f = await fixture(t);
  const accepted = commitManualTurn(f.store, { ...envelope(f.started.root.id, "whisper"), payload: payload(whisper) });
  commitManualTurn(f.store, { ...envelope(accepted.commit.id, "thought"), payload: payload("#Corin(PRIVATE_THOUGHT)") });
  const captures: string[] = [];
  const memory = new EpisodeMemory({ directory: path.join(f.root, "reverie"), executable: process.env.DOXVELT_REVERIE_EXECUTABLE!, modelKey: "deterministic", async reflect(request) {
    const content = JSON.stringify(request.input);
    captures.push(content);
    assert.doesNotMatch(content, /baseAudience|projections|sourceOffsets|"recipients"/);
    if (content.includes("[unintelligible]")) assert.doesNotMatch(content, /The key is under|PRIVATE_THOUGHT/);
    return JSON.stringify({ memories: [{ gist: "I remember what I perceived.", detail: "", feeling: "", cues: ["ferry"], salience: 0.8, confidence: 0.7, sourceMessageIds: ["m1"] }], impressions: [] });
  } });
  try {
    const query = { ownerScope: "local", simulationId: "scopes", branchId: "main" };
    memory.setDate(f.store, query, "first", "2026-01-01");
    const result = await memory.memorize(f.store, query, "first");
    assert.equal(result.status, "published");
    assert.equal(captures.length, 3);
    assert.equal((await memory.memorize(f.store, query, "first")).status, "current");
    assert.equal(captures.length, 3, "safe retry must reuse the accepted memory publication");
  } finally { memory.close(); }
});
