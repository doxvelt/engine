import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discardActorTurnDraft,
  generateActorTurnDraft,
} from "../src/core/draft-lifecycle.ts";
import {
  BranchConflictError,
  CommandIdentityError,
  DomainValidationError,
} from "../src/core/ports.ts";
import {
  commitManualTurn,
  projectBranch,
  startBranchSimulation,
} from "../src/core/branch-kernel.ts";
import { domainId, stableStringify } from "../src/core/domain-rules.ts";
import type { AgentRuntimeEvent } from "../src/agent-runtime/contracts.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";
import {
  openBranchStore,
  type SqliteSimulationRepository,
} from "../src/store/branch-sqlite.ts";

const workspace = path.resolve("examples/executive-interviews");

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-drafts-"));
  const dbPath = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(dbPath).open();
  const started = await startBranchSimulation(store, {
    ownerScope: "owner",
    simulationId: "sim",
    commandId: "start",
    workspacePath: workspace,
    scenarioId: "executive-interviews",
    branchId: "main",
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, started, dbPath };
}

function generation(head: string, commandId = "generate") {
  return {
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: head,
    commandId,
    payload: {
      actorId: "ceo",
      audience: ["cfo"],
      stageWhisperIds: [domainId("whisper", "owner", "sim", "whisper")],
      runtimeProfile: { id: "character", version: "v1" },
      promptPolicy: { id: "default", version: "v1" },
      outputSchema: { id: "screenplay", digest: "schema-v1" },
      skillDigests: ["skill-a"],
    },
  };
}

function stageWhisper(
  store: SqliteSimulationRepository,
  head: string,
  commandId = "whisper",
  text = "Direction.",
) {
  return store.createStageWhisper({
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: head,
    commandId,
    targetActorId: "ceo",
    text,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("ready drafts freeze an actor-only context and leave canonical history and export unchanged", async (t) => {
  const { store, started } = await fixture(t);
  const whisper = store.createStageWhisper({
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "whisper",
    targetActorId: "ceo",
    text: "Keep the supplier confidential.",
  });
  const before = store.exportSimulation("owner", "sim");
  const runtime = new DeterministicFakeRuntime([
    {
      type: "completed",
      text: "We will proceed carefully.",
      usage: { inputTokens: 3, outputTokens: 4 },
    },
  ]);
  const result = await generateActorTurnDraft(
    store,
    runtime,
    generation(started.root.id),
  );

  assert.equal(result.replayed, false);
  assert.equal(result.draft.status, "ready");
  assert.equal(result.draft.basisHeadCommitId, started.root.id);
  assert.deepEqual(result.draft.audience, ["ceo", "cfo"]);
  assert.deepEqual(result.draft.stageWhispers, [
    { id: whisper.id, text: whisper.text },
  ]);
  assert.equal(result.draft.capabilityGrant.length, 0);
  assert.doesNotMatch(
    JSON.stringify(result.draft.context),
    /sourceRoot|runtime\.sqlite/,
  );
  assert.match(result.draft.prompt, /supplier confidential/);
  assert.equal(result.draft.artifact?.text, "We will proceed carefully.");
  assert.equal(
    result.draft.contextHash,
    sha256(stableStringify(result.draft.context)),
  );
  assert.equal(result.draft.promptHash, sha256(result.draft.prompt));
  assert.equal(
    result.draft.artifact?.digest,
    sha256("We will proceed carefully."),
  );
  assert.equal(runtime.calls, 1);
  assert.equal(
    store.getBranch("owner", "sim", "main")?.headCommitId,
    started.root.id,
  );
  assert.equal(
    projectBranch(store, {
      ownerScope: "owner",
      simulationId: "sim",
      branchId: "main",
    }).transcript.length,
    0,
  );
  assert.deepEqual(store.exportSimulation("owner", "sim"), before);
});

test("generation replays durably without reinvocation and rejects changed input", async (t) => {
  const { store, started, dbPath } = await fixture(t);
  stageWhisper(store, started.root.id);
  const firstRuntime = new DeterministicFakeRuntime([
    { type: "completed", text: "First." },
  ]);
  const command = generation(started.root.id);
  const first = await generateActorTurnDraft(store, firstRuntime, command);
  store.close();
  const reopened = await openBranchStore(dbPath).open();
  const secondRuntime = new DeterministicFakeRuntime([
    { type: "completed", text: "Should not run." },
  ]);
  const replay = await generateActorTurnDraft(reopened, secondRuntime, command);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.draft, first.draft);
  assert.equal(secondRuntime.calls, 0);
  assert.throws(
    () =>
      generateActorTurnDraft(reopened, secondRuntime, {
        ...command,
        payload: { ...command.payload, skillDigests: ["changed"] },
      }),
    CommandIdentityError,
  );
  reopened.close();
});

test("failed runtime streams persist sanitized failures without canonical leakage", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  const failed = await generateActorTurnDraft(
    store,
    new DeterministicFakeRuntime([
      { type: "failed", message: "token=super-secret" },
    ]),
    generation(started.root.id),
  );
  assert.equal(failed.draft.status, "failed");
  assert.equal(failed.draft.failure?.message, "Runtime generation failed.");
  assert.doesNotMatch(JSON.stringify(failed.draft), /super-secret/);
  const invalid = await generateActorTurnDraft(
    store,
    new DeterministicFakeRuntime([
      { type: "tool_requested", name: "shell" },
      { type: "completed", text: "Never accepted." },
    ]),
    generation(started.root.id, "invalid"),
  );
  assert.equal(invalid.draft.status, "failed");
  assert.equal(
    store.getBranch("owner", "sim", "main")?.headCommitId,
    started.root.id,
  );
});

test("stale completion is safe; discard is independent, idempotent, and terminal", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  const runtime = new DeterministicFakeRuntime(
    [{ type: "completed", text: "Stale is safe." }],
    () => {
      commitManualTurn(store, {
        ownerScope: "owner",
        simulationId: "sim",
        branchId: "main",
        expectedHead: started.root.id,
        commandId: "advance",
        payload: { actorId: "ceo", text: "Canonical move.", audience: [] },
      });
    },
  );
  const ready = await generateActorTurnDraft(
    store,
    runtime,
    generation(started.root.id),
  );
  assert.equal(ready.draft.status, "ready");
  assert.notEqual(
    store.getBranch("owner", "sim", "main")?.headCommitId,
    started.root.id,
  );
  const discarded = discardActorTurnDraft(store, {
    ownerScope: "owner",
    simulationId: "sim",
    draftId: ready.draft.id,
    commandId: "discard",
  });
  assert.equal(discarded.draft.status, "discarded");
  assert.equal(
    discardActorTurnDraft(store, {
      ownerScope: "owner",
      simulationId: "sim",
      draftId: ready.draft.id,
      commandId: "discard",
    }).replayed,
    true,
  );
  assert.throws(
    () =>
      discardActorTurnDraft(store, {
        ownerScope: "owner",
        simulationId: "sim",
        draftId: ready.draft.id,
        commandId: "discard-two",
      }),
    DomainValidationError,
  );
});

