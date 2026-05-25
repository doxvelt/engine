import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DoxveltGenerationError, describeModelForDiagnostics, generateDoxveltText } from "../src/ai/generate.ts";
import { createRetainedBeliefDraft, weakenRetainedStrength } from "../src/core/beliefs.ts";
import { compileWorld } from "../src/core/compiler.ts";
import { assembleActorContext } from "../src/core/context.ts";
import { closeEpisode } from "../src/core/episode.ts";
import { parseFrontmatter } from "../src/core/frontmatter.ts";
import { initWorld } from "../src/core/init.ts";
import { loadModelRecord } from "../src/core/models.ts";
import type { AssetRecord, EntityRecord, SimulationRecord, TranscriptTurn } from "../src/core/types.ts";
import { openRuntimeStore } from "../src/store/sqlite.ts";

const execFileAsync = promisify(execFile);

test("initWorld creates a sparse compilable scaffold", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");

  await initWorld(worldPath);
  const compiled = await compileWorld(worldPath);

  assert.equal(compiled.entities.length, 1);
  assert.equal(compiled.scenarios.at(0)?.id, "scenario");
  assert.ok(compiled.models.some((model) => model.id === "local-openai-compatible"));
  assert.ok(compiled.beliefs.length >= 1);
  assert.ok(compiled.beliefs.at(0)?.sourceSpan.file);
});

test("initWorld can seed the executive interviews example", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);

  assert.equal(compiled.entities.length, 3);
  assert.equal(compiled.scenarios.at(0)?.id, "executive-interviews");
  assert.ok(compiled.models.some((model) => model.id === "local-openai-compatible"));
  assert.ok(compiled.beliefs.length >= 5);
  assert.ok(compiled.beliefs.at(0)?.sourceSpan.file);
});

test("initWorld template lookup works outside the repository root", async (context) => {
  const previousCwd = process.cwd();
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");

  try {
    process.chdir(root);
    await initWorld(worldPath, { template: "executive-interviews" });
  } finally {
    process.chdir(previousCwd);
  }

  const compiled = await compileWorld(worldPath);
  assert.equal(compiled.entities.length, 3);
});

test("initWorld rejects unknown templates", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");

  await assert.rejects(
    () => initWorld(worldPath, { template: "missing-template" }),
    /Unknown Doxvelt init template/
  );
});

test("compiled example source is inspectable without running init", async () => {
  const compiled = await compileWorld("examples/executive-interviews");

  assert.equal(compiled.entities.length, 3);
  assert.equal(compiled.scenarios.at(0)?.id, "executive-interviews");
});

test("frontmatter parser accepts yaml-only files with closing fence at EOF", () => {
  const parsed = parseFrontmatter("---\nid: local\nprovider: openai-compatible\n---");

  assert.equal(parsed.data.id, "local");
  assert.equal(parsed.data.provider, "openai-compatible");
  assert.equal(parsed.body, "");
});

test("OpenAI-compatible model diagnostics normalize valid base URLs", () => {
  const model = modelRecord({
    base_url: "http://localhost:11434/v1/"
  });

  assert.match(describeModelForDiagnostics(model), /Base URL: http:\/\/localhost:11434\/v1/);
});

test("AI generation reports invalid OpenAI-compatible base URLs without SDK retry noise", async () => {
  const model = modelRecord({
    base_url: "https://https://inf1-ein.tail8a1c20.ts.net/v1"
  });

  await assert.rejects(
    () =>
      generateDoxveltText({
        actorId: "coo",
        purpose: "turn",
        model,
        prompt: "Speak as the COO."
      }),
    (error) => {
      assert.ok(error instanceof DoxveltGenerationError);
      assert.match(error.message, /AI generation failed for turn actor coo/);
      assert.match(error.message, /invalid base_url metadata/);
      assert.match(error.message, /more than one URL scheme/);
      assert.doesNotMatch(error.message, /AI_RetryError/);
      return true;
    }
  );
});

