import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";
import {
  acceptActorTurnDraft,
  discardActorTurnDraft,
  generateActorTurnDraft,
} from "../src/core/draft-lifecycle.ts";
import { receiptFor } from "../src/core/draft-acceptance.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { fingerprintCommand, recordCommand } from "../src/core/domain-rules.ts";
import {
  commitManualTurn,
  startBranchSimulation,
} from "../src/core/branch-kernel.ts";
import {
  BranchConflictError,
  CommandIdentityError,
  DomainValidationError,
} from "../src/core/ports.ts";
import {
  openBranchStore,
  type SqliteSimulationRepository,
} from "../src/store/branch-sqlite.ts";
import type { SimulationArchive } from "../src/core/ports.ts";
import { DeterministicFakeRuntime } from "./helpers/deterministic-fake-runtime.ts";

const workspace = path.resolve("examples/executive-interviews");

async function readyDraft(t: test.TestContext, text = "  Generated text.  ") {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-accept-"));
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
  const whisper = store.createStageWhisper({
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "whisper",
    targetActorId: "ceo",
    text: "Private direction.",
  });
  const runtime = new DeterministicFakeRuntime([
    { type: "completed", text, usage: { inputTokens: 2, outputTokens: 3 } },
  ]);
  const generated = await generateActorTurnDraft(store, runtime, {
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "generate",
    payload: {
      actorId: "ceo",
      audience: ["cfo"],
      stageWhisperIds: [whisper.id],
      runtimeProfile: { id: "character", version: "v1" },
      promptPolicy: { id: "default", version: "v1" },
      outputSchema: { id: "screenplay", digest: "schema-v1" },
      skillDigests: ["skill-a"],
    },
  });
  let closed = false;
  const close = () => {
    if (!closed) {
      store.close();
      closed = true;
    }
  };
  t.after(async () => {
    close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    dbPath,
    store,
    close,
    started,
    draft: generated.draft,
    whisper,
    runtime,
  };
}

function assertNoAcceptanceLeak(
  store: SqliteSimulationRepository,
  draftId: string,
  rootId: string,
  commandId: string,
) {
  const archive = store.exportSimulation("owner", "sim");
  assert.equal(store.getBranch("owner", "sim", "main")?.headCommitId, rootId);
  assert.equal(
    store.getActorTurnDraft("owner", "sim", draftId)?.status,
    "ready",
  );
  assert.equal(
    archive.commits.some((commit) => commit.commandId === commandId),
    false,
  );
  assert.equal(
    archive.commandResults.some((entry) => entry.commandId === commandId),
    false,
  );
}

function mutateStoredDraft(
  dbPath: string,
  draftId: string,
  mutate: (draft: Record<string, any>) => void,
): () => void {
  const database = new DatabaseSync(dbPath);
  const row = database
    .prepare("SELECT draft_json FROM actor_turn_drafts WHERE id = ?")
    .get(draftId) as { draft_json: string };
  const original = row.draft_json;
  const draft = JSON.parse(original) as Record<string, any>;
  mutate(draft);
  database
    .prepare("UPDATE actor_turn_drafts SET draft_json = ? WHERE id = ?")
    .run(JSON.stringify(draft), draftId);
  return () => {
    database
      .prepare("UPDATE actor_turn_drafts SET draft_json = ? WHERE id = ?")
      .run(original, draftId);
    database.close();
  };
}

async function assertImportRejects(archive: SimulationArchive) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-accept-import-"));
  const imported = await openBranchStore(
    path.join(root, "runtime.sqlite"),
  ).open();
  try {
    assert.throws(() => imported.importSimulation(archive));
  } finally {
    imported.close();
    await rm(root, { recursive: true, force: true });
  }
}

type WorkerResult =
  | { ok: true; replayed: boolean }
  | { ok: false; name: string };
function runWorker(work: {
  dbPath: string;
  action: "accept" | "discard";
  commandId: string;
  draftId: string;
}): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./helpers/draft-acceptance-worker.ts", import.meta.url),
      { workerData: work },
    );
    let result: WorkerResult | undefined;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      void worker.terminate();
      finish(() => reject(new Error("draft acceptance worker timed out")));
    }, 5_000);
    worker.once("message", (value: WorkerResult) => {
      result = value;
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) =>
      finish(() => {
        if (code !== 0)
          reject(new Error(`draft acceptance worker exited ${code}`));
        else if (!result)
          reject(new Error("draft acceptance worker produced no result"));
        else resolve(result);
      }),
    );
  });
}