test("generation validates ownership, head, actor, audience, and exact whisper selection", async (t) => {
  const { store, started } = await fixture(t);
  const runtime = new DeterministicFakeRuntime([
    { type: "completed", text: "No call." },
  ]);
  assert.throws(
    () => generateActorTurnDraft(store, runtime, generation("wrong")),
    BranchConflictError,
  );
  assert.throws(
    () =>
      generateActorTurnDraft(store, runtime, {
        ...generation(started.root.id),
        ownerScope: "wrong",
      }),
    /Simulation not found/,
  );
  assert.throws(
    () =>
      generateActorTurnDraft(store, runtime, {
        ...generation(started.root.id),
        payload: { ...generation(started.root.id).payload, actorId: "missing" },
      }),
    /Actor not found/,
  );
  assert.throws(
    () =>
      generateActorTurnDraft(store, runtime, {
        ...generation(started.root.id),
        payload: {
          ...generation(started.root.id).payload,
          audience: ["missing"],
        },
      }),
    /Actor not found/,
  );
  assert.throws(
    () => generateActorTurnDraft(store, runtime, generation(started.root.id)),
    /Stage whisper not found/,
  );
  assert.equal(runtime.calls, 0);
});

test("exact generation replay remains available after the branch advances", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  const command = generation(started.root.id);
  const first = await generateActorTurnDraft(
    store,
    new DeterministicFakeRuntime([{ type: "completed", text: "Draft." }]),
    command,
  );
  commitManualTurn(store, {
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "advance",
    payload: { actorId: "ceo", text: "Accepted move.", audience: [] },
  });
  const replayRuntime = new DeterministicFakeRuntime([
    { type: "completed", text: "Must not run." },
  ]);
  const replay = await generateActorTurnDraft(store, replayRuntime, command);
  assert.equal(replay.replayed, true);
  assert.equal(replay.draft.id, first.draft.id);
  assert.equal(replayRuntime.calls, 0);
});