test("runtime store saves compiled actors and manual turns", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });

    const actors = store.listActors("default");
    assert.deepEqual(
      actors.map((actor) => actor.id),
      ["ceo", "coo", "student-team"]
    );
    assert.deepEqual(store.listCompiledRecords<AssetRecord>("default", "model"), []);

    const model = await loadModelRecord(compiled.sourceRoot, "local-openai-compatible");
    assert.equal(model?.metadata.provider, "openai-compatible");

    const turn = store.appendTurn({
      simulationId: "default",
      actorId: "ceo",
      text: "The market is changing faster than our organization.",
      audience: ["ceo", "student-team"]
    });

    assert.equal(turn.actorId, "ceo");
    assert.equal(turn.audience.length, 2);
  } finally {
    store.close();
  }
});

test("actor context includes subjective beliefs and accessible transcript only", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });

    store.appendTurn({
      simulationId: "default",
      actorId: "ceo",
      text: "The board is worried about strategy drift.",
      audience: ["ceo", "student-team"]
    });

    store.appendTurn({
      simulationId: "default",
      actorId: "coo",
      text: "The supplier situation is worse than we are saying.",
      audience: ["coo"]
    });

    const simulation = store.getSimulation("default");
    assert.ok(simulation);

    const actor = store.getCompiledRecord<EntityRecord>("default", "entity", "ceo");
    assert.ok(actor);

    const context = assembleActorContext({
      simulation,
      actor,
      worlds: store.listCompiledRecords("default", "world"),
      scenario: store.getCompiledRecord("default", "scenario", "executive-interviews"),
      formats: store.listCompiledRecords("default", "format"),
      beliefs: store.listBeliefs("default"),
      turns: store.listAccessibleTurns("default", "ceo")
    });

    assert.equal(context.actor.id, "ceo");
    assert.ok(context.subjective.beliefs.every((belief) => belief.holder === "ceo"));
    assert.equal(context.subjective.transcript.length, 1);
    assert.match(context.promptPreview, /The board is worried/);
    assert.doesNotMatch(context.promptPreview, /supplier situation is worse/);
    assert.doesNotMatch(context.promptPreview, /operations team is hiding a supplier reliability problem/);
  } finally {
    store.close();
  }
});

test("actor context enforces subjective isolation without fixture source", () => {
  const simulation: SimulationRecord = {
    id: "test-sim",
    sourceRoot: "/tmp/no-world-source",
    scenarioId: "subjective-room",
    createdAt: "2026-05-22T00:00:00.000Z"
  };
  const actor = entityRecord("alice");
  const scenario = assetRecord("scenario", "subjective-room", [
    "@alice knows the safe code is 1234. :canonical :hidden",
    "@bob knows the vault is already empty. :canonical :hidden",
    "Everyone sees the lobby is open. :canonical"
  ].join("\n"));
  const beliefs = [
    beliefRecord("alice", "@alice believes @bob is nervous."),
    beliefRecord("bob", "@bob believes @alice is distracted.")
  ];
  const visibleTurns: TranscriptTurn[] = [
    turnRecord(1, "alice", "I will keep my part quiet.", ["alice"]),
    turnRecord(3, "bob", "The lobby is open.", ["alice", "bob"])
  ];

  const context = assembleActorContext({
    simulation,
    actor,
    worlds: [],
    scenario,
    formats: [],
    beliefs,
    turns: visibleTurns
  });

  assert.match(context.promptPreview, /safe code is 1234/);
  assert.doesNotMatch(context.promptPreview, /vault is already empty/);
  assert.match(context.promptPreview, /Everyone sees the lobby is open/);
  assert.deepEqual(
    context.subjective.beliefs.map((belief) => belief.propositionText),
    ["@alice believes @bob is nervous."]
  );
  assert.deepEqual(
    context.subjective.transcript.map((turn) => turn.id),
    [1, 3]
  );
});