test("accepts generated-verbatim text explicitly or by omission without reinvoking runtime", async (t) => {
  const { store, started, draft, whisper, runtime } = await readyDraft(t);
  const request = {
    ownerScope: "owner",
    simulationId: "sim",
    draftId: draft.id,
    commandId: "accept",
    finalText: draft.artifact!.text,
  };
  const accepted = acceptActorTurnDraft(store, request);
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.commit.parentCommitId, started.root.id);
  assert.deepEqual(
    accepted.commit.events.map((event) => event.type),
    [
      "message_accepted",
      "first_impression_formed",
      "first_impression_formed",
      "stage_whisper_consumed",
    ],
  );
  const event = accepted.commit.events[0]!;
  if (event.type !== "message_accepted") throw new Error("missing message");
  assert.equal(event.message.text, "  Generated text.  ");
  assert.deepEqual(event.message.provenance, {
    mode: "generated",
    operation: "turn",
    sourceArtifactDigest: draft.artifact?.digest,
    finalTextSource: "generated_verbatim",
  });
  const { finalText: _ignored, ...omitted } = request;
  assert.equal(acceptActorTurnDraft(store, omitted).replayed, true);
  const generationReplay = await generateActorTurnDraft(store, runtime, {
    ownerScope: draft.ownerScope,
    simulationId: draft.simulationId,
    branchId: draft.branchId,
    expectedHead: draft.basisHeadCommitId,
    commandId: draft.generationCommandId,
    payload: {
      actorId: draft.actorId,
      audience: draft.audience,
      stageWhisperIds: draft.stageWhispers.map((item) => item.id),
      runtimeProfile: draft.runtimeProfile,
      promptPolicy: draft.promptPolicy,
      outputSchema: draft.outputSchema,
      skillDigests: draft.skillDigests,
    },
  });
  assert.equal(generationReplay.replayed, true);
  assert.equal(generationReplay.draft.status, "accepted");
  assert.equal(runtime.calls, 1);
  const archive = store.exportSimulation("owner", "sim");
  const command = archive.commandResults.find(
    (item) => item.commandId === "accept",
  );
  assert.equal(command?.canonicalInput.kind, "accept_draft");
  if (command?.canonicalInput.kind !== "accept_draft")
    throw new Error("missing receipt");
  assert.deepEqual(command.canonicalInput.payload.stageWhispers, [
    { id: whisper.id, text: whisper.text },
  ]);
  assert.equal(
    command.canonicalInput.payload.generatedArtifact.text,
    "  Generated text.  ",
  );
  assert.deepEqual(command.canonicalInput.payload.accepted, {
    textSource: "generated_verbatim",
  });
  assert.equal(
    store.getActorTurnDraft("owner", "sim", draft.id)?.status,
    "accepted",
  );
});

test("edited acceptance replays exactly and omitted text rejects locally, after restart, and after import", async (t) => {
  const { store, close, dbPath, draft } = await readyDraft(t);
  const request = {
    ownerScope: "owner",
    simulationId: "sim",
    draftId: draft.id,
    commandId: "accept-edit",
    finalText: "  Edited text.  ",
  };
  const accepted = acceptActorTurnDraft(store, request);
  const message = (
    accepted.commit.events[0]! as {
      message: { text: string; provenance: unknown };
    }
  ).message;
  assert.equal(message.text, request.finalText);
  assert.deepEqual(message.provenance, {
    mode: "generated",
    operation: "turn",
    sourceArtifactDigest: draft.artifact?.digest,
    finalTextSource: "acceptor_edited",
  });
  const { finalText: _ignored, ...omitted } = request;
  assert.throws(
    () => acceptActorTurnDraft(store, omitted),
    CommandIdentityError,
  );
  const archive = store.exportSimulation("owner", "sim");
  close();
  const reopened = await openBranchStore(dbPath).open();
  try {
    assert.equal(acceptActorTurnDraft(reopened, request).replayed, true);
    assert.throws(
      () => acceptActorTurnDraft(reopened, omitted),
      CommandIdentityError,
    );
  } finally {
    reopened.close();
  }
  const importedRoot = await mkdtemp(
    path.join(os.tmpdir(), "doxvelt-accept-replay-"),
  );
  const imported = await openBranchStore(
    path.join(importedRoot, "runtime.sqlite"),
  ).open();
  try {
    imported.importSimulation(archive);
    assert.equal(imported.getActorTurnDraft("owner", "sim", draft.id), null);
    const replay = acceptActorTurnDraft(imported, request);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.commit, accepted.commit);
    assert.throws(
      () => acceptActorTurnDraft(imported, omitted),
      CommandIdentityError,
    );
  } finally {
    imported.close();
    await rm(importedRoot, { recursive: true, force: true });
  }
});