test("discard wins a generating draft race", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowRuntime = {
    identity: { id: "slow-fake", version: "1" },
    async *runActorTurn() {
      await gate;
      yield { type: "completed" as const, text: "Late." };
    },
  };
  const running = generateActorTurnDraft(
    store,
    slowRuntime,
    generation(started.root.id),
  );
  const draftId = domainId("actor_turn_draft", "owner", "sim", "generate");
  assert.equal(
    store.getActorTurnDraft("owner", "sim", draftId)?.status,
    "generating",
  );
  const discarded = discardActorTurnDraft(store, {
    ownerScope: "owner",
    simulationId: "sim",
    draftId,
    commandId: "discard-running",
  });
  assert.equal(discarded.draft.status, "discarded");
  release?.();
  assert.equal((await running).draft.status, "discarded");
});

test("generation freezes requested whisper and skill order, and rejects duplicate frozen inputs", async (t) => {
  const { store, started } = await fixture(t);
  const first = store.createStageWhisper({
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "whisper-a",
    targetActorId: "ceo",
    text: "First direction.",
  });
  const second = store.createStageWhisper({
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "whisper-b",
    targetActorId: "ceo",
    text: "Second direction.",
  });
  const command = {
    ...generation(started.root.id),
    payload: {
      ...generation(started.root.id).payload,
      stageWhisperIds: [second.id, first.id],
      skillDigests: ["skill-b", "skill-a"],
    },
  };
  let skills: readonly string[] | undefined;
  let whisperIds: string[] | undefined;
  const result = await generateActorTurnDraft(
    store,
    new DeterministicFakeRuntime(
      [{ type: "completed", text: "Ordered." }],
      (request) => {
        skills = request.skillDigests;
        whisperIds = (
          request.context as {
            subjective: { stageWhispers: Array<{ id: string }> };
          }
        ).subjective.stageWhispers.map((whisper) => whisper.id);
      },
    ),
    command,
  );
  assert.deepEqual(
    result.draft.stageWhispers.map((whisper) => whisper.id),
    [second.id, first.id],
  );
  assert.deepEqual(result.draft.skillDigests, ["skill-b", "skill-a"]);
  assert.deepEqual(whisperIds, [second.id, first.id]);
  assert.deepEqual(skills, ["skill-b", "skill-a"]);
  assert.throws(
    () =>
      generateActorTurnDraft(store, new DeterministicFakeRuntime([]), {
        ...command,
        payload: { ...command.payload, stageWhisperIds: [first.id, second.id] },
      }),
    CommandIdentityError,
  );
  assert.throws(
    () =>
      generateActorTurnDraft(store, new DeterministicFakeRuntime([]), {
        ...generation(started.root.id, "duplicate-whisper"),
        payload: { ...command.payload, stageWhisperIds: [first.id, first.id] },
      }),
    DomainValidationError,
  );
  assert.throws(
    () =>
      generateActorTurnDraft(store, new DeterministicFakeRuntime([]), {
        ...generation(started.root.id, "duplicate-skill"),
        payload: { ...command.payload, skillDigests: ["skill-a", "skill-a"] },
      }),
    DomainValidationError,
  );
});
test("failed runtime streams persist bounded sanitized provenance", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  const result = await generateActorTurnDraft(
    store,
    new DeterministicFakeRuntime([
      {
        type: "failed",
        message: "token=super-secret",
        usage: { inputTokens: 3, outputTokens: 4 },
        stopReason: "error",
      },
    ]),
    generation(started.root.id),
  );
  assert.deepEqual(result.draft.failure?.provenance, {
    adapter: { id: "deterministic-fake", version: "1" },
    runtimeProfile: { id: "character", version: "v1" },
    providerId: null,
    modelId: null,
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    stopReason: "error",
    terminalStatus: "failed",
  });
  assert.doesNotMatch(JSON.stringify(result.draft), /super-secret/);
});
test("runtime exceptions retain only safe failure provenance and observed usage", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  const runtime = {
    identity: {
      id: "«redacted:sk-…»",
      version: `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`,
    },
    async *runActorTurn() {
      yield { type: "usage" as const, usage: { inputTokens: 3 } };
      throw new Error("provider token=super-secret");
    },
  };
  const result = await generateActorTurnDraft(
    store,
    runtime,
    generation(started.root.id),
  );
  assert.equal(result.draft.failure?.code, "runtime_failure");
  assert.deepEqual(result.draft.failure?.provenance?.usage, {
    inputTokens: 3,
    outputTokens: 0,
    totalTokens: 3,
  });
  assert.deepEqual(result.draft.failure?.provenance?.adapter, {
    id: "unknown",
    version: "unknown",
  });
  assert.doesNotMatch(
    JSON.stringify(result.draft),
    /super-secret|sk-proj|eyJhbGci/,
  );
});
test("runtime provenance accepts only trusted adapter refs and stop-reason enums", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  const secret = `sk_${"live_"}${"a".repeat(40)}`;
  const jwt = `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
  const runtimeIdentity = { id: secret, version: jwt };
  const ready = await generateActorTurnDraft(
    store,
    {
      identity: runtimeIdentity,
      async *runActorTurn() {
        yield {
          type: "completed" as const,
          text: "Safe.",
          stopReason: "stop" as const,
        };
      },
    },
    generation(started.root.id),
  );
  const failed = await generateActorTurnDraft(
    store,
    {
      identity: runtimeIdentity,
      async *runActorTurn() {
        yield {
          type: "failed" as const,
          message: secret,
          stopReason: "error" as const,
        };
      },
    },
    generation(started.root.id, "credential-failed"),
  );
  const invalidStop = {
    type: "completed" as const,
    text: "Unsafe metadata.",
    stopReason: secret,
  } as unknown as { type: "completed"; text: string; stopReason: "stop" };
  const invalid = await generateActorTurnDraft(
    store,
    new DeterministicFakeRuntime([invalidStop]),
    generation(started.root.id, "invalid-stop"),
  );
  assert.deepEqual(ready.draft.artifact?.provenance.adapter, {
    id: "unknown",
    version: "unknown",
  });
  assert.equal(ready.draft.artifact?.provenance.providerId, null);
  assert.equal(ready.draft.artifact?.provenance.modelId, null);
  assert.equal(ready.draft.artifact?.provenance.stopReason, "stop");
  assert.deepEqual(failed.draft.failure?.provenance?.adapter, {
    id: "unknown",
    version: "unknown",
  });
  assert.equal(failed.draft.failure?.provenance?.providerId, null);
  assert.equal(failed.draft.failure?.provenance?.modelId, null);
  assert.equal(failed.draft.failure?.provenance?.stopReason, "error");
  assert.equal(invalid.draft.failure?.code, "invalid_stream");
  assert.doesNotMatch(
    JSON.stringify({
      ready: ready.draft,
      failed: failed.draft,
      invalid: invalid.draft,
    }),
    /sk_live|eyJ[a-z]/,
  );
});

test("usage and adapter metadata are snapshotted once without stranding drafts", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  let reads = 0;
  const usage = Object.defineProperty({}, "inputTokens", {
    enumerable: true,
    get() {
      reads++;
      return reads === 1 ? 3 : "mutated";
    },
  });
  const identity = { id: "adapter-before", version: "1" };
  const ready = await generateActorTurnDraft(
    store,
    {
      identity,
      async *runActorTurn() {
        identity.id = "adapter-after";
        yield {
          type: "completed",
          text: "Snapshotted.",
          usage,
        } as unknown as AgentRuntimeEvent;
      },
    },
    generation(started.root.id),
  );
  assert.equal(reads, 1);
  assert.equal(ready.draft.status, "ready");
  assert.equal(ready.draft.artifact?.provenance.adapter.id, "adapter-before");
  assert.deepEqual(ready.draft.artifact?.provenance.usage, {
    inputTokens: 3,
    outputTokens: 0,
    totalTokens: 3,
  });

  const throwingUsage = Object.defineProperty({}, "inputTokens", {
    get() {
      throw new Error("malformed usage getter");
    },
  });
  const failed = await generateActorTurnDraft(
    store,
    {
      identity: { id: "throwing-usage", version: "1" },
      async *runActorTurn() {
        yield {
          type: "completed",
          text: "Never ready.",
          usage: throwingUsage,
        } as unknown as AgentRuntimeEvent;
      },
    },
    generation(started.root.id, "throwing-usage"),
  );
  assert.equal(failed.draft.status, "failed");
  assert.deepEqual(failed.draft.failure?.provenance.usage, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  const replayRuntime = new DeterministicFakeRuntime([
    { type: "completed", text: "Must not run." },
  ]);
  const replay = await generateActorTurnDraft(
    store,
    replayRuntime,
    generation(started.root.id, "throwing-usage"),
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.draft.status, "failed");
  assert.equal(replayRuntime.calls, 0);
});

test("non-success completion reasons produce failed drafts", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  for (const reason of ["aborted", "error", "tool_use"] as const) {
    const result = await generateActorTurnDraft(
      store,
      new DeterministicFakeRuntime([
        { type: "completed", text: "Incomplete.", stopReason: reason },
      ]),
      generation(started.root.id, `completion-${reason}`),
    );
    assert.equal(result.draft.status, "failed");
    assert.equal(result.draft.artifact, null);
    assert.equal(result.draft.failure?.provenance.stopReason, reason);
  }
});

test("identifier validation allows semantic names and rejects endpoints and absolute paths", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  const valid = generation(started.root.id);
  valid.payload.runtimeProfile.id = "provider/high-token-budget";
  valid.payload.promptPolicy.id = "@scope/secret-agent";
  const ready = await generateActorTurnDraft(
    store,
    new DeterministicFakeRuntime([{ type: "completed", text: "Valid IDs." }]),
    valid,
  );
  assert.equal(ready.draft.status, "ready");

  const namespacedCredential = `provider/sk-${"proj-"}${"a".repeat(40)}`;
  for (const [index, id] of [
    "https://host/profile",
    "C:/Users/me/profile",
    "/absolute/profile",
    "profiles/../../outside",
    namespacedCredential,
  ].entries()) {
    assert.throws(
      () =>
        generateActorTurnDraft(store, new DeterministicFakeRuntime([]), {
          ...generation(started.root.id, `invalid-identifier-${index}`),
          payload: {
            ...generation(started.root.id, `invalid-identifier-${index}`)
              .payload,
            runtimeProfile: { id, version: "v1" },
          },
        }),
      DomainValidationError,
    );
  }
});

const invalidStreamCases: Array<{
  name: string;
  events: readonly AgentRuntimeEvent[];
}> = [
  {
    name: "duplicate completed terminal events are invalid streams",
    events: [
      { type: "completed", text: "Once." },
      { type: "completed", text: "Twice." },
    ],
  },
  {
    name: "events after a completed terminal event are invalid streams",
    events: [
      { type: "completed", text: "Done." },
      { type: "text_delta", text: "After." },
    ],
  },
  {
    name: "events after a failed terminal event are invalid streams",
    events: [
      { type: "failed", message: "expected runtime failure" },
      { type: "text_delta", text: "After." },
    ],
  },
  {
    name: "negative usage cannot be overwritten by a later update",
    events: [
      { type: "usage", usage: { inputTokens: -1 } },
      { type: "usage", usage: { inputTokens: 3 } },
      { type: "completed", text: "Never.", usage: { outputTokens: 2 } },
    ],
  },
  {
    name: "fractional usage is an invalid stream",
    events: [
      { type: "completed", text: "Never.", usage: { inputTokens: 1.5 } },
    ],
  },
  {
    name: "contradictory completed usage is an invalid stream",
    events: [
      {
        type: "completed",
        text: "Never.",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 6 },
      },
    ],
  },
  {
    name: "contradictory failed usage is an invalid stream",
    events: [
      {
        type: "failed",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 6 },
      },
    ],
  },
  {
    name: "non-string completion text is an invalid stream",
    events: [{ type: "completed", text: 42 } as unknown as AgentRuntimeEvent],
  },
  {
    name: "contradictory usage cannot be repaired by a later update",
    events: [
      {
        type: "usage",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 6 },
      },
      { type: "usage", usage: { totalTokens: 5 } },
      { type: "completed", text: "Never ready." },
    ],
  },
  {
    name: "usage sums must remain safely serializable",
    events: [
      {
        type: "completed",
        text: "Never ready.",
        usage: {
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: Number.MAX_SAFE_INTEGER,
        },
      },
    ],
  },
];

for (const testCase of invalidStreamCases) {
  test(testCase.name, async (t) => {
    const { store, started } = await fixture(t);
    stageWhisper(store, started.root.id);
    const result = await generateActorTurnDraft(
      store,
      new DeterministicFakeRuntime(testCase.events),
      generation(started.root.id),
    );
    assert.equal(result.draft.failure?.code, "invalid_stream");
    assert.equal(result.draft.artifact, null);
  });
}

test("partial usage accumulates into an exact derived total", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  const result = await generateActorTurnDraft(
    store,
    new DeterministicFakeRuntime([
      { type: "usage", usage: { inputTokens: 2 } },
      { type: "usage", usage: { outputTokens: 3 } },
      { type: "completed", text: "Ready." },
    ]),
    generation(started.root.id),
  );
  assert.equal(result.draft.status, "ready");
  assert.deepEqual(result.draft.artifact?.provenance.usage, {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
  });
});

test("credential-shaped runtime profile references are rejected before persistence", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  const runtime = new DeterministicFakeRuntime([
    { type: "completed", text: "Must not run." },
  ]);
  const credentialShaped = `sk-${"proj-"}${"a".repeat(40)}`;
  assert.throws(
    () =>
      generateActorTurnDraft(store, runtime, {
        ...generation(started.root.id),
        payload: {
          ...generation(started.root.id).payload,
          runtimeProfile: { id: credentialShaped, version: "v1" },
        },
      }),
    DomainValidationError,
  );
  assert.equal(runtime.calls, 0);
  assert.equal(
    store.getActorTurnDraft(
      "owner",
      "sim",
      domainId("actor_turn_draft", "owner", "sim", "generate"),
    ),
    null,
  );
});

test("runtime receives a detached deeply frozen request snapshot", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  let inspected = false;
  const runtime = {
    identity: { id: "frozen-probe", version: "1" },
    async *runActorTurn(
      request: Parameters<DeterministicFakeRuntime["runActorTurn"]>[0],
    ) {
      inspected = true;
      assert.equal(Object.isFrozen(request), true);
      assert.equal(Object.isFrozen(request.audience), true);
      assert.equal(Object.isFrozen(request.runtimeProfile), true);
      assert.equal(Object.isFrozen(request.context as object), true);
      assert.throws(() => {
        (request.runtimeProfile as { id: string }).id = "mutated";
      }, TypeError);
      assert.throws(() => {
        (request.context as { simulation: { id: string } }).simulation.id =
          "mutated";
      }, TypeError);
      yield { type: "completed" as const, text: "Frozen." };
    },
  };
  const result = await generateActorTurnDraft(
    store,
    runtime,
    generation(started.root.id),
  );
  assert.equal(inspected, true);
  assert.equal(result.draft.status, "ready");
  assert.equal(result.draft.runtimeProfile.id, "character");
  assert.equal(
    result.draft.artifact?.provenance.runtimeProfile.id,
    "character",
  );
});

test("runtime completion fields are snapshotted once before iterator resumption", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  const mutable = { type: "completed" as const, text: "Bounded." };
  const mutated = await generateActorTurnDraft(
    store,
    {
      identity: { id: "mutation-probe", version: "1" },
      async *runActorTurn() {
        yield mutable;
        mutable.text = "x".repeat(1_000_001);
      },
    },
    generation(started.root.id),
  );
  assert.equal(mutated.draft.artifact?.text, "Bounded.");
  assert.equal(mutated.draft.artifact?.digest, sha256("Bounded."));

  let reads = 0;
  const accessorEvent = {
    type: "completed" as const,
    get text() {
      reads++;
      return reads === 1 ? "Accessor." : "mutated-after-validation";
    },
  };
  const accessor = await generateActorTurnDraft(
    store,
    {
      identity: { id: "accessor-probe", version: "1" },
      async *runActorTurn() {
        yield accessorEvent as unknown as AgentRuntimeEvent;
      },
    },
    generation(started.root.id, "accessor-completion"),
  );
  assert.equal(accessor.draft.artifact?.text, "Accessor.");
  assert.equal(accessor.draft.artifact?.digest, sha256("Accessor."));
  assert.equal(reads, 1);
});

test("generation forwards cancellation and bounds oversized output", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const aborted = await generateActorTurnDraft(
    store,
    {
      identity: { id: "abort-probe", version: "1" },
      async *runActorTurn(_request, signal) {
        receivedSignal = signal;
        controller.abort();
        yield { type: "completed" as const, text: "Too late." };
      },
    },
    generation(started.root.id),
    { signal: controller.signal },
  );
  assert.equal(receivedSignal, controller.signal);
  assert.equal(aborted.draft.failure?.code, "runtime_failure");
  assert.equal(aborted.draft.failure?.provenance.stopReason, "aborted");

  const oversized = await generateActorTurnDraft(
    store,
    new DeterministicFakeRuntime([
      { type: "completed", text: "x".repeat(1_000_001) },
    ]),
    generation(started.root.id, "oversized"),
  );
  assert.equal(oversized.draft.failure?.code, "invalid_stream");
  assert.equal(oversized.draft.artifact, null);
});

test("cancellation settles even when the adapter ignores its signal", async (t) => {
  const { store, started } = await fixture(t);
  stageWhisper(store, started.root.id);
  const controller = new AbortController();
  let markStarted: (() => void) | undefined;
  const adapterStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const running = generateActorTurnDraft(
    store,
    {
      identity: { id: "uncooperative-adapter", version: "1" },
      async *runActorTurn() {
        markStarted?.();
        await new Promise<void>(() => {});
        yield { type: "completed" as const, text: "Never yielded." };
      },
    },
    generation(started.root.id),
    { signal: controller.signal },
  );
  await adapterStarted;
  controller.abort();
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("cancellation did not settle")),
      500,
    );
  });
  const result = await Promise.race([running, timedOut]);
  if (timeout) clearTimeout(timeout);
  assert.equal(result.draft.status, "failed");
  assert.equal(result.draft.failure?.provenance.stopReason, "aborted");
  assert.equal(
    store.getActorTurnDraft("owner", "sim", result.draft.id)?.status,
    "failed",
  );
  const replayRuntime = new DeterministicFakeRuntime([
    { type: "completed", text: "Must not run." },
  ]);
  const replay = await generateActorTurnDraft(
    store,
    replayRuntime,
    generation(started.root.id),
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.draft.status, "failed");
  assert.equal(replayRuntime.calls, 0);
});

test("canonical and operational commands share one simulation identity", async (t) => {
  const { store, started } = await fixture(t);
  const shared = stageWhisper(store, started.root.id, "shared-command");
  const runtime = new DeterministicFakeRuntime([
    { type: "completed", text: "Must not run." },
  ]);
  assert.throws(
    () =>
      generateActorTurnDraft(store, runtime, {
        ...generation(started.root.id, "shared-command"),
        payload: {
          ...generation(started.root.id, "shared-command").payload,
          stageWhisperIds: [shared.id],
        },
      }),
    CommandIdentityError,
  );
  assert.equal(runtime.calls, 0);

  const draftWhisper = stageWhisper(store, started.root.id);
  await generateActorTurnDraft(
    store,
    new DeterministicFakeRuntime([{ type: "completed", text: "Draft." }]),
    {
      ...generation(started.root.id),
      payload: {
        ...generation(started.root.id).payload,
        stageWhisperIds: [draftWhisper.id],
      },
    },
  );
  assert.throws(
    () =>
      commitManualTurn(store, {
        ownerScope: "owner",
        simulationId: "sim",
        branchId: "main",
        expectedHead: started.root.id,
        commandId: "generate",
        payload: { actorId: "ceo", text: "Collision.", audience: [] },
      }),
    CommandIdentityError,
  );
  assert.equal(
    store.getBranch("owner", "sim", "main")?.headCommitId,
    started.root.id,
  );
});

test("two SQLite connections replay and discard one generating draft", async (t) => {
  const { store, started, dbPath } = await fixture(t);
  stageWhisper(store, started.root.id);
  const second = await openBranchStore(dbPath).open();
  let release: (() => void) | undefined;
  try {
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = generateActorTurnDraft(
      store,
      {
        identity: { id: "slow-two-connection", version: "1" },
        async *runActorTurn() {
          await gate;
          yield { type: "completed" as const, text: "Late." };
        },
      },
      generation(started.root.id),
    );
    const replayRuntime = new DeterministicFakeRuntime([
      { type: "completed", text: "Must not run." },
    ]);
    const replay = await generateActorTurnDraft(
      second,
      replayRuntime,
      generation(started.root.id),
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.draft.status, "generating");
    assert.equal(replayRuntime.calls, 0);
    const discarded = discardActorTurnDraft(second, {
      ownerScope: "owner",
      simulationId: "sim",
      draftId: replay.draft.id,
      commandId: "discard-second-connection",
    });
    assert.equal(discarded.draft.status, "discarded");
    release?.();
    assert.equal((await running).draft.status, "discarded");
  } finally {
    release?.();
    second.close();
  }
});