test("actor context filters hidden scenario lines for other actors", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });

    const simulation = store.getSimulation("default");
    assert.ok(simulation);

    const actor = store.getCompiledRecord<EntityRecord>("default", "entity", "coo");
    assert.ok(actor);

    const context = assembleActorContext({
      simulation,
      actor,
      worlds: store.listCompiledRecords("default", "world"),
      scenario: store.getCompiledRecord("default", "scenario", "executive-interviews"),
      formats: store.listCompiledRecords("default", "format"),
      beliefs: store.listBeliefs("default"),
      turns: []
    });

    assert.match(context.promptPreview, /operations team is hiding a supplier reliability problem/);
    assert.doesNotMatch(context.promptPreview, /board is worried about strategy drift/);
    assert.match(context.assets.scenario?.body || "", /operations team is hiding a supplier reliability problem/);
    assert.doesNotMatch(context.assets.scenario?.body || "", /board is worried about strategy drift/);
  } finally {
    store.close();
  }
});

test("actor context includes affiliation beliefs through transitive membership access", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await writeMembershipWorld(worldPath);
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "membership-room",
      compiled
    });

    assert.deepEqual(
      store.listAccessLinks("default").map((link) => [link.member, link.container]),
      [
        ["alice", "inner-circle"],
        ["inner-circle", "mafia"]
      ]
    );

    const simulation = store.getSimulation("default");
    assert.ok(simulation);

    const actor = store.getCompiledRecord<EntityRecord>("default", "entity", "alice");
    assert.ok(actor);

    const actorContext = assembleActorContext({
      simulation,
      actor,
      worlds: [],
      scenario: store.getCompiledRecord("default", "scenario", "membership-room"),
      formats: [],
      beliefs: store.listBeliefs("default"),
      accessLinks: store.listAccessLinks("default"),
      turns: []
    });

    assert.deepEqual(
      actorContext.subjective.beliefs.map((belief) => belief.holder),
      ["alice", "inner-circle", "mafia"]
    );
    assert.deepEqual(
      actorContext.subjective.beliefAccess.map((access) => access.provenance),
      [
        {
          mode: "held",
          holder: "alice",
          sourceHolder: "alice",
          accessPath: ["alice"]
        },
        {
          mode: "accessed_through_membership",
          holder: "alice",
          sourceHolder: "inner-circle",
          accessPath: ["alice", "inner-circle"]
        },
        {
          mode: "accessed_through_membership",
          holder: "alice",
          sourceHolder: "mafia",
          accessPath: ["alice", "inner-circle", "mafia"]
        }
      ]
    );
    assert.match(actorContext.promptPreview, /held by @inner-circle; accessed through @alice -> @inner-circle/);
    assert.match(actorContext.promptPreview, /held by @mafia; accessed through @alice -> @inner-circle -> @mafia/);
    assert.match(actorContext.promptPreview, /@mafia treats the docks as controlled territory/);
  } finally {
    store.close();
  }
});

test("retained beliefs weaken when membership access is lost", () => {
  assert.equal(weakenRetainedStrength(3), 1);
  assert.equal(weakenRetainedStrength(1), 1);
  assert.equal(weakenRetainedStrength(0), 0);
  assert.equal(weakenRetainedStrength(-1), -1);
  assert.equal(weakenRetainedStrength(-3), -1);

  const sourceBelief = beliefRecord("mafia", "@mafia treats the docks as controlled territory.");
  const retained = createRetainedBeliefDraft({
    holder: "alice",
    sourceBelief,
    previousProvenance: {
      mode: "accessed_through_membership",
      holder: "alice",
      sourceHolder: "mafia",
      accessPath: ["alice", "inner-circle", "mafia"]
    }
  });

  assert.equal(retained.holder, "alice");
  assert.equal(retained.strength, 1);
  assert.equal(retained.propositionText, sourceBelief.propositionText);
  assert.deepEqual(retained.provenance, {
    mode: "retained_after_access_loss",
    holder: "alice",
    sourceHolder: "mafia",
    accessPath: ["alice", "inner-circle", "mafia"]
  });
});

