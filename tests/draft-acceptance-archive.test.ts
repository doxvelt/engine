import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acceptActorTurnDraft, generateActorTurnDraft } from "../src/core/draft-lifecycle.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { fingerprintCommand } from "../src/core/domain-rules.ts";
import {
  commitManualTurn,
  editAcceptedMessage,
  forkBranch,
  regenerateAcceptedResponse,
  startBranchSimulation,
} from "../src/core/branch-kernel.ts";
import type { SimulationArchive } from "../src/core/ports.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";

const workspace = path.resolve("examples/executive-interviews");

async function acceptedArchive(
  t: test.TestContext,
  finalText: string | null = "Edited archive response.",
): Promise<SimulationArchive> {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-accept-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  try {
    const started = await startBranchSimulation(store, {
      ownerScope: "owner",
      simulationId: "sim",
      commandId: "start",
      workspacePath: workspace,
      scenarioId: "executive-interviews",
      branchId: "main",
    });
    const whisper = store.createStageWhisper({
      ownerScope: "owner",
      simulationId: "sim",
      branchId: "main",
      expectedHead: started.root.id,
      commandId: "whisper",
      targetActorId: "ceo",
      text: "Archive-private direction.",
    });
    const secondWhisper = store.createStageWhisper({
      ownerScope: "owner",
      simulationId: "sim",
      branchId: "main",
      expectedHead: started.root.id,
      commandId: "whisper-second",
      targetActorId: "ceo",
      text: "Second archive-private direction.",
    });
    const generated = await generateActorTurnDraft(
      store,
      new DeterministicFakeRuntime([
        { type: "completed", text: "Generated archive response.", usage: { inputTokens: 2, outputTokens: 3 } },
      ]),
      {
        ownerScope: "owner",
        simulationId: "sim",
        branchId: "main",
        expectedHead: started.root.id,
        commandId: "generate",
        payload: {
          actorId: "ceo",
          audience: ["cfo"],
          stageWhisperIds: [whisper.id, secondWhisper.id],
          runtimeProfile: { id: "character", version: "v1" },
          promptPolicy: { id: "default", version: "v1" },
          outputSchema: { id: "screenplay", digest: "schema-v1" },
          skillDigests: [],
        },
      },
    );
    const accepted = acceptActorTurnDraft(store, {
      ownerScope: "owner",
      simulationId: "sim",
      draftId: generated.draft.id,
      commandId: "accept",
      ...(finalText === null ? {} : { finalText }),
    });
    const later = commitManualTurn(store, {
      ownerScope: "owner",
      simulationId: "sim",
      branchId: "main",
      expectedHead: accepted.commit.id,
      commandId: "later-turn",
      payload: {
        actorId: "cfo",
        text: "Later canonical turn.",
        audience: ["ceo"],
      },
    });
    forkBranch(store, {
      ownerScope: "owner",
      simulationId: "sim",
      sourceBranchId: "main",
      expectedHead: later.commit.id,
      atCommitId: later.commit.id,
      branchId: "later-fork",
      commandId: "later-fork-command",
      name: "Later fork",
    });
    return store.exportSimulation("owner", "sim");
  } finally {
    store.close();
  }
}

type Mutable = Record<string, any>;

type AcceptanceCommand = SimulationArchive["commandResults"][number] & {
  canonicalInput: Extract<
    SimulationArchive["commandResults"][number]["canonicalInput"],
    { kind: "accept_draft" }
  >;
};


function acceptance(archive: SimulationArchive): AcceptanceCommand {
  const command = archive.commandResults.find((item) => item.commandId === "accept");
  if (!command || command.canonicalInput.kind !== "accept_draft")
    throw new Error("missing acceptance receipt");
  return command as AcceptanceCommand;
}

