import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  commitManualTurn,
  commitRuntimeEffects,
  fingerprintCommand,
  forkBranch,
  projectBranch,
  stageWhisper,
  startBranchSimulation,
} from "../src/core/branch-kernel.ts";
import { closeBranchEpisode } from "../src/core/branch-episode.ts";
import { validateSimulationArchive } from "../src/core/archive-verifier.ts";
import { BranchConflictError } from "../src/core/ports.ts";
import { initWorkspace } from "../src/core/init.ts";
import { createLocalApiServer } from "../src/local-api/server.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";
import {
  exportSimulationPackage,
  importSimulationPackage,
} from "../src/store/portable.ts";

const run = promisify(execFile);
const exampleWorkspace = path.resolve("examples/executive-interviews");

async function fixture(t: test.TestContext, simulationId = "default") {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-final-review-"));
  const dbPath = path.join(root, "runtime.sqlite");
  const store = await openBranchStore(dbPath).open();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const started = await startBranchSimulation(store, {
    ownerScope: "local",
    simulationId,
    workspacePath: exampleWorkspace,
    scenarioId: "executive-interviews",
    branchId: "main",
    commandId: `${simulationId}-start`,
  });
  return { root, dbPath, store, started };
}

async function startModelServer(t: test.TestContext): Promise<{
  url: string;
  requestCount: () => number;
}> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "draft-response",
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Generated draft text" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing model server address.");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requests,
  };
}

async function createModelWorkspace(
  root: string,
  baseUrl: string,
): Promise<string> {
  const workspace = path.join(root, "workspace");
  await initWorkspace(workspace);
  await writeFile(
    path.join(workspace, "models", "draft-model.md"),
    `---\nid: draft-model\nprovider: openai-compatible\nbase_url: ${baseUrl}\nmodel: test-model\n---\n`,
  );
  const observer = path.join(workspace, "entities", "observer");
  await mkdir(observer, { recursive: true });
  await writeFile(
    path.join(observer, "IDENTITY.md"),
    "---\nid: observer\nkind: agent\nname: Observer\n---\nAn observer.\n",
  );
  await writeFile(
    path.join(observer, "SURFACE.md"),
    "Observer is visibly present.\n",
  );
  return workspace;
}