test("runtime access events override compiled membership links", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await writeMembershipWorld(worldPath);
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "membership-room",
      compiled
    });

    store.appendRuntimeAccessEvent({
      simulationId: "default",
      action: "revoke",
      member: "inner-circle",
      container: "mafia",
      reason: "Inner Circle is cut off from Mafia logistics."
    });

    let effectiveLinks = store.listEffectiveAccessLinks("default");
    assert.deepEqual(
      effectiveLinks.map((link) => [link.member, link.container]),
      [["alice", "inner-circle"]]
    );

    const simulation = store.getSimulation("default");
    const actor = store.getCompiledRecord<EntityRecord>("default", "entity", "alice");
    assert.ok(simulation);
    assert.ok(actor);

    const revokedContext = assembleActorContext({
      simulation,
      actor,
      worlds: [],
      scenario: store.getCompiledRecord("default", "scenario", "membership-room"),
      formats: [],
      beliefs: store.listBeliefs("default"),
      accessLinks: effectiveLinks,
      turns: []
    });

    assert.deepEqual(
      revokedContext.subjective.beliefs.map((belief) => belief.holder),
      ["alice", "inner-circle"]
    );
    assert.doesNotMatch(revokedContext.promptPreview, /@mafia treats the docks as controlled territory/);

    store.appendRuntimeAccessEvent({
      simulationId: "default",
      action: "grant",
      member: "alice",
      container: "mafia",
      reason: "Alice receives direct emergency access."
    });

    effectiveLinks = store.listEffectiveAccessLinks("default");
    assert.deepEqual(
      effectiveLinks.map((link) => [link.member, link.container]),
      [
        ["alice", "inner-circle"],
        ["alice", "mafia"]
      ]
    );

    const grantedContext = assembleActorContext({
      simulation,
      actor,
      worlds: [],
      scenario: store.getCompiledRecord("default", "scenario", "membership-room"),
      formats: [],
      beliefs: store.listBeliefs("default"),
      accessLinks: effectiveLinks,
      turns: []
    });

    assert.deepEqual(
      grantedContext.subjective.beliefs.map((belief) => belief.holder),
      ["alice", "inner-circle", "mafia"]
    );
    assert.match(grantedContext.promptPreview, /accessed through @alice -> @mafia/);
  } finally {
    store.close();
  }
});

test("CLI access command records and lists runtime access events", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await writeMembershipWorld(worldPath);
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "membership-room",
      compiled
    });
  } finally {
    store.close();
  }

  const revoke = await runCli([
    "access",
    "revoke",
    "inner-circle",
    "mafia",
    "--reason",
    "Inner Circle is cut off from Mafia logistics.",
    "--db",
    dbPath,
    "--json"
  ]);

  assert.equal(revoke.event.action, "revoke");
  assert.deepEqual(
    revoke.effectiveAccessLinks.map((link: { member: string; container: string }) => [link.member, link.container]),
    [["alice", "inner-circle"]]
  );

  const grant = await runCli([
    "access",
    "grant",
    "alice",
    "mafia",
    "--reason",
    "Alice receives direct emergency access.",
    "--db",
    dbPath,
    "--json"
  ]);

  assert.equal(grant.event.action, "grant");

  const list = await runCli(["access", "list", "--db", dbPath, "--json"]);
  assert.deepEqual(
    list.accessEvents.map((event: { action: string; member: string; container: string }) => [
      event.action,
      event.member,
      event.container
    ]),
    [
      ["revoke", "inner-circle", "mafia"],
      ["grant", "alice", "mafia"]
    ]
  );
  assert.deepEqual(
    list.effectiveAccessLinks.map((link: { member: string; container: string }) => [link.member, link.container]),
    [
      ["alice", "inner-circle"],
      ["alice", "mafia"]
    ]
  );
});

test("stage whispers are private one-turn context", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });

    store.createStageWhisper({
      simulationId: "default",
      targetActorId: "ceo",
      text: "Do not reveal the board panic yet."
    });

    const simulation = store.getSimulation("default");
    const ceo = store.getCompiledRecord<EntityRecord>("default", "entity", "ceo");
    const coo = store.getCompiledRecord<EntityRecord>("default", "entity", "coo");
    assert.ok(simulation);
    assert.ok(ceo);
    assert.ok(coo);

    const ceoContext = assembleActorContext({
      simulation,
      actor: ceo,
      worlds: [],
      scenario: store.getCompiledRecord("default", "scenario", "executive-interviews"),
      formats: [],
      beliefs: store.listBeliefs("default"),
      stageWhispers: store.listPendingStageWhispers("default", "ceo"),
      turns: []
    });

    const cooContext = assembleActorContext({
      simulation,
      actor: coo,
      worlds: [],
      scenario: store.getCompiledRecord("default", "scenario", "executive-interviews"),
      formats: [],
      beliefs: store.listBeliefs("default"),
      stageWhispers: store.listPendingStageWhispers("default", "coo"),
      turns: []
    });

    assert.match(ceoContext.promptPreview, /Do not reveal the board panic yet/);
    assert.doesNotMatch(cooContext.promptPreview, /Do not reveal the board panic yet/);

    const turn = store.appendTurn({
      simulationId: "default",
      actorId: "ceo",
      text: "I will be measured about what I say.",
      audience: ["ceo", "student-team"]
    });

    assert.equal(store.listPendingStageWhispers("default", "ceo").length, 0);
    assert.equal(store.listStageWhispers("default").at(0)?.consumedTurnId, turn.id);
  } finally {
    store.close();
  }
});