test("acceptance rejects empty and oversized final text without changing draft state", async (t) => {
  const { store, draft, started } = await readyDraft(t);
  for (const item of [
    { commandId: "empty", finalText: " \n\t " },
    { commandId: "large", finalText: "x".repeat(1_000_001) },
  ]) {
    assert.throws(
      () =>
        acceptActorTurnDraft(store, {
          ownerScope: "owner",
          simulationId: "sim",
          draftId: draft.id,
          ...item,
        }),
      DomainValidationError,
    );
    assertNoAcceptanceLeak(store, draft.id, started.root.id, item.commandId);
  }
});

test("accepted command replays exactly while new acceptance and discard commands cannot retarget its terminal draft", async (t) => {
  const { store, draft, started } = await readyDraft(t);
  const request = {
    ownerScope: "owner",
    simulationId: "sim",
    draftId: draft.id,
    commandId: "accept-bound",
    finalText: "Edited once.",
  };
  const first = acceptActorTurnDraft(store, request);
  assert.equal(acceptActorTurnDraft(store, request).replayed, true);
  assert.throws(
    () =>
      acceptActorTurnDraft(store, { ...request, commandId: "accept-again" }),
    DomainValidationError,
  );
  assert.throws(
    () =>
      discardActorTurnDraft(store, { ...request, commandId: "discard-again" }),
    DomainValidationError,
  );
  assert.equal(started.root.id, first.commit.parentCommitId);
  const archive = store.exportSimulation("owner", "sim");
  assert.equal(
    archive.commandResults.some((entry) => entry.commandId === "accept-again"),
    false,
  );
  assert.equal(
    archive.commandResults.some((entry) => entry.commandId === "discard-again"),
    false,
  );
});

test("successful acceptance consumes only its captured whisper snapshot", async (t) => {
  const { store, draft, started, whisper } = await readyDraft(t);
  const later = store.createStageWhisper({
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "later-whisper",
    targetActorId: "ceo",
    text: "Later direction.",
  });
  const accepted = acceptActorTurnDraft(store, {
    ownerScope: "owner",
    simulationId: "sim",
    draftId: draft.id,
    commandId: "accept-captured",
  });
  assert.deepEqual(
    accepted.commit.events.map((event) => event.type),
    [
      "message_accepted",
      "first_impression_formed",
      "first_impression_formed",
      "stage_whisper_consumed",
    ],
  );
  assert.deepEqual(
    accepted.commit.events.filter(
      (event) => event.type === "stage_whisper_consumed",
    ),
    [
      {
        type: "stage_whisper_consumed",
        whisperId: whisper.id,
        targetActorId: "ceo",
        text: whisper.text,
      },
    ],
  );
  assert.equal(
    JSON.stringify(accepted.commit.events).includes(later.id),
    false,
  );
});

test("a stale ready draft and later same-head whispers do not leak or consume unintended state", async (t) => {
  const { store, draft, started, whisper } = await readyDraft(t);
  const later = store.createStageWhisper({
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "later-whisper",
    targetActorId: "ceo",
    text: "Later direction.",
  });
  commitManualTurn(store, {
    ownerScope: "owner",
    simulationId: "sim",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "advance",
    payload: { actorId: "cfo", text: "Advance.", audience: [] },
  });
  assert.throws(
    () =>
      acceptActorTurnDraft(store, {
        ownerScope: "owner",
        simulationId: "sim",
        draftId: draft.id,
        commandId: "stale",
      }),
    BranchConflictError,
  );
  assert.equal(
    store.getActorTurnDraft("owner", "sim", draft.id)?.status,
    "ready",
  );
  assert.equal(
    store
      .exportSimulation("owner", "sim")
      .commandResults.some((entry) => entry.commandId === "stale"),
    false,
  );
  assert.deepEqual(
    store
      .listPendingStageWhispers("owner", "sim", "main", started.root.id, "ceo")
      .map((item) => item.id),
    [whisper.id, later.id],
  );
});

