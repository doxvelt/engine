import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createLocalApiServer } from "../src/local-api/server.ts";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

const run = promisify(execFile);
const workspace = path.resolve("examples/executive-interviews");

async function cli(args: string[]) {
  const result = await run(
    process.execPath,
    [path.resolve("src/cli/index.ts"), ...args, "--json"],
    { cwd: process.cwd() },
  );
  return JSON.parse(result.stdout) as any;
}
async function temp(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-interface-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, db: path.join(root, "runtime.sqlite") };
}

test("CLI preserves the branch-aware manual play, audience, access, whisper, closure, and inspection loop", async (t) => {
  const { db } = await temp(t);
  const started = await cli([
    "start",
    workspace,
    "--scenario",
    "executive-interviews",
    "--branch",
    "main",
    "--command",
    "cli-start",
    "--db",
    db,
  ]);
  let head = started.head as string;
  const audience = await cli([
    "audience",
    "add",
    "cfo",
    "--branch",
    "main",
    "--expected-head",
    head,
    "--command",
    "cli-audience",
    "--db",
    db,
  ]);
  head = audience.commit.id;
  assert.deepEqual(audience.activeAudience, ["cfo"]);
  const access = await cli([
    "access",
    "revoke",
    "cfo",
    "ceo",
    "--branch",
    "main",
    "--expected-head",
    head,
    "--command",
    "cli-access",
    "--db",
    db,
  ]);
  head = access.commit.id;
  assert.equal(
    access.effectiveAccessLinks.some(
      (item: any) => item.member === "cfo" && item.container === "ceo",
    ),
    false,
  );
  await cli([
    "whisper",
    "ceo",
    "--text",
    "Answer without naming the supplier.",
    "--branch",
    "main",
    "--expected-head",
    head,
    "--command",
    "cli-whisper",
    "--db",
    db,
  ]);
  const context = await cli([
    "context",
    "ceo",
    "--branch",
    "main",
    "--head",
    head,
    "--db",
    db,
  ]);
  assert.match(context.promptPreview, /without naming the supplier/);
  const turn = await cli([
    "turn",
    "ceo",
    "--manual",
    "The board needs a clearer operating picture.",
    "--audience",
    "ceo,cfo",
    "--branch",
    "main",
    "--expected-head",
    head,
    "--command",
    "cli-turn",
    "--db",
    db,
  ]);
  head = turn.commit.id;
  assert.equal(turn.consumedStageWhispers.length, 1);
  assert.deepEqual(
    (await cli(["transcript", "--branch", "main", "--db", db])).transcript.map(
      (item: any) => item.text,
    ),
    ["The board needs a clearer operating picture."],
  );
  const closure = await cli([
    "close-episode",
    "--label",
    "CLI beat",
    "--branch",
    "main",
    "--expected-head",
    head,
    "--command",
    "cli-close",
    "--db",
    db,
  ]);
  assert.equal(closure.episode.label, "CLI beat");
  assert.ok(closure.memories.length >= 1);
  assert.ok(
    (await cli(["memories", "--branch", "main", "--db", db])).memories.length >=
      1,
  );
  assert.ok(
    (await cli(["beliefs", "ceo", "--branch", "main", "--db", db]))
      .currentBeliefs.length > 0,
  );
});

test("CLI edit, regenerate, fork, and logical import/export preserve sibling paths", async (t) => {
  const { root, db } = await temp(t);
  const started = await cli([
    "start",
    workspace,
    "--scenario",
    "executive-interviews",
    "--branch",
    "main",
    "--command",
    "paths-start",
    "--db",
    db,
  ]);
  const turn = await cli([
    "turn",
    "ceo",
    "--manual",
    "Original response",
    "--audience",
    "ceo",
    "--branch",
    "main",
    "--expected-head",
    started.head,
    "--command",
    "paths-turn",
    "--db",
    db,
  ]);
  await cli([
    "edit",
    "ceo",
    "--manual",
    "Edited response",
    "--source-commit",
    turn.commit.id,
    "--new-branch",
    "edited",
    "--branch",
    "main",
    "--expected-head",
    turn.commit.id,
    "--command",
    "paths-edit",
    "--db",
    db,
  ]);
  await cli([
    "regenerate",
    "ceo",
    "--manual",
    "Regenerated response",
    "--source-commit",
    turn.commit.id,
    "--new-branch",
    "regenerated",
    "--branch",
    "main",
    "--expected-head",
    turn.commit.id,
    "--command",
    "paths-regen",
    "--db",
    db,
  ]);
  await cli([
    "fork",
    "--branch",
    "main",
    "--expected-head",
    turn.commit.id,
    "--at",
    started.head,
    "--new-branch",
    "empty-fork",
    "--command",
    "paths-fork",
    "--db",
    db,
  ]);
  assert.deepEqual(
    (await cli(["transcript", "--branch", "main", "--db", db])).transcript.map(
      (item: any) => item.text,
    ),
    ["Original response"],
  );
  assert.deepEqual(
    (
      await cli(["transcript", "--branch", "edited", "--db", db])
    ).transcript.map((item: any) => item.text),
    ["Edited response"],
  );
  assert.deepEqual(
    (
      await cli(["transcript", "--branch", "regenerated", "--db", db])
    ).transcript.map((item: any) => item.text),
    ["Regenerated response"],
  );
  assert.equal(
    (await cli(["transcript", "--branch", "empty-fork", "--db", db])).transcript
      .length,
    0,
  );
  const packageDir = path.join(root, "package");
  const importedDb = path.join(root, "imported.sqlite");
  const importedSource = path.join(root, "imported-source");
  const exported = await cli(["export", packageDir, "--db", db]);
  assert.equal(exported.manifest.schemaVersion, 4);
  await cli([
    "import",
    packageDir,
    "--world",
    importedSource,
    "--db",
    importedDb,
  ]);
  assert.deepEqual(
    (
      await cli(["transcript", "--branch", "edited", "--db", importedDb])
    ).transcript.map((item: any) => item.text),
    ["Edited response"],
  );
});