test("CLI whisper command stores and turn command consumes stage whispers", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });
  } finally {
    store.close();
  }

  const stored = await runCli([
    "whisper",
    "ceo",
    "--text",
    "Keep the board panic private.",
    "--db",
    dbPath,
    "--json"
  ]);

  assert.equal(stored.whisper.targetActorId, "ceo");

  const contextBeforeTurn = await runCli(["context", "ceo", "--db", dbPath, "--json"]);
  assert.match(contextBeforeTurn.promptPreview, /Keep the board panic private/);

  const turn = await runCli([
    "turn",
    "ceo",
    "--manual",
    "I will keep the room calm.",
    "--db",
    dbPath,
    "--json"
  ]);

  assert.equal(turn.consumedStageWhispers.length, 1);

  const contextAfterTurn = await runCli(["context", "ceo", "--db", dbPath, "--json"]);
  assert.doesNotMatch(contextAfterTurn.promptPreview, /Keep the board panic private/);

  const inlineTurn = await runCli([
    "turn",
    "coo",
    "--manual",
    "I will not mention supplier risk yet.",
    "--whisper",
    "Deflect supplier questions.",
    "--db",
    dbPath,
    "--json"
  ]);

  assert.equal(inlineTurn.consumedStageWhispers.length, 1);
  assert.equal(inlineTurn.consumedStageWhispers.at(0)?.text, "Deflect supplier questions.");
});

test("audience events define default turn audience", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });

    store.appendAudienceEvent({
      simulationId: "default",
      action: "add",
      actorId: "student-team",
      reason: "Students enter the room."
    });
    store.appendAudienceEvent({
      simulationId: "default",
      action: "add",
      actorId: "coo",
      reason: "COO observes."
    });
    store.appendAudienceEvent({
      simulationId: "default",
      action: "deactivate",
      actorId: "coo",
      reason: "COO takes a private call."
    });

    assert.deepEqual(store.listActiveAudienceIds("default"), ["student-team"]);

    const turn = store.appendTurn({
      simulationId: "default",
      actorId: "ceo",
      text: "We should keep this simple.",
      audience: ["ceo", ...store.listActiveAudienceIds("default")]
    });

    assert.deepEqual(turn.audience, ["ceo", "student-team"]);
    assert.equal(store.listAccessibleTurns("default", "coo").length, 0);
    assert.equal(store.listAccessibleTurns("default", "student-team").length, 1);
  } finally {
    store.close();
  }
});

test("CLI audience command controls default turn audience", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });
  } finally {
    store.close();
  }

  await runCli(["audience", "add", "student-team", "--db", dbPath, "--json"]);
  await runCli(["audience", "add", "coo", "--db", dbPath, "--json"]);
  await runCli(["audience", "deactivate", "coo", "--db", dbPath, "--json"]);

  const list = await runCli(["audience", "list", "--db", dbPath, "--json"]);
  assert.deepEqual(list.activeAudience, ["student-team"]);

  const turn = await runCli([
    "turn",
    "ceo",
    "--manual",
    "We should keep this focused.",
    "--db",
    dbPath,
    "--json"
  ]);

  assert.deepEqual(turn.turn.audience, ["ceo", "student-team"]);

  const override = await runCli([
    "turn",
    "coo",
    "--manual",
    "I am speaking only to the CEO.",
    "--audience",
    "ceo",
    "--db",
    dbPath,
    "--json"
  ]);

  assert.deepEqual(override.turn.audience, ["coo", "ceo"]);
});

