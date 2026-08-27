import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  DoxveltGenerationError,
  describeModelForDiagnostics,
  generateDoxveltText,
} from "../src/ai/generate.ts";
import { compileWorkspace } from "../src/core/compiler.ts";
import type { AssetRecord } from "../src/core/types.ts";
import { parseFrontmatter } from "../src/core/frontmatter.ts";
import { initWorkspace } from "../src/core/init.ts";

const execFileAsync = promisify(execFile);

test("initWorkspace creates a sparse compilable scaffold", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const workspacePath = path.join(root, "workspace");

  await initWorkspace(workspacePath);
  const compiled = await compileWorkspace(workspacePath);

  assert.equal(compiled.entities.length, 1);
  assert.equal(compiled.scenarios.at(0)?.id, "scenario");
  assert.ok(
    compiled.models.some((model) => model.id === "local-openai-compatible"),
  );
  assert.ok(compiled.beliefs.length >= 1);
  assert.ok(compiled.beliefs.at(0)?.sourceSpan.file);
});

test("initWorkspace can seed the executive interviews example", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const workspacePath = path.join(root, "workspace");

  await initWorkspace(workspacePath, { template: "executive-interviews" });
  const compiled = await compileWorkspace(workspacePath);

  assert.equal(compiled.entities.length, 7);
  assert.equal(compiled.scenarios.at(0)?.id, "executive-interviews");
  assert.ok(
    compiled.models.some((model) => model.id === "local-openai-compatible"),
  );
  assert.ok(compiled.beliefs.length >= 30);
  assert.ok(compiled.surfaces.length >= 8);
  assert.ok(compiled.beliefs.at(0)?.sourceSpan.file);
});

test("initWorkspace template lookup works outside the repository root", async (context) => {
  const previousCwd = process.cwd();
  const root = await createRepoLocalRunRoot(context);
  const workspacePath = path.join(root, "workspace");

  try {
    process.chdir(root);
    await initWorkspace(workspacePath, { template: "executive-interviews" });
  } finally {
    process.chdir(previousCwd);
  }

  const compiled = await compileWorkspace(workspacePath);
  assert.equal(compiled.entities.length, 7);
});

test("initWorkspace rejects unknown templates", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const workspacePath = path.join(root, "workspace");

  await assert.rejects(
    () => initWorkspace(workspacePath, { template: "missing-template" }),
    /Unknown Doxvelt init template/,
  );
});

test("compiled example source is inspectable without running init", async () => {
  const compiled = await compileWorkspace("examples/executive-interviews");

  assert.equal(compiled.entities.length, 7);
  assert.equal(compiled.scenarios.at(0)?.id, "executive-interviews");
});

test("compiler validates model record metadata shape", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const workspacePath = path.join(root, "workspace");

  await initWorkspace(workspacePath);
  await writeFile(
    path.join(workspacePath, "models", "missing-provider.yaml"),
    `---
id: missing-provider
model: llama3.1
---
`,
  );
  await writeFile(
    path.join(workspacePath, "models", "bad-base-url.yaml"),
    `---
id: bad-base-url
provider: openai-compatible
model: llama3.1
base_url: not-a-url
---
`,
  );

  const compiled = await compileWorkspace(workspacePath);
  assert.ok(
    compiled.diagnostics.some(
      (diagnostic) => diagnostic.code === "model_missing_provider",
    ),
  );
  assert.ok(
    compiled.diagnostics.some(
      (diagnostic) => diagnostic.code === "model_invalid_base_url",
    ),
  );
});

test("compiler does not infer belief strength from untagged prose", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const workspacePath = path.join(root, "workspace");

  await initWorkspace(workspacePath);
  await writeFile(
    path.join(workspacePath, "entities", "actor", "BELIEFS.md"),
    [
      "@actor knows @other is late.",
      "@actor suspects @other is hiding something.",
      "@actor doubts @other will help.",
      "@actor treats tagged material as compiled. :+1",
    ].join("\n"),
  );

  const compiled = await compileWorkspace(workspacePath);
  assert.deepEqual(
    compiled.beliefs.map((belief) => belief.propositionText),
    ["@actor treats tagged material as compiled."],
  );
});

test("compiler reports invalid entity kind metadata", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const workspacePath = path.join(root, "workspace");

  await initWorkspace(workspacePath);
  await writeFile(
    path.join(workspacePath, "entities", "actor", "IDENTITY.md"),
    `---
id: actor
kind: organization
name: Actor
visibility: public
---

@actor is a participant in the simulation.
`,
  );

  const compiled = await compileWorkspace(workspacePath);
  const diagnostic = compiled.diagnostics.find(
    (candidate) => candidate.code === "entity_invalid_kind",
  );
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /organization/);
});