test("tampered stored ready drafts reject atomically across the validation matrix", async (t) => {
  const { store, dbPath, draft, started } = await readyDraft(t);
  const variants: Array<[string, (value: Record<string, any>) => void]> = [
    [
      "extra field",
      (d) => {
        d.extra = true;
      },
    ],
    [
      "missing field",
      (d) => {
        delete d.promptHash;
      },
    ],
    [
      "unsafe runtime profile",
      (d) => {
        d.runtimeProfile.id = "https://host/profile";
      },
    ],
    [
      "empty runtime profile",
      (d) => {
        d.runtimeProfile.id = "";
      },
    ],
    [
      "unsafe prompt policy",
      (d) => {
        d.promptPolicy.id = "/private";
      },
    ],
    [
      "empty prompt policy",
      (d) => {
        d.promptPolicy.version = "";
      },
    ],
    [
      "unsafe output schema",
      (d) => {
        d.outputSchema.digest = "sk_live_secret";
      },
    ],
    [
      "empty output schema",
      (d) => {
        d.outputSchema.id = "";
      },
    ],
    [
      "unsafe skill",
      (d) => {
        d.skillDigests = ["https://host/skill"];
      },
    ],
    [
      "empty skill",
      (d) => {
        d.skillDigests = [""];
      },
    ],
    [
      "unsafe adapter",
      (d) => {
        d.artifact.provenance.adapter.id = "/adapter";
      },
    ],
    [
      "empty adapter",
      (d) => {
        d.artifact.provenance.adapter.version = "";
      },
    ],
    [
      "bad context hash",
      (d) => {
        d.contextHash = "0".repeat(64);
      },
    ],
    [
      "bad prompt hash",
      (d) => {
        d.promptHash = "0".repeat(64);
      },
    ],
    [
      "bad artifact hash",
      (d) => {
        d.artifact.digest = "0".repeat(64);
      },
    ],
    [
      "blank artifact",
      (d) => {
        d.artifact.text = " \t";
      },
    ],
    [
      "oversized artifact",
      (d) => {
        d.artifact.text = "x".repeat(1_000_001);
      },
    ],
    [
      "ready without artifact",
      (d) => {
        d.artifact = null;
      },
    ],
    [
      "failed ready state",
      (d) => {
        d.status = "failed";
      },
    ],
    [
      "negative usage",
      (d) => {
        d.artifact.provenance.usage.inputTokens = -1;
      },
    ],
    [
      "fractional usage",
      (d) => {
        d.artifact.provenance.usage.outputTokens = 1.5;
      },
    ],
    [
      "inexact usage",
      (d) => {
        d.artifact.provenance.usage.totalTokens = 99;
      },
    ],
    [
      "bogus stop reason",
      (d) => {
        d.artifact.provenance.stopReason = "bogus";
      },
    ],
    [
      "duplicate audience",
      (d) => {
        d.audience.push(d.audience[0]);
      },
    ],
    [
      "duplicate skills",
      (d) => {
        d.skillDigests.push(d.skillDigests[0]);
      },
    ],
    [
      "duplicate whispers",
      (d) => {
        d.stageWhispers.push(structuredClone(d.stageWhispers[0]));
      },
    ],
  ];
  for (const [name, mutate] of variants) {
    const commandId = `tampered-${name.replaceAll(" ", "-")}`;
    const restore = mutateStoredDraft(dbPath, draft.id, mutate);
    try {
      assert.throws(
        () =>
          acceptActorTurnDraft(store, {
            ownerScope: "owner",
            simulationId: "sim",
            draftId: draft.id,
            commandId,
          }),
        DomainValidationError,
        name,
      );
    } finally {
      restore();
    }
    assertNoAcceptanceLeak(store, draft.id, started.root.id, commandId);
  }
});