test("CLI draft generates non-canonical text and turn rejects direct AI acceptance", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-cli-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modelServer = await startModelServer(t);
  const workspace = await createModelWorkspace(root, modelServer.url);
  const dbPath = path.join(root, "runtime.sqlite");
  const cli = async (args: string[]) => {
    const result = await run(
      process.execPath,
      [path.resolve("src/cli/index.ts"), ...args, "--json"],
      { cwd: process.cwd() },
    );
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  const started = await cli([
    "start",
    workspace,
    "--branch",
    "main",
    "--command",
    "start",
    "--db",
    dbPath,
  ]);
  const head = started.head as string;
  const draft = await cli([
    "draft",
    "actor",
    "--model",
    "draft-model",
    "--branch",
    "main",
    "--expected-head",
    head,
    "--whisper",
    "Inline draft direction",
    "--db",
    dbPath,
  ]);
  assert.equal(draft.text, "Generated draft text");
  assert.deepEqual(draft.stageWhisperIds, []);
  assert.match(
    (draft.context as { promptPreview: string }).promptPreview,
    /Inline draft direction/,
  );

  const store = await openBranchStore(dbPath).open();
  try {
    assert.equal(
      store.getBranch("local", "default", "main")?.headCommitId,
      head,
    );
    assert.equal(
      projectBranch(store, {
        ownerScope: "local",
        simulationId: "default",
        branchId: "main",
      }).transcript.length,
      0,
    );
  } finally {
    store.close();
  }
  await assert.rejects(
    run(process.execPath, [
      path.resolve("src/cli/index.ts"),
      "turn",
      "actor",
      "--ai",
      "--model",
      "draft-model",
      "--branch",
      "main",
      "--expected-head",
      head,
      "--command",
      "ai-turn",
      "--db",
      dbPath,
    ]),
    /Model output must be generated with draft/,
  );

  const api = createLocalApiServer({ dbPath });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        api.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = api.address();
  if (!address || typeof address === "string")
    throw new Error("Missing API address.");
  const requestsBeforeInvalidAudience = modelServer.requestCount();
  const invalidAudienceResponse = await fetch(
    `http://127.0.0.1:${address.port}/simulations/default/turn-draft`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorId: "actor",
        modelId: "draft-model",
        branchId: "main",
        expectedHead: head,
        audience: ["missing-actor"],
      }),
    },
  );
  assert.equal(invalidAudienceResponse.status, 404);
  assert.equal(modelServer.requestCount(), requestsBeforeInvalidAudience);
  const response = await fetch(
    `http://127.0.0.1:${address.port}/simulations/default/turn-draft`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorId: "actor",
        modelId: "draft-model",
        branchId: "main",
        expectedHead: head,
        audience: ["observer"],
      }),
    },
  );
  assert.equal(response.status, 200);
  const apiDraft = (await response.json()) as {
    text: string;
    audience: string[];
    context: { subjective: { currentAudience: string[] }; promptPreview: string };
  };
  assert.equal(apiDraft.text, "Generated draft text");
  assert.deepEqual(apiDraft.audience, ["actor", "observer"]);
  assert.deepEqual(apiDraft.context.subjective.currentAudience, [
    "actor",
    "observer",
  ]);
  assert.match(apiDraft.context.promptPreview, /@observer/);
  const afterApiDraft = await openBranchStore(dbPath).open();
  try {
    assert.equal(
      afterApiDraft.getBranch("local", "default", "main")?.headCommitId,
      head,
    );
    assert.equal(
      projectBranch(afterApiDraft, {
        ownerScope: "local",
        simulationId: "default",
        branchId: "main",
      }).transcript.length,
      0,
    );
  } finally {
    afterApiDraft.close();
  }
  const acceptedInline = await cli([
    "turn",
    "actor",
    "--manual",
    "Accepted inline response",
    "--whisper",
    "Accepted inline direction",
    "--branch",
    "main",
    "--expected-head",
    head,
    "--command",
    "accept-inline",
    "--db",
    dbPath,
  ]);
  assert.ok(
    (
      acceptedInline.commit as {
        events: Array<{ type: string; text?: string }>;
      }
    ).events.some(
      (event) =>
        event.type === "stage_whisper_consumed" &&
        event.text === "Accepted inline direction",
    ),
  );
});

test("core mutations normalize nonexistent and stale heads without side effects", async (t) => {
  const { store, started } = await fixture(t, "conflicts");
  const first = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "conflicts",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "first",
    payload: { actorId: "ceo", text: "Accepted", audience: [] },
  });
  const before = store.exportSimulation("local", "conflicts");
  for (const [commandId, expectedHead] of [
    ["stale-valid", started.root.id],
    ["nonexistent", "commit-does-not-exist"],
  ] as const) {
    assert.throws(
      () =>
        commitManualTurn(store, {
          ownerScope: "local",
          simulationId: "conflicts",
          branchId: "main",
          expectedHead,
          commandId,
          payload: { actorId: "ceo", text: "Rejected", audience: [] },
        }),
      BranchConflictError,
    );
  }
  const after = store.exportSimulation("local", "conflicts");
  assert.equal(after.commits.length, before.commits.length);
  assert.equal(after.commandResults.length, before.commandResults.length);
  assert.equal(after.branches[0]?.headCommitId, first.commit.id);
});