test("schema-v6 archives semantically bind edited generated turns without portable prompt context", async (t) => {
  const archive = await acceptedArchive(t);
  assert.equal(archive.schemaVersion, 6);
  validateSimulationArchive(archive);
  const command = acceptance(archive);
  const receiptJson = JSON.stringify(command.canonicalInput.payload);
  assert.equal(receiptJson.includes("promptPreview"), false);
  assert.equal(receiptJson.includes("Generated archive response."), true);
  assert.equal(Object.hasOwn(command.canonicalInput.payload, "context"), false);
  assert.equal(Object.hasOwn(command.canonicalInput.payload, "prompt"), false);

  const variants: Array<(archive: SimulationArchive) => void> = [
    (value) => {
      const item = acceptance(value);
      item.canonicalInput.payload.generatedArtifact.provenance.stopReason = "tool_use";
    },
    (value) => {
      const item = acceptance(value);
      item.canonicalInput.payload.accepted = {
        textSource: "acceptor_edited",
        text: item.canonicalInput.payload.generatedArtifact.text,
      };
    },
    (value) => {
      const commit = value.commits.find((item) => item.commandId === "accept")!;
      const message = commit.events.find((item) => item.type === "message_accepted");
      if (message?.type !== "message_accepted") throw new Error("missing message");
      message.message.text = "forged final text";
    },
    (value) => {
      const commit = value.commits.find((item) => item.commandId === "accept")!;
      commit.events.reverse();
    },
  ];
  for (const mutate of variants) {
    const forged = structuredClone(archive);
    mutate(forged);
    const command = acceptance(forged);
    command.fingerprint = fingerprintCommand(command.canonicalInput);
    assert.throws(() => validateSimulationArchive(forged));
  }
});

test("legacy v4 and v5 archives reject generated receipts and provenance", async (t) => {
  const archive = await acceptedArchive(t);
  for (const schemaVersion of [4, 5] as const) {
    const forged = structuredClone(archive);
    forged.schemaVersion = schemaVersion;
    assert.throws(() => validateSimulationArchive(forged));
  }
});

function acceptanceCommit(archive: SimulationArchive) {
  const commit = archive.commits.find((item) => item.commandId === "accept");
  if (!commit) throw new Error("missing acceptance commit");
  return commit;
}

function refresh(command: SimulationArchive["commandResults"][number]) {
  command.fingerprint = fingerprintCommand(command.canonicalInput);
}

function syncAcceptanceCommit(archive: SimulationArchive) {
  const command = acceptance(archive);
  assert.equal(command.result.kind, "commit", "acceptance must have a commit result");
  command.result.commit = structuredClone(acceptanceCommit(archive));
}

function whisperRecord(archive: SimulationArchive, commandId = "whisper") {
  const command = archive.commandResults.find((item) => item.commandId === commandId);
  assert.ok(command && command.result.kind === "whisper", "whisper result must exist");
  const whisper = archive.stageWhispers.find((item) => item.commandId === commandId);
  assert.ok(whisper, "whisper record must exist");
  return { command, whisper };
}

function syncWhisper(archive: SimulationArchive, commandId = "whisper") {
  const { command, whisper } = whisperRecord(archive, commandId);
  if (command.result.kind === "whisper") command.result.whisper = structuredClone(whisper);
}