test("recorded acceptance receipts reject malformed structural archive data on validation and import", async (t) => {
  const { store, draft } = await readyDraft(t);
  acceptActorTurnDraft(store, {
    ownerScope: "owner",
    simulationId: "sim",
    draftId: draft.id,
    commandId: "accept-archive",
  });
  const original = store.exportSimulation("owner", "sim");
  const variants: Array<[string, (receipt: Record<string, any>) => void]> = [
    [
      "unsafe ref",
      (r) => {
        r.runtimeProfile.id = "https://host/profile";
      },
    ],
    [
      "bad hash",
      (r) => {
        r.contextHash = "not-a-hash";
      },
    ],
    [
      "blank text",
      (r) => {
        r.generatedArtifact.text = " ";
      },
    ],
    [
      "negative usage",
      (r) => {
        r.generatedArtifact.provenance.usage.inputTokens = -1;
      },
    ],
    [
      "fractional usage",
      (r) => {
        r.generatedArtifact.provenance.usage.outputTokens = 1.5;
      },
    ],
    [
      "inexact usage",
      (r) => {
        r.generatedArtifact.provenance.usage.totalTokens = 999;
      },
    ],
    [
      "bogus stop",
      (r) => {
        r.generatedArtifact.provenance.stopReason = "bogus";
      },
    ],
    [
      "wrong terminal state",
      (r) => {
        r.generatedArtifact.provenance.terminalStatus = "failed";
      },
    ],
    [
      "duplicate audience",
      (r) => {
        r.audience.push(r.audience[0]);
      },
    ],
    [
      "duplicate skills",
      (r) => {
        r.skillDigests.push(r.skillDigests[0]);
      },
    ],
    [
      "duplicate whispers",
      (r) => {
        r.stageWhispers.push(structuredClone(r.stageWhispers[0]));
      },
    ],
    [
      "extra receipt field",
      (r) => {
        r.extra = true;
      },
    ],
  ];
  for (const [name, mutate] of variants) {
    const archive = structuredClone(original);
    const command = archive.commandResults.find(
      (entry) => entry.commandId === "accept-archive",
    )!;
    if (command.canonicalInput.kind !== "accept_draft")
      throw new Error("missing acceptance receipt");
    mutate(command.canonicalInput.payload as unknown as Record<string, any>);
    command.fingerprint = fingerprintCommand(command.canonicalInput);
    assert.throws(() => validateSimulationArchive(archive), Error, name);
    await assertImportRejects(archive);
  }
});

test("repository acceptance port rejects forged envelopes and receipts instead of accepting a caller supplied commit", async (t) => {
  const { store, draft, started } = await readyDraft(t);
  const request = {
    ownerScope: "owner",
    simulationId: "sim",
    draftId: draft.id,
    commandId: "port-forged",
  };
  const valid = () =>
    recordCommand("accept_draft", {
      ownerScope: request.ownerScope,
      simulationId: request.simulationId,
      branchId: draft.branchId,
      expectedHead: draft.basisHeadCommitId,
      commandId: request.commandId,
      payload: receiptFor(draft, draft.artifact!.text),
    });
  const variants: Array<
    [
      string,
      (
        command: Record<string, any>,
        input: { fingerprint: string; createdAt: string },
      ) => void,
    ]
  > = [
    [
      "owner",
      (c) => {
        c.ownerScope = "forged";
      },
    ],
    [
      "simulation",
      (c) => {
        c.simulationId = "forged";
      },
    ],
    [
      "branch",
      (c) => {
        c.branchId = "forged";
      },
    ],
    [
      "head",
      (c) => {
        c.expectedHead = "forged";
      },
    ],
    [
      "command",
      (c) => {
        c.commandId = "forged";
      },
    ],
    [
      "actor",
      (c) => {
        c.payload.actorId = "cfo";
      },
    ],
    [
      "audience",
      (c) => {
        c.payload.audience = ["ceo"];
      },
    ],
    [
      "text",
      (c) => {
        c.payload.generatedArtifact.text = "forged";
      },
    ],
    [
      "provenance",
      (c) => {
        c.payload.generatedArtifact.provenance.adapter.id = "forged";
      },
    ],
    [
      "artifact",
      (c) => {
        c.payload.generatedArtifact.digest = "0".repeat(64);
      },
    ],
    [
      "wrong fingerprint",
      (_c, i) => {
        i.fingerprint = "forged";
      },
    ],
    [
      "invalid createdAt",
      (_c, i) => {
        i.createdAt = "not-a-date";
      },
    ],
    [
      "non-ISO createdAt",
      (_c, i) => {
        i.createdAt = "1";
      },
    ],
  ];
  for (const [name, mutate] of variants) {
    const command = valid() as unknown as Record<string, any>;
    const input = {
      fingerprint: fingerprintCommand(command),
      createdAt: new Date().toISOString(),
    };
    mutate(command, input);
    assert.throws(
      () =>
        store.acceptActorTurnDraft({
          request,
          commandInput: command,
          commandFingerprint: input.fingerprint,
          createdAt: input.createdAt,
        } as never),
      DomainValidationError,
      name,
    );
    assertNoAcceptanceLeak(store, draft.id, started.root.id, request.commandId);
  }
});