test("episode closure writes deterministic memories from accessible turns", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });

    store.appendTurn({
      simulationId: "default",
      actorId: "ceo",
      text: "The board is worried about strategy drift.",
      audience: ["ceo", "student-team"]
    });

    store.appendTurn({
      simulationId: "default",
      actorId: "coo",
      text: "The supplier situation is worse than we are saying.",
      audience: ["coo"]
    });

    const closure = await closeEpisode({ store, simulationId: "default", label: "Opening interviews" });
    const ceoMemory = closure.memories.find((memory) => memory.actorId === "ceo");
    const cooMemory = closure.memories.find((memory) => memory.actorId === "coo");

    assert.equal(closure.episode.label, "Opening interviews");
    assert.ok(ceoMemory);
    assert.ok(cooMemory);
    assert.match(ceoMemory.text, /board is worried/);
    assert.doesNotMatch(ceoMemory.text, /supplier situation is worse/);
    assert.match(cooMemory.text, /supplier situation is worse/);
    assert.equal(store.listEpisodeMemories("default").length, 2);
    assert.equal(closure.extractedBeliefs.length, 2);
    assert.equal(store.listExtractedBeliefs("default").length, 2);
    assert.ok(
      closure.extractedBeliefs.some((belief) => {
        return belief.holder === "ceo" && belief.propositionText.includes("accessible turn");
      })
    );
  } finally {
    store.close();
  }
});

test("episode closure only processes turns since the previous closure", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });

    store.appendTurn({
      simulationId: "default",
      actorId: "ceo",
      text: "First episode concern: the board is worried about strategy drift.",
      audience: ["ceo", "student-team"]
    });

    const firstClosure = await closeEpisode({ store, simulationId: "default", label: "First beat" });
    assert.equal(firstClosure.memories.length, 1);
    assert.equal(store.listUnclosedTurns("default").length, 0);

    store.appendTurn({
      simulationId: "default",
      actorId: "ceo",
      text: "Second episode concern: the pricing story is becoming harder to defend.",
      audience: ["ceo", "student-team"]
    });

    const secondClosure = await closeEpisode({ store, simulationId: "default", label: "Second beat" });
    const secondCeoMemory = secondClosure.memories.find((memory) => memory.actorId === "ceo");

    assert.ok(secondCeoMemory);
    assert.match(secondCeoMemory.text, /Second episode concern/);
    assert.doesNotMatch(secondCeoMemory.text, /First episode concern/);
    assert.equal(secondCeoMemory.sourceTurnIds.length, 1);
    assert.equal(store.listUnclosedTurns("default").length, 0);

    await assert.rejects(
      () => closeEpisode({ store, simulationId: "default", label: "Empty beat" }),
      /No unclosed turns/
    );
  } finally {
    store.close();
  }
});

test("episode closure can use injected AI-style generation", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const worldPath = path.join(root, "world");
  const dbPath = path.join(root, "runtime.sqlite");

  await initWorld(worldPath, { template: "executive-interviews" });
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: "default",
      sourceRoot: compiled.sourceRoot,
      scenarioId: "executive-interviews",
      compiled
    });

    store.appendTurn({
      simulationId: "default",
      actorId: "ceo",
      text: "The board is worried about strategy drift.",
      audience: ["ceo", "student-team"]
    });

    const closure = await closeEpisode({
      store,
      simulationId: "default",
      label: "Opening interviews",
      generator: {
        writeMemory({ actor, context }) {
          assert.equal(context.actor.id, actor.id);
          assert.match(context.promptPreview, /The board is worried/);
          return `I am ${actor.id}, and I now think the board pressure matters.`;
        },
        extractBeliefs({ actor, memory }) {
          return [
            {
              strength: 3,
              propositionText: `@${actor.id} treats board pressure as important after memory ${memory.id}.`
            },
            {
              strength: 99,
              propositionText: `@${actor.id} has an overconfident normalized belief.`
            }
          ];
        }
      }
    });

    assert.equal(closure.memories.length, 1);
    assert.equal(closure.extractedBeliefs.length, 2);
    assert.ok(closure.memories.every((memory) => memory.text.includes("board pressure matters")));
    assert.ok(closure.extractedBeliefs.every((belief) => belief.strength === 3));
    assert.equal(store.listBeliefHistory("default").length, compiled.beliefs.length + 2);
  } finally {
    store.close();
  }
});