async function assertArchiveRejects(
  t: test.TestContext,
  archive: SimulationArchive,
  expected: RegExp,
  label: string,
) {
  assert.throws(() => validateSimulationArchive(archive), expected, label);
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-accept-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  try {
    assert.throws(() => store.importSimulation(archive), expected, label);
    assert.equal(store.getSimulation("owner", "sim"), null, `${label} imported state`);
  } finally {
    store.close();
  }
}
test("v6 archive matrix binds envelope, receipt, artifact, and derived events", async (t) => {
  const source = await acceptedArchive(t);
  const cases: Array<[string, (archive: SimulationArchive) => void, RegExp]> = [
    ["owner", (a) => { (acceptance(a).canonicalInput as Mutable).ownerScope = "forged"; refresh(acceptance(a)); }, /outcome structure mismatch/],
    ["simulation", (a) => { (acceptance(a).canonicalInput as Mutable).simulationId = "forged"; refresh(acceptance(a)); }, /outcome structure mismatch/],
    ["branch", (a) => { (acceptance(a).canonicalInput as Mutable).branchId = "forged"; refresh(acceptance(a)); }, /outcome structure mismatch/],
    ["head", (a) => { (acceptance(a).canonicalInput as Mutable).expectedHead = "forged"; refresh(acceptance(a)); }, /accepted draft basis mismatch/],
    ["command", (a) => { (acceptance(a).canonicalInput as Mutable).commandId = "forged"; refresh(acceptance(a)); }, /outcome structure mismatch/],
    ["fingerprint", (a) => { acceptance(a).fingerprint = "0".repeat(64); }, /fingerprint mismatch/],
    ["draft id", (a) => { (acceptance(a).canonicalInput.payload as Mutable).draftId = "forged"; refresh(acceptance(a)); }, /accepted draft basis mismatch/],
    ["generation id", (a) => { (acceptance(a).canonicalInput.payload as Mutable).generationCommandId = "forged"; refresh(acceptance(a)); }, /accepted draft basis mismatch/],
    ["content revision", (a) => { (acceptance(a).canonicalInput.payload as Mutable).contentRevisionId = "forged"; refresh(acceptance(a)); }, /accepted draft basis mismatch/],
    ["actor", (a) => { (acceptance(a).canonicalInput.payload as Mutable).actorId = "cfo"; refresh(acceptance(a)); }, /audience is not normalized/],
    ["audience order", (a) => { (acceptance(a).canonicalInput.payload as Mutable).audience.reverse(); refresh(acceptance(a)); }, /audience is not normalized/],
    ["duplicate audience", (a) => { const r = acceptance(a).canonicalInput.payload as Mutable; r.audience.push(r.audience[0]); refresh(acceptance(a)); }, /input structure mismatch/],
    ["runtime profile", (a) => { (acceptance(a).canonicalInput.payload as Mutable).runtimeProfile.id = "forged"; refresh(acceptance(a)); }, /artifact provenance is invalid/],
    ["artifact runtime profile duplication", (a) => { (acceptance(a).canonicalInput.payload as Mutable).generatedArtifact.provenance.runtimeProfile.id = "forged"; refresh(acceptance(a)); }, /artifact provenance is invalid/],
    ["prompt policy", (a) => { (acceptance(a).canonicalInput.payload as Mutable).promptPolicy.id = "https://host/policy"; refresh(acceptance(a)); }, /input structure mismatch/],
    ["output schema", (a) => { (acceptance(a).canonicalInput.payload as Mutable).outputSchema.digest = ""; refresh(acceptance(a)); }, /input structure mismatch/],
    ["duplicate skill", (a) => { const r = acceptance(a).canonicalInput.payload as Mutable; r.skillDigests.push(r.skillDigests[0]); refresh(acceptance(a)); }, /input structure mismatch/],
    ["context hash", (a) => { (acceptance(a).canonicalInput.payload as Mutable).contextHash = "bad"; refresh(acceptance(a)); }, /input structure mismatch/],
    ["prompt hash", (a) => { (acceptance(a).canonicalInput.payload as Mutable).promptHash = "bad"; refresh(acceptance(a)); }, /input structure mismatch/],
    ["artifact digest", (a) => { (acceptance(a).canonicalInput.payload as Mutable).generatedArtifact.digest = "0".repeat(64); refresh(acceptance(a)); }, /input structure mismatch/],
    ["usage input", (a) => { (acceptance(a).canonicalInput.payload as Mutable).generatedArtifact.provenance.usage.inputTokens = -1; refresh(acceptance(a)); }, /input structure mismatch/],
    ["usage output", (a) => { (acceptance(a).canonicalInput.payload as Mutable).generatedArtifact.provenance.usage.outputTokens = 1.5; refresh(acceptance(a)); }, /input structure mismatch/],
    ["usage total", (a) => { (acceptance(a).canonicalInput.payload as Mutable).generatedArtifact.provenance.usage.totalTokens = 99; refresh(acceptance(a)); }, /input structure mismatch/],
    ["terminal status", (a) => { (acceptance(a).canonicalInput.payload as Mutable).generatedArtifact.provenance.terminalStatus = "failed"; refresh(acceptance(a)); }, /input structure mismatch/],
    ["invalid stop", (a) => { (acceptance(a).canonicalInput.payload as Mutable).generatedArtifact.provenance.stopReason = "tool_use"; refresh(acceptance(a)); }, /input structure mismatch|artifact provenance is invalid/],
    ["edited equals generated", (a) => { const r = acceptance(a).canonicalInput.payload as Mutable; r.accepted.text = r.generatedArtifact.text; refresh(acceptance(a)); }, /edit must differ/],
    ["message id", (a) => { ((acceptanceCommit(a).events[0] as Mutable).message as Mutable).id = "forged"; syncAcceptanceCommit(a); }, /event sequence is invalid/],
    ["logical message id", (a) => { ((acceptanceCommit(a).events[0] as Mutable).message as Mutable).logicalMessageId = "forged"; syncAcceptanceCommit(a); }, /event sequence is invalid/],
    ["message actor", (a) => { ((acceptanceCommit(a).events[0] as Mutable).message as Mutable).actorId = "cfo"; syncAcceptanceCommit(a); }, /event sequence is invalid/],
    ["message audience", (a) => { ((acceptanceCommit(a).events[0] as Mutable).message as Mutable).audience = ["ceo"]; syncAcceptanceCommit(a); }, /event sequence is invalid/],
    ["message provenance mode", (a) => { ((acceptanceCommit(a).events[0] as Mutable).message as Mutable).provenance.mode = "manual"; syncAcceptanceCommit(a); }, /invalid message provenance|invalid generated message operation|event sequence is invalid/],
    ["message provenance operation", (a) => { ((acceptanceCommit(a).events[0] as Mutable).message as Mutable).provenance.operation = "edit"; syncAcceptanceCommit(a); }, /invalid message provenance|invalid generated message operation|event sequence is invalid/],
    ["message provenance artifact", (a) => { ((acceptanceCommit(a).events[0] as Mutable).message as Mutable).provenance.sourceArtifactDigest = "0".repeat(64); syncAcceptanceCommit(a); }, /invalid message provenance|event sequence is invalid/],
    ["message provenance attribution", (a) => { ((acceptanceCommit(a).events[0] as Mutable).message as Mutable).provenance.finalTextSource = "generated_verbatim"; syncAcceptanceCommit(a); }, /invalid message provenance|event sequence is invalid/],
    ["message text", (a) => { ((acceptanceCommit(a).events[0] as Mutable).message as Mutable).text = "forged"; syncAcceptanceCommit(a); }, /event sequence is invalid/],
    ["commit scope", (a) => { acceptanceCommit(a).ownerScope = "forged"; syncAcceptanceCommit(a); }, /commit scope does not match its simulation/],
    ["commit kind", (a) => { acceptanceCommit(a).kind = "effects"; syncAcceptanceCommit(a); }, /accepted draft basis mismatch/],
    ["commit command", (a) => { const commit = acceptanceCommit(a); commit.commandId = "forged"; const result = acceptance(a).result; if (result.kind === "commit") result.commit = structuredClone(commit); }, /outcome structure mismatch/],
    ["commit parent", (a) => { acceptanceCommit(a).parentCommitId = "forged"; syncAcceptanceCommit(a); }, /commit parent is missing/],
    ["result commit exact", (a) => { ((acceptance(a).result as Mutable).commit as Mutable).createdAt = "2026-01-01T00:00:00.000Z"; }, /accepted draft basis mismatch/],
    ["result branch scope", (a) => { ((acceptance(a).result as Mutable).branch as Mutable).ownerScope = "forged"; }, /outcome structure mismatch/],
    ["result branch head", (a) => { ((acceptance(a).result as Mutable).branch as Mutable).headCommitId = "forged"; }, /accepted draft basis mismatch/],
    ["result branch name", (a) => { ((acceptance(a).result as Mutable).branch as Mutable).name = "forged"; }, /accepted draft basis mismatch/],
    ["result branch origin", (a) => { ((acceptance(a).result as Mutable).branch as Mutable).origin = { kind: "root" }; }, /outcome structure mismatch/],
    ["result branch created", (a) => { ((acceptance(a).result as Mutable).branch as Mutable).createdAt = "2026-01-01T00:00:00.000Z"; }, /accepted draft basis mismatch/],
    ["later fork crossbinding", (a) => { const command = acceptance(a); (command.canonicalInput as Mutable).branchId = "later-fork"; (command.result as Mutable).branch = structuredClone(a.branches.find((item) => item.id === "later-fork")); refresh(command); }, /accepted draft basis mismatch/],
    ["whisper missing", (a) => { (acceptance(a).canonicalInput.payload as Mutable).stageWhispers.shift(); refresh(acceptance(a)); }, /event sequence is invalid/],
    ["whisper extra", (a) => { const r = acceptance(a).canonicalInput.payload as Mutable; r.stageWhispers.push({ id: "forged", text: "forged" }); refresh(acceptance(a)); }, /accepted draft whisper snapshot is invalid/],
    ["whisper order", (a) => { (acceptance(a).canonicalInput.payload as Mutable).stageWhispers.reverse(); refresh(acceptance(a)); }, /event sequence is invalid/],
    ["whisper scope", (a) => { whisperRecord(a).whisper.ownerScope = "forged"; syncWhisper(a); }, /stage whisper is invalid|input whisper mismatch/],
    ["whisper branch", (a) => { whisperRecord(a).whisper.branchId = "forged"; syncWhisper(a); }, /stage whisper is invalid|input whisper mismatch/],
    ["whisper head", (a) => { whisperRecord(a).whisper.expectedHead = "forged"; syncWhisper(a); }, /stage whisper is invalid|input whisper mismatch/],
    ["whisper actor", (a) => { whisperRecord(a).whisper.targetActorId = "cfo"; syncWhisper(a); }, /stage whisper is invalid|input whisper mismatch/],
    ["whisper text", (a) => { whisperRecord(a).whisper.text = "forged"; syncWhisper(a); }, /stage whisper is invalid|input whisper mismatch/],
    ["first impression missing", (a) => { const events = acceptanceCommit(a).events; const index = events.findIndex((event) => event.type === "first_impression_formed"); assert.notEqual(index, -1, "first impression must exist"); events.splice(index, 1); syncAcceptanceCommit(a); }, /event sequence is invalid/],
    ["first impression extra", (a) => { const event = acceptanceCommit(a).events.find((item) => item.type === "first_impression_formed"); assert.ok(event, "first impression must exist"); acceptanceCommit(a).events.push(structuredClone(event)); syncAcceptanceCommit(a); }, /event sequence is invalid/],
    ["first impression forged", (a) => { const event = acceptanceCommit(a).events.find((item) => item.type === "first_impression_formed"); assert.ok(event && event.type === "first_impression_formed", "first impression must exist"); event.impression.propositionText = "forged"; syncAcceptanceCommit(a); }, /event sequence is invalid/],
    ["first impression reordered", (a) => { const events = acceptanceCommit(a).events; const indices = events.flatMap((event, index) => event.type === "first_impression_formed" ? [index] : []); assert.equal(indices.length, 2, "fixture must have two first impressions"); const first = indices[0]!; const second = indices[1]!; [events[first], events[second]] = [events[second]!, events[first]!]; syncAcceptanceCommit(a); }, /event sequence is invalid/],
    ["extra acceptance event", (a) => { acceptanceCommit(a).events.push({ type: "audience_changed", actorId: "ceo", action: "add", reason: null }); syncAcceptanceCommit(a); }, /event sequence is invalid/],
    ["reverse multi-event sequence", (a) => { const events = acceptanceCommit(a).events; const before = JSON.stringify(events); events.reverse(); assert.notEqual(JSON.stringify(events), before); syncAcceptanceCommit(a); }, /event sequence is invalid/],
  ];
  for (const [label, mutate, expected] of cases) {
    const archive = structuredClone(source);
    mutate(archive);
    await assertArchiveRejects(t, archive, expected, label);
  }
});