test("restart replay binds command kind, draft ID, and every omitted, equal, or edited final-text collision", async (t) => {
  const { store, close, dbPath, draft } = await readyDraft(t);
  const request = {
    ownerScope: "owner",
    simulationId: "sim",
    draftId: draft.id,
    commandId: "restart-accept",
  };
  const accepted = acceptActorTurnDraft(store, request);
  close();
  const reopened = await openBranchStore(dbPath).open();
  try {
    assert.equal(acceptActorTurnDraft(reopened, request).replayed, true);
    assert.equal(
      acceptActorTurnDraft(reopened, {
        ...request,
        finalText: draft.artifact!.text,
      }).replayed,
      true,
    );
    assert.throws(
      () =>
        acceptActorTurnDraft(reopened, {
          ...request,
          finalText: "Edited collision.",
        }),
      CommandIdentityError,
    );
    assert.throws(
      () =>
        acceptActorTurnDraft(reopened, { ...request, draftId: "other-draft" }),
      CommandIdentityError,
    );
    assert.throws(
      () => discardActorTurnDraft(reopened, request),
      CommandIdentityError,
    );
    assert.equal(
      accepted.commit.id,
      reopened.getBranch("owner", "sim", "main")?.headCommitId,
    );
  } finally {
    reopened.close();
  }
});

test("two real SQLite connections resolve accept races with one terminal winner", async (t) => {
  const same = await readyDraft(t);
  same.close();
  const sameResults = await Promise.all([
    runWorker({
      dbPath: same.dbPath,
      action: "accept",
      commandId: "same-accept",
      draftId: same.draft.id,
    }),
    runWorker({
      dbPath: same.dbPath,
      action: "accept",
      commandId: "same-accept",
      draftId: same.draft.id,
    }),
  ]);
  assert.deepEqual(
    sameResults.map((result) => result.ok && result.replayed).sort(),
    [false, true],
  );
  const different = await readyDraft(t);
  different.close();
  const differentResults = await Promise.all([
    runWorker({
      dbPath: different.dbPath,
      action: "accept",
      commandId: "left-accept",
      draftId: different.draft.id,
    }),
    runWorker({
      dbPath: different.dbPath,
      action: "accept",
      commandId: "right-accept",
      draftId: different.draft.id,
    }),
  ]);
  assert.equal(differentResults.filter((result) => result.ok).length, 1);
  assert.equal(differentResults.filter((result) => !result.ok).length, 1);
  const differentStore = await openBranchStore(different.dbPath).open();
  try {
    assert.equal(
      differentStore
        .exportSimulation("owner", "sim")
        .commandResults.filter((item) =>
          ["left-accept", "right-accept"].includes(item.commandId),
        ).length,
      1,
    );
  } finally {
    differentStore.close();
  }
  const terminal = await readyDraft(t);
  terminal.close();
  const terminalResults = await Promise.all([
    runWorker({
      dbPath: terminal.dbPath,
      action: "accept",
      commandId: "race-accept",
      draftId: terminal.draft.id,
    }),
    runWorker({
      dbPath: terminal.dbPath,
      action: "discard",
      commandId: "race-discard",
      draftId: terminal.draft.id,
    }),
  ]);
  assert.equal(terminalResults.filter((result) => result.ok).length, 1);
  const terminalStore = await openBranchStore(terminal.dbPath).open();
  try {
    const archive = terminalStore.exportSimulation("owner", "sim");
    const accepted =
      terminalStore.getActorTurnDraft("owner", "sim", terminal.draft.id)
        ?.status === "accepted";
    assert.equal(
      archive.commandResults.some((item) => item.commandId === "race-accept"),
      accepted,
    );
    const database = new DatabaseSync(terminal.dbPath);
    try {
      assert.equal(
        database
          .prepare(
            "SELECT command_id FROM actor_turn_draft_commands WHERE command_id = 'race-discard'",
          )
          .all().length,
        accepted ? 0 : 1,
      );
    } finally {
      database.close();
    }
  } finally {
    terminalStore.close();
  }
});