test("API returns 409 for invalid heads and validates actors and empty input", async (t) => {
  const { dbPath, store, started } = await fixture(t, "api-validation");
  store.close();
  const server = createLocalApiServer({ dbPath });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing API address.");
  const base = `http://127.0.0.1:${address.port}`;
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  const mutation = {
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "first",
    actorId: "ceo",
    manualText: "Accepted",
    audience: [],
    stageWhisperIds: [],
  };
  const accepted = await post("/simulations/api-validation/turns", mutation);
  assert.equal(accepted.status, 200);
  const currentHead = (accepted.body.commit as Record<string, unknown>)
    .id as string;
  const forkStore = await openBranchStore(dbPath).open();
  try {
    forkBranch(forkStore, {
      ownerScope: "local",
      simulationId: "api-validation",
      sourceBranchId: "main",
      expectedHead: currentHead,
      atCommitId: started.root.id,
      branchId: "historical-fork",
      commandId: "historical-fork-command",
    });
  } finally {
    forkStore.close();
  }
  for (const [route, status] of [
    ["/simulations/api-validation/transcript?branchId=missing", 404],
    ["/simulations/api-validation/transcript?head=missing", 404],
    ["/simulations/api-validation/context/ceo?branchId=missing", 404],
    ["/simulations/api-validation/context/ceo?head=missing", 404],
    [
      `/simulations/api-validation/transcript?branchId=historical-fork&head=${currentHead}`,
      400,
    ],
    [
      `/simulations/api-validation/context/ceo?branchId=historical-fork&head=${currentHead}`,
      400,
    ],
  ] as const) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, status);
  }

  for (const [commandId, expectedHead] of [
    ["stale-api", started.root.id],
    ["missing-api", "commit-does-not-exist"],
  ] as const) {
    const result = await post("/simulations/api-validation/turns", {
      ...mutation,
      commandId,
      expectedHead,
      manualText: "Rejected",
    });
    assert.equal(result.status, 409);
  }
  const missingWhisper = await post("/simulations/api-validation/whispers", {
    branchId: "main",
    expectedHead: currentHead,
    commandId: "missing-whisper",
    targetActorId: "missing-actor",
    text: "Unusable",
  });
  assert.equal(missingWhisper.status, 404);
  const emptyWhisper = await post("/simulations/api-validation/whispers", {
    branchId: "main",
    expectedHead: currentHead,
    commandId: "empty-whisper",
    targetActorId: "ceo",
    text: "   ",
  });
  assert.equal(emptyWhisper.status, 400);
  const missingTurn = await post("/simulations/api-validation/turns", {
    branchId: "main",
    expectedHead: currentHead,
    commandId: "missing-turn",
    actorId: "missing-actor",
    manualText: "Unusable",
    audience: [],
    stageWhisperIds: [],
  });
  assert.equal(missingTurn.status, 404);
  const emptyTurn = await post("/simulations/api-validation/turns", {
    branchId: "main",
    expectedHead: currentHead,
    commandId: "empty-turn",
    actorId: "ceo",
    manualText: "   ",
    audience: [],
    stageWhisperIds: [],
  });
  assert.equal(emptyTurn.status, 400);
  const modelTurn = await post("/simulations/api-validation/turns", {
    branchId: "main",
    expectedHead: currentHead,
    commandId: "model-turn",
    actorId: "ceo",
    modelId: "anything",
    audience: [],
  });
  assert.equal(modelTurn.status, 400);

  const audit = await openBranchStore(dbPath).open();
  try {
    assert.equal(
      audit.getBranch("local", "api-validation", "main")?.headCommitId,
      currentHead,
    );
    assert.equal(
      audit.exportSimulation("local", "api-validation").stageWhispers.length,
      0,
    );
    assert.deepEqual(
      projectBranch(audit, {
        ownerScope: "local",
        simulationId: "api-validation",
        branchId: "main",
      }).transcript.map((turn) => turn.text),
      ["Accepted"],
    );
  } finally {
    audit.close();
  }
});

test("forged command-result caches make package import fail atomically", async (t) => {
  const { root, dbPath, store } = await fixture(t, "forged");
  store.close();
  const packageDir = path.join(root, "package");
  await exportSimulationPackage({
    dbPath,
    simulationId: "forged",
    targetDir: packageDir,
  });
  const runtimePath = path.join(packageDir, "simulation.json");
  const archive = JSON.parse(await readFile(runtimePath, "utf8")) as {
    commandResults: Array<{ result: unknown }>;
  };
  archive.commandResults[0]!.result = { forged: true };
  await writeFile(runtimePath, `${JSON.stringify(archive, null, 2)}\n`);
  const importedDb = path.join(root, "forged-import.sqlite");
  const importedSource = path.join(root, "imported-source");
  await assert.rejects(
    importSimulationPackage({
      packageDir,
      targetSourceDir: importedSource,
      targetDbPath: importedDb,
    }),
    /command result is invalid/,
  );
  await assert.rejects(readFile(importedSource, "utf8"), /ENOENT/);
  const imported = await openBranchStore(importedDb).open();
  try {
    assert.equal(imported.getSimulation("local", "forged"), null);
  } finally {
    imported.close();
  }
});