test("self-contained generated claim values stay shape-only until signed", async (t) => {
  const archive = await acceptedArchive(t);
  const receipt = acceptance(archive).canonicalInput.payload as Mutable;
  receipt.runtimeProfile = { id: "alternate-profile", version: "v2" };
  receipt.generatedArtifact.provenance.runtimeProfile = { id: "alternate-profile", version: "v2" };
  receipt.promptPolicy = { id: "alternate-policy", version: "v2" };
  receipt.outputSchema = { id: "alternate-schema", digest: "alternate-digest" };
  receipt.skillDigests = ["alternate-skill"];
  receipt.contextHash = "a".repeat(64);
  receipt.promptHash = "b".repeat(64);
  refresh(acceptance(archive));
  validateSimulationArchive(archive);
});

test("edited and verbatim acceptance attribution is exact", async (t) => {
  const edited = await acceptedArchive(t);
  const verbatim = await acceptedArchive(t, null);
  assert.equal(acceptance(verbatim).canonicalInput.payload.accepted.textSource, "generated_verbatim");
  const cases: Array<[string, SimulationArchive, (archive: SimulationArchive) => void, RegExp]> = [
    ["edited blank", edited, (a) => { (acceptance(a).canonicalInput.payload as Mutable).accepted.text = " "; refresh(acceptance(a)); }, /input structure mismatch/],
    ["edited oversized", edited, (a) => { (acceptance(a).canonicalInput.payload as Mutable).accepted.text = "x".repeat(1_000_001); refresh(acceptance(a)); }, /input structure mismatch/],
    ["edited equal", edited, (a) => { const receipt = acceptance(a).canonicalInput.payload as Mutable; receipt.accepted.text = receipt.generatedArtifact.text; refresh(acceptance(a)); }, /edit must differ/],
    ["verbatim attribution", verbatim, (a) => { ((acceptanceCommit(a).events[0] as Mutable).message as Mutable).provenance.finalTextSource = "acceptor_edited"; syncAcceptanceCommit(a); }, /event sequence is invalid/],
  ];
  for (const [label, source, mutate, expected] of cases) {
    const archive = structuredClone(source);
    mutate(archive);
    await assertArchiveRejects(t, archive, expected, label);
  }
});