test("local API preserves source, play, closure, export, and pure branch projection behavior", async (t) => {
  const { root, db } = await temp(t);
  const server = createLocalApiServer({ dbPath: db });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const base = `http://127.0.0.1:${address.port}`;
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = (await response.json()) as any;
    assert.equal(response.ok, true, JSON.stringify(value));
    return value;
  };
  const preflight = await fetch(`${base}/simulations/api/actors`, {
    method: "OPTIONS",
    headers: { origin: "http://localhost:3000" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "http://localhost:3000",
  );
  const compiled = await post("/source/compile", { workspacePath: workspace });
  assert.equal(compiled.entities.length, 7);
  const files = (await (
    await fetch(`${base}/source?workspacePath=${encodeURIComponent(workspace)}`)
  ).json()) as any;
  assert.ok(
    files.files.some((item: any) => item.path === "entities/ceo/IDENTITY.md"),
  );
  const source = (await (
    await fetch(
      `${base}/source/file?workspacePath=${encodeURIComponent(workspace)}&path=${encodeURIComponent("worlds/strategy-class.md")}`,
    )
  ).json()) as any;
  assert.match(source.text, /strategy class/i);
  const started = await post("/simulations/start", {
    workspacePath: workspace,
    simulationId: "api",
    scenarioId: "executive-interviews",
    branchId: "main",
    commandId: "api-start",
  });
  const audience = await post("/simulations/api/audience", {
    branchId: "main",
    expectedHead: started.root.id,
    commandId: "api-audience",
    actorId: "cfo",
    action: "add",
  });
  const access = await post("/simulations/api/access", {
    branchId: "main",
    expectedHead: audience.commit.id,
    commandId: "api-access",
    action: "revoke",
    member: "cfo",
    container: "ceo",
  });
  const whisper = await post("/simulations/api/whispers", {
    branchId: "main",
    expectedHead: access.commit.id,
    commandId: "api-whisper",
    targetActorId: "ceo",
    text: "Private API direction.",
  });
  assert.equal(whisper.targetActorId, "ceo");
  const turn = await post("/simulations/api/turns", {
    branchId: "main",
    expectedHead: access.commit.id,
    commandId: "api-turn",
    actorId: "ceo",
    manualText: "API branch turn",
    stageWhisperIds: [whisper.id],
  });
  assert.ok(
    turn.commit.events.some(
      (item: any) => item.type === "stage_whisper_consumed",
    ),
  );
  const cfo = (await (
    await fetch(`${base}/simulations/api/context/cfo?branchId=main`)
  ).json()) as any;
  const coo = (await (
    await fetch(`${base}/simulations/api/context/coo?branchId=main`)
  ).json()) as any;
  assert.match(cfo.promptPreview, /API branch turn/);
  assert.doesNotMatch(coo.promptPreview, /API branch turn/);
  const historical = (await (
    await fetch(
      `${base}/simulations/api/transcript?branchId=main&head=${started.root.id}`,
    )
  ).json()) as any;
  assert.equal(historical.transcript.length, 0);
  const stale = await fetch(`${base}/simulations/api/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      branchId: "main",
      expectedHead: started.root.id,
      commandId: "api-stale",
      stageWhisperIds: [],
      actorId: "ceo",
      manualText: "stale",
      audience: [],
    }),
  });
  assert.equal(stale.status, 409);
  const transcript = (await (
    await fetch(`${base}/simulations/api/transcript?branchId=main`)
  ).json()) as any;
  assert.deepEqual(
    transcript.transcript.map((item: any) => item.text),
    ["API branch turn"],
  );
  const closure = await post("/simulations/api/episodes/close", {
    branchId: "main",
    expectedHead: turn.commit.id,
    commandId: "api-close",
    label: "API beat",
  });
  assert.equal(closure.episode.label, "API beat");
  assert.ok(closure.memories.length > 0);
  const memories = (await (
    await fetch(`${base}/simulations/api/memories?branchId=main`)
  ).json()) as any;
  assert.ok(memories.memories.length > 0);
  const exported = await post("/packages/export", {
    simulationId: "api",
    targetDir: path.join(root, "api-package"),
  });
  assert.equal(exported.manifest.schemaVersion, 4);
  assert.ok(turn.commit.id);
});

test("CLI rejects access cycles without moving the branch head", async (t) => {
  const { db } = await temp(t);
  const started = await cli([
    "start",
    workspace,
    "--scenario",
    "executive-interviews",
    "--branch",
    "main",
    "--command",
    "cycle-start",
    "--db",
    db,
  ]);
  await assert.rejects(
    () =>
      cli([
        "access",
        "grant",
        "ceo",
        "cfo",
        "--branch",
        "main",
        "--expected-head",
        started.head,
        "--command",
        "cycle-command",
        "--db",
        db,
      ]),
    /cycle/i,
  );
  const store = await openBranchStore(db).open();
  try {
    assert.equal(
      store.getBranch("local", "default", "main")?.headCommitId,
      started.head,
    );
  } finally {
    store.close();
  }
});