test("SQLite rollback is atomic across every acceptance write boundary", async (t) => {
  const targets = [
    ["commit", "BEFORE INSERT ON commits"],
    ["branch", "BEFORE UPDATE OF head_commit_id ON branches"],
    ["draft", "BEFORE UPDATE OF status ON actor_turn_drafts"],
    ["identity", "BEFORE INSERT ON accepted_actor_turn_draft_identities"],
    ["command", "BEFORE INSERT ON command_results"],
  ] as const;
  for (const [name, timing] of targets) {
    const fixture = await readyDraft(t);
    fixture.close();
    const trigger = `accept_fault_${name}`;
    const database = new DatabaseSync(fixture.dbPath);
    const condition =
      name === "commit" || name === "command"
        ? ` WHEN NEW.command_id = 'fault-${name}'`
        : "";
    database.exec(
      `CREATE TRIGGER ${trigger} ${timing}${condition} BEGIN SELECT RAISE(ABORT, 'forced ${name} fault'); END`,
    );
    database.close();
    const store = await openBranchStore(fixture.dbPath).open();
    try {
      assert.throws(() =>
        acceptActorTurnDraft(store, {
          ownerScope: "owner",
          simulationId: "sim",
          draftId: fixture.draft.id,
          commandId: `fault-${name}`,
        }),
      );
      assertNoAcceptanceLeak(
        store,
        fixture.draft.id,
        fixture.started.root.id,
        `fault-${name}`,
      );
    } finally {
      store.close();
    }
    const cleanup = new DatabaseSync(fixture.dbPath);
    cleanup.exec(`DROP TRIGGER ${trigger}`);
    cleanup.close();
    const restored = await openBranchStore(fixture.dbPath).open();
    try {
      assert.equal(
        acceptActorTurnDraft(restored, {
          ownerScope: "owner",
          simulationId: "sim",
          draftId: fixture.draft.id,
          commandId: `fault-${name}`,
        }).replayed,
        false,
      );
    } finally {
      restored.close();
    }
  }
});

test("ready draft identity, completed stop reasons, and timestamps reject tampering", async (t) => {
  const { store, dbPath, draft, started } = await readyDraft(t);
  const variants: Array<[string, (value: Record<string, any>) => void]> = [
    ["generation command", (value) => { value.generationCommandId = "forged"; }],
    ["draft id", (value) => { value.id = "actor_turn_draft_forged"; }],
    ...(["error", "aborted", "tool_use"] as const).map((stopReason) => [
      "stop " + stopReason,
      (value: Record<string, any>) => { value.artifact.provenance.stopReason = stopReason; },
    ] as [string, (value: Record<string, any>) => void]),
    ["numeric timestamp", (value) => { value.createdAt = "1"; }],
    ["noncanonical timestamp", (value) => { value.updatedAt = "2026-01-01T00:00:00Z"; }],
  ];
  for (const [label, mutate] of variants) {
    const restore = mutateStoredDraft(dbPath, draft.id, mutate);
    assert.throws(
      () => acceptActorTurnDraft(store, {
        ownerScope: "owner", simulationId: "sim", draftId: draft.id, commandId: "tamper-" + label,
      }),
      DomainValidationError,
    );
    restore();
    assertNoAcceptanceLeak(store, draft.id, started.root.id, "tamper-" + label);
  }
});

test("acceptance replay rejects forged result caches while commits stay canonical", async (t) => {
  const { store, dbPath, draft } = await readyDraft(t);
  const request = { ownerScope: "owner", simulationId: "sim", draftId: draft.id, commandId: "accept-cache" };
  const accepted = acceptActorTurnDraft(store, request);
  const canonical = store.getCommit("owner", "sim", accepted.commit.id);
  const database = new DatabaseSync(dbPath);
  const row = database.prepare("SELECT result_json FROM command_results WHERE command_id = ?").get(request.commandId) as { result_json: string };
  const forged = JSON.parse(row.result_json);
  forged.commit.events[0].message.text = "Forged cache text.";
  database.prepare("UPDATE command_results SET result_json = ? WHERE command_id = ?").run(JSON.stringify(forged), request.commandId);
  database.close();
  assert.deepEqual(store.getCommit("owner", "sim", accepted.commit.id), canonical);
  assert.throws(() => acceptActorTurnDraft(store, request), /command result is invalid|result cache does not match authoritative history/);
});