async function manualHistoryArchive(t: test.TestContext): Promise<SimulationArchive> {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-accept-manual-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openBranchStore(path.join(root, "runtime.sqlite")).open();
  try {
    const started = await startBranchSimulation(store, {
      ownerScope: "owner", simulationId: "manual", commandId: "start",
      workspacePath: workspace, scenarioId: "executive-interviews", branchId: "main",
    });
    const turn = commitManualTurn(store, {
      ownerScope: "owner", simulationId: "manual", branchId: "main",
      expectedHead: started.root.id, commandId: "turn",
      payload: { actorId: "ceo", text: "Manual original.", audience: ["cfo"] },
    });
    editAcceptedMessage(store, {
      ownerScope: "owner", simulationId: "manual", sourceBranchId: "main",
      sourceCommitId: turn.commit.id, branchId: "edit", expectedHead: turn.commit.id,
      commandId: "edit", payload: { actorId: "ceo", text: "Manual edit.", audience: ["cfo"] },
    });
    regenerateAcceptedResponse(store, {
      ownerScope: "owner", simulationId: "manual", sourceBranchId: "main",
      sourceCommitId: turn.commit.id, branchId: "regenerate", expectedHead: turn.commit.id,
      commandId: "regenerate", payload: { actorId: "ceo", text: "Manual regenerate.", audience: ["cfo"] },
    });
    return store.exportSimulation("owner", "manual");
  } finally {
    store.close();
  }
}