test("schema mismatch and late import failures leave no partial targets", async (t) => {
  const { root, dbPath, store } = await fixture(t, "atomic-preflight");
  store.close();
  const packageDir = path.join(root, "atomic-package");
  await exportSimulationPackage({
    dbPath,
    simulationId: "atomic-preflight",
    targetDir: packageDir,
  });
  const runtimePath = path.join(packageDir, "simulation.json");
  const original = JSON.parse(await readFile(runtimePath, "utf8")) as {
    schemaVersion: number;
  };
  const invalid = structuredClone(original);
  invalid.schemaVersion = 3;
  await writeFile(runtimePath, `${JSON.stringify(invalid, null, 2)}\n`);
  const schemaSource = path.join(root, "schema-source");
  const schemaDb = path.join(root, "schema.sqlite");
  await assert.rejects(importSimulationPackage({
    packageDir,
    targetSourceDir: schemaSource,
    targetDbPath: schemaDb,
  }), /schema/);
  await assert.rejects(readFile(schemaSource), /ENOENT/);
  await assert.rejects(readFile(schemaDb), /ENOENT/);

  await writeFile(runtimePath, `${JSON.stringify(original, null, 2)}\n`);
  const conflictSource = path.join(root, "conflict-source");
  const conflictDb = path.join(root, "conflict.sqlite");
  await mkdir(conflictSource);
  await writeFile(path.join(conflictSource, "marker"), "preserve");
  await assert.rejects(importSimulationPackage({
    packageDir,
    targetSourceDir: conflictSource,
    targetDbPath: conflictDb,
  }), /already exists/);
  assert.equal(await readFile(path.join(conflictSource, "marker"), "utf8"), "preserve");
  await assert.rejects(readFile(conflictDb), /ENOENT/);

  const blockedParent = path.join(root, "not-a-directory");
  await writeFile(blockedParent, "blocked");
  const failedSource = path.join(root, "failed-source");
  await assert.rejects(importSimulationPackage({
    packageDir,
    targetSourceDir: failedSource,
    targetDbPath: path.join(blockedParent, "runtime.sqlite"),
  }));
  await assert.rejects(readFile(failedSource), /ENOENT/);
});