test("compiler reports membership access cycles", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const workspacePath = path.join(root, "workspace");

  await writeMembershipWorld(workspacePath);
  await writeFile(
    path.join(workspacePath, "connections", "mafia-alice.md"),
    `---
id: mafia-alice
kind: connection
entities: [mafia, alice]
---

This connection gives @mafia access to @alice knowledge. :access:member
`,
  );
  await writeFile(
    path.join(workspacePath, "connections", "alice-self.md"),
    `---
id: alice-self
kind: connection
entities: [alice]
---

This connection gives @alice access to @alice knowledge. :access:member
`,
  );

  const compiled = await compileWorkspace(workspacePath);
  const cycle = compiled.diagnostics.find(
    (diagnostic) => diagnostic.code === "membership_cycle",
  );
  const selfLoop = compiled.diagnostics.find(
    (diagnostic) => diagnostic.code === "membership_self_loop",
  );
  assert.ok(cycle);
  assert.match(cycle.message, /@alice -> @inner-circle -> @mafia -> @alice/);
  assert.ok(selfLoop);
});

test("CLI start rejects compiled worlds with membership access loops", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const workspacePath = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.sqlite");

  await writeMembershipWorld(workspacePath);
  await writeFile(
    path.join(workspacePath, "connections", "mafia-alice.md"),
    `---
id: mafia-alice
kind: connection
entities: [mafia, alice]
---

This connection gives @mafia access to @alice knowledge. :access:member
`,
  );

  await assert.rejects(
    () =>
      runCli([
        "start",
        workspacePath,
        "--scenario",
        "membership-room",
        "--command",
        "cycle-start",
        "--db",
        dbPath,
        "--json",
      ]),
    /Membership access cycle is invalid/,
  );
});

test("CLI positional parsing ignores option values", async (context) => {
  const root = await createRepoLocalRunRoot(context);
  const workspacePath = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.sqlite");

  await writeMembershipWorld(workspacePath);

  const started = await runCli([
    "start",
    "--scenario",
    "membership-room",
    "--command",
    "positional-start",
    workspacePath,
    "--db",
    dbPath,
    "--json",
  ]);

  assert.equal(started.scenarioId, "membership-room");
  assert.deepEqual(started.actors, ["alice", "inner-circle", "mafia"]);
});

test("frontmatter parser accepts yaml-only files with closing fence at EOF", () => {
  const parsed = parseFrontmatter(
    "---\nid: local\nprovider: openai-compatible\n---",
  );

  assert.equal(parsed.data.id, "local");
  assert.equal(parsed.data.provider, "openai-compatible");
  assert.equal(parsed.body, "");
});

test("OpenAI-compatible model diagnostics normalize valid base URLs", () => {
  const model = modelRecord({
    base_url: "http://localhost:11434/v1/",
  });

  assert.match(
    describeModelForDiagnostics(model),
    /Base URL: http:\/\/localhost:11434\/v1/,
  );
});

test("AI generation reports invalid OpenAI-compatible base URLs without SDK retry noise", async () => {
  const model = modelRecord({
    base_url: "https://https://inf1-ein.tail8a1c20.ts.net/v1",
  });

  await assert.rejects(
    () =>
      generateDoxveltText({
        actorId: "coo",
        purpose: "turn",
        model,
        prompt: "Speak as the COO.",
      }),
    (error) => {
      assert.ok(error instanceof DoxveltGenerationError);
      assert.match(error.message, /AI generation failed for turn actor coo/);
      assert.match(error.message, /invalid base_url metadata/);
      assert.match(error.message, /more than one URL scheme/);
      assert.doesNotMatch(error.message, /AI_RetryError/);
      return true;
    },
  );
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
`,
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
`,
    ],
    [
      "entities/alice/BELIEFS.md",
      "@alice treats her own assignment as urgent. :+3\n",
    ],
    [
      "entities/alice/SURFACE.md",
      "@alice usually appears watchful. :surface:in_person :+3\n",
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
`,
    ],
    [
      "entities/inner-circle/BELIEFS.md",
      "@inner-circle treats the password as changed. :+3\n",
    ],
    [
      "entities/inner-circle/SURFACE.md",
      "@inner-circle usually appears disciplined. :surface:in_person :+3\n",
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
`,
    ],
    [
      "entities/mafia/BELIEFS.md",
      "@mafia treats the docks as controlled territory. :+3\n",
    ],
    [
      "entities/mafia/SURFACE.md",
      "@mafia usually appears untouchable. :surface:in_person :+3\n",
    ],
    [
      "connections/alice-inner-circle.md",
      `---
id: alice-inner-circle
kind: connection
entities: [alice, inner-circle]
---

@inner-circle gives @alice access. :access:member
`,
    ],
    [
      "connections/inner-circle-mafia.md",
      `---
id: inner-circle-mafia
kind: connection
entities: [inner-circle, mafia]
---

This connection gives @inner-circle access to @mafia knowledge. :access:member
`,
    ],
  ]);

  for (const relativePath of files.keys()) {
    await mkdir(path.dirname(path.join(root, relativePath)), {
      recursive: true,
    });
  }

  for (const [relativePath, content] of files.entries()) {
    await writeFile(path.join(root, relativePath), content);
  }
}

async function runCli(args: string[]): Promise<any> {
  const result = await execFileAsync(
    process.execPath,
    ["src/cli/index.ts", ...args],
    {
      cwd: process.cwd(),
    },
  );

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
      ...metadata,
    },
    body: "",
  };
}