test("legacy gates isolate generated drafts from valid manual v6 histories", async (t) => {
  const generated = await acceptedArchive(t);
  const manual = await manualHistoryArchive(t);
  validateSimulationArchive(manual);
  assert.deepEqual(manual.commandResults.map((item) => item.canonicalInput.kind), ["start", "turn", "edit", "regenerate"]);
  for (const schemaVersion of [4, 5] as const) {
    const otherwiseManual = structuredClone(generated);
    otherwiseManual.schemaVersion = schemaVersion;
    const message = acceptanceCommit(otherwiseManual).events[0];
    assert.ok(message && message.type === "message_accepted", "acceptance message must exist");
    message.message.provenance = { mode: "manual", operation: "turn" };
    syncAcceptanceCommit(otherwiseManual);
    assert.throws(() => validateSimulationArchive(otherwiseManual), /Legacy simulation archives cannot contain draft acceptance artifacts/);

    const generatedProvenance = structuredClone(manual);
    generatedProvenance.schemaVersion = schemaVersion;
    const command = generatedProvenance.commandResults.find((item) => item.commandId === "turn");
    const commit = generatedProvenance.commits.find((item) => item.commandId === "turn");
    assert.ok(command?.result.kind === "commit" && commit, "manual turn must exist");
    const event = commit.events[0];
    assert.ok(event && event.type === "message_accepted", "manual message must exist");
    event.message.provenance = { mode: "generated", operation: "turn", sourceArtifactDigest: "a".repeat(64), finalTextSource: "generated_verbatim" };
    if (command.result.kind === "commit") command.result.commit = structuredClone(commit);
    assert.throws(() => validateSimulationArchive(generatedProvenance), /Legacy simulation archives cannot contain draft acceptance artifacts/);
  }
});