test("archive fingerprints bind canonical input to authoritative history", async (t) => {
  const { root, dbPath, store, started } = await fixture(t, "bound-commands");
  const turn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "bound-commands",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "bound-turn",
    payload: {
      actorId: "ceo",
      text: "Authoritative text",
      audience: ["cfo"],
    },
  });
  const effects = commitRuntimeEffects(store, {
    ownerScope: "local",
    simulationId: "bound-commands",
    branchId: "main",
    expectedHead: turn.commit.id,
    commandId: "bound-effects",
    payload: {
      audienceChanges: [
        { actorId: "cfo", action: "add", reason: "Invited" },
      ],
    },
  });
  stageWhisper(store, {
    ownerScope: "local",
    simulationId: "bound-commands",
    branchId: "main",
    expectedHead: effects.commit.id,
    commandId: "bound-whisper",
    targetActorId: "ceo",
    text: "Authoritative direction",
  });
  const closure = await closeBranchEpisode(store, {
    ownerScope: "local",
    simulationId: "bound-commands",
    branchId: "main",
    expectedHead: effects.commit.id,
    commandId: "bound-closure",
    payload: { label: "Authoritative episode" },
  });
  forkBranch(store, {
    ownerScope: "local",
    simulationId: "bound-commands",
    sourceBranchId: "main",
    expectedHead: closure.commit.id,
    atCommitId: effects.commit.id,
    branchId: "bound-fork",
    commandId: "bound-fork-command",
    name: "Authoritative fork",
  });
  store.close();
  const packageDir = path.join(root, "bound-package");
  await exportSimulationPackage({
    dbPath,
    simulationId: "bound-commands",
    targetDir: packageDir,
  });
  const runtimePath = path.join(packageDir, "simulation.json");
  const original = JSON.parse(await readFile(runtimePath, "utf8")) as {
    commandResults: Array<{
      commandId: string;
      canonicalInput: unknown;
      fingerprint: string;
    }>;
  };
  const mutateCommand = (
    archive: typeof original,
    commandId: string,
    mutate: (input: Record<string, unknown>) => void,
  ) => {
    const command = archive.commandResults.find(
      (item) => item.commandId === commandId,
    )!;
    const input = command.canonicalInput as Record<string, unknown>;
    mutate(input);
    command.fingerprint = fingerprintCommand(input);
  };
  const variants = [
    (archive: typeof original) => {
      archive.commandResults[0]!.fingerprint = "0".repeat(64);
    },
    (archive: typeof original) => {
      const unrelated = {
        ownerScope: "local",
        simulationId: "bound-commands",
        commandId: "bound-commands-start",
        unrelated: true,
      };
      archive.commandResults[0]!.canonicalInput = unrelated;
      archive.commandResults[0]!.fingerprint = fingerprintCommand(unrelated);
    },
    (archive: typeof original) => {
      mutateCommand(archive, "bound-commands-start", (input) => {
        input.scenarioId = "self-consistent-forgery";
      });
    },
    (archive: typeof original) => {
      mutateCommand(archive, "bound-commands-start", (input) => {
        const compiled = structuredClone(input.compiled) as {
          worlds: Array<{ body: string }>;
        };
        compiled.worlds[0]!.body = "Tampered compiled world";
        input.compiled = compiled;
      });
    },
    (archive: typeof original) => {
      mutateCommand(archive, "bound-turn", (input) => {
        (input.payload as Record<string, unknown>).text = "Forged turn text";
      });
    },
    (archive: typeof original) => {
      mutateCommand(archive, "bound-effects", (input) => {
        const payload = input.payload as Record<string, unknown>;
        payload.audienceChanges = [
          { actorId: "cfo", action: "remove", reason: "Invited" },
        ];
      });
    },
    (archive: typeof original) => {
      mutateCommand(archive, "bound-closure", (input) => {
        (input.payload as Record<string, unknown>).label = "Forged episode";
      });
    },
    (archive: typeof original) => {
      mutateCommand(archive, "bound-fork-command", (input) => {
        input.name = "Forged fork";
      });
    },
    (archive: typeof original) => {
      mutateCommand(archive, "bound-whisper", (input) => {
        input.targetActorId = "cfo";
      });
    },
  ];
  for (const [index, mutate] of variants.entries()) {
    const archive = structuredClone(original);
    mutate(archive);
    await writeFile(runtimePath, `${JSON.stringify(archive, null, 2)}\n`);
    const source = path.join(root, `bound-source-${index}`);
    const db = path.join(root, `bound-${index}.sqlite`);
    await assert.rejects(
      importSimulationPackage({
        packageDir,
        targetSourceDir: source,
        targetDbPath: db,
      }),
      /fingerprint mismatch|input .*mismatch|turn payload mismatch|runtime effects mismatch/,
    );
    await assert.rejects(readFile(source, "utf8"), /ENOENT/);
    const audit = await openBranchStore(db).open();
    try {
      assert.equal(audit.getSimulation("local", "bound-commands"), null);
    } finally {
      audit.close();
    }
  }
});

test("archive import rejects malformed runtime event payloads before writes", async (t) => {
  const { root, store, started } = await fixture(t, "malformed-events");
  const turn = commitManualTurn(store, {
    ownerScope: "local",
    simulationId: "malformed-events",
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "event-turn",
    payload: {
      actorId: "ceo",
      text: "An eventful turn.",
      audience: ["ceo", "cfo"],
      accessChanges: [
        { action: "revoke", member: "cfo", container: "ceo" },
      ],
    },
  });
  await closeBranchEpisode(store, {
    ownerScope: "local",
    simulationId: "malformed-events",
    branchId: "main",
    expectedHead: turn.commit.id,
    commandId: "event-close",
    payload: {},
  });
  const original = store.exportSimulation("local", "malformed-events");
  const mutations = [
    (archive: typeof original) => {
      const event = archive.commits[1]!.events[0] as Record<string, unknown>;
      event.message = { text: 42 };
    },
    (archive: typeof original) => {
      const event = archive.commits[1]!.events.find(
        (item) => item.type === "access_changed",
      ) as unknown as Record<string, unknown>;
      event.action = "smuggled";
    },
    (archive: typeof original) => {
      const closure = archive.commits.at(-1)!.events[0] as unknown as {
        closure: { memories: Array<Record<string, unknown>> };
      };
      closure.closure.memories[0]!.sourceTurnIds = [7];
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const archive = structuredClone(original);
    mutate(archive);
    const db = path.join(root, `malformed-${index}.sqlite`);
    const target = await openBranchStore(db).open();
    try {
      assert.throws(() => validateSimulationArchive(archive));
      assert.equal(target.getSimulation("local", "malformed-events"), null);
    } finally {
      target.close();
    }
  }
});