async function createRepoLocalRunRoot(context: test.TestContext) {
  const root = path.resolve(".doxvelt", "test-runs");
  await mkdir(root, { recursive: true });
  const runRoot = await mkdtemp(path.join(root, "run-"));
  context.after(async () => {
    await rm(runRoot, { recursive: true, force: true });
  });
  return runRoot;
}

async function writeMembershipWorld(root: string): Promise<void> {
  const files = new Map([
    [
      "scenarios/membership-room.md",
      `---
id: membership-room
name: Membership Room
---

Everyone is meeting in the back room. :canonical
`
    ],
    [
      "entities/alice/IDENTITY.md",
      `---
id: alice
kind: agent
name: Alice
visibility: public
---

@alice is testing membership context.
`
    ],
    [
      "entities/alice/BELIEFS.md",
      "@alice treats her own assignment as urgent. :+3\n"
    ],
    [
      "entities/inner-circle/IDENTITY.md",
      `---
id: inner-circle
kind: affiliation
name: Inner Circle
visibility: public
---

@inner-circle is a nested group.
`
    ],
    [
      "entities/inner-circle/BELIEFS.md",
      "@inner-circle treats the password as changed. :+3\n"
    ],
    [
      "entities/mafia/IDENTITY.md",
      `---
id: mafia
kind: affiliation
name: Mafia
visibility: public
---

@mafia is a larger faction.
`
    ],
    [
      "entities/mafia/BELIEFS.md",
      "@mafia treats the docks as controlled territory. :+3\n"
    ],
    [
      "connections/alice-inner-circle.md",
      `---
id: alice-inner-circle
kind: connection
entities: [alice, inner-circle]
---

@inner-circle gives @alice access. :access:member
`
    ],
    [
      "connections/inner-circle-mafia.md",
      `---
id: inner-circle-mafia
kind: connection
entities: [inner-circle, mafia]
---

This connection gives @inner-circle access to @mafia knowledge. :access:member
`
    ]
  ]);

  for (const relativePath of files.keys()) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  }

  for (const [relativePath, content] of files.entries()) {
    await writeFile(path.join(root, relativePath), content);
  }
}

async function runCli(args: string[]): Promise<any> {
  const result = await execFileAsync(process.execPath, ["src/cli/index.ts", ...args], {
    cwd: process.cwd()
  });

  return JSON.parse(result.stdout);
}

function modelRecord(metadata: AssetRecord["metadata"]): AssetRecord {
  return {
    id: "local-openai-compatible",
    kind: "model",
    name: "local-openai-compatible",
    path: "models/local-openai-compatible.yaml",
    metadata: {
      id: "local-openai-compatible",
      provider: "openai-compatible",
      model: "llama3.1",
      ...metadata
    },
    body: ""
  };
}

function entityRecord(id: string): EntityRecord {
  return {
    id,
    kind: "agent",
    name: id,
    visibility: "public",
    folder: `entities/${id}`,
    files: []
  };
}

function assetRecord(kind: AssetRecord["kind"], id: string, body: string): AssetRecord {
  return {
    id,
    kind,
    name: id,
    path: `${kind}s/${id}.md`,
    metadata: { id },
    body
  };
}

function beliefRecord(holder: string, propositionText: string) {
  return {
    holder,
    strength: 3,
    propositionText,
    mentions: [],
    sourceSpan: {
      file: "inline",
      line: 1,
      quote: propositionText
    }
  };
}

function turnRecord(id: number, actorId: string, text: string, audience: string[]): TranscriptTurn {
  return {
    id,
    simulationId: "test-sim",
    actorId,
    text,
    audience,
    episodeId: null,
    createdAt: "2026-05-22T00:00:00.000Z"
  };
}