test("manual turn, edit, and regenerate reject generated provenance forgeries", async (t) => {
  const source = await manualHistoryArchive(t);
  const cases = ["turn", "edit", "regenerate"] as const;
  for (const commandId of cases) {
    const archive = structuredClone(source);
    const commit = archive.commits.find((item) => item.commandId === commandId);
    const command = archive.commandResults.find((item) => item.commandId === commandId);
    assert.ok(commit && command?.result.kind === "commit", ` commit must exist`);
    const message = commit.events[0];
    assert.ok(message && message.type === "message_accepted", ` message must exist`);
    message.message.provenance = { mode: "generated", operation: "turn", sourceArtifactDigest: "a".repeat(64), finalTextSource: "generated_verbatim" };
    if (command.result.kind === "commit") command.result.commit = structuredClone(commit);
    await assertArchiveRejects(t, archive, /turn payload mismatch/, ` generated provenance`);
  }
});

test("accept_draft rejects manual provenance and non-turn commits", async (t) => {
  const source = await acceptedArchive(t);
  const manual = structuredClone(source);
  const message = acceptanceCommit(manual).events[0];
  assert.ok(message && message.type === "message_accepted", "acceptance message must exist");
  message.message.provenance = { mode: "manual", operation: "turn" };
  syncAcceptanceCommit(manual);
  await assertArchiveRejects(t, manual, /event sequence is invalid/, "manual acceptance provenance");

  const nonTurn = structuredClone(source);
  acceptanceCommit(nonTurn).kind = "effects";
  syncAcceptanceCommit(nonTurn);
  await assertArchiveRejects(t, nonTurn, /accepted draft basis mismatch/, "non-turn acceptance commit");
});
