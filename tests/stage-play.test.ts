import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  acceptDraftBody,
  classifyDraftReview,
  createCommandLease,
  isStaleDraftBasis,
  playableActors,
  runLeasedMutation,
  settleGenerationLease,
  stableSerialize,
} from "../src/local-ui/lib/stage-play.ts";

test("command leases reuse an ID for an unchanged action body and clear only explicitly", () => {
  let next = 0;
  const lease = createCommandLease(() => `command-${++next}`);
  const first = lease.for("generate", { actorId: "jade", expectedHead: "root" });

  assert.equal(
    lease.for("generate", { expectedHead: "root", actorId: "jade" }),
    first,
  );
  assert.equal(
    lease.for("generate", { actorId: "jade", expectedHead: "next" }),
    "command-2",
  );
  assert.equal(lease.for("accept", { draftId: "draft-1" }), "command-3");

  lease.succeed("generate");
  assert.equal(
    lease.for("generate", { actorId: "jade", expectedHead: "root" }),
    "command-4",
  );
  lease.reset();
  assert.equal(lease.for("accept", { draftId: "draft-1" }), "command-5");
});

test("leased mutations retain identity until projection convergence succeeds", async () => {
  let next = 0;
  const lease = createCommandLease(() => `command-${++next}`);
  const seen: string[] = [];
  let convergenceFails = true;
  const execute = () => runLeasedMutation(
    lease,
    "accept",
    { draftId: "draft-1", finalText: "Edited" },
    async (commandId) => { seen.push(commandId); return { replayed: seen.length > 1 }; },
    async () => { if (convergenceFails) throw new Error("projection unavailable"); },
  );

  await assert.rejects(execute(), /projection did not load/);
  convergenceFails = false;
  assert.deepEqual(await execute(), { replayed: true });
  assert.deepEqual(seen, ["command-1", "command-1"]);
  await execute();
  assert.equal(seen.at(-1), "command-2");
});

test("generation leases survive pending replay and clear only at ready or failed", () => {
  let next = 0;
  const lease = createCommandLease(() => `generate-${++next}`);
  const body = { branchId: "main", expectedHead: "root", actorId: "ceo" };
  const commandId = lease.for("generate", body);

  assert.equal(settleGenerationLease(lease, "generating"), false);
  assert.equal(lease.for("generate", body), commandId);
  assert.equal(settleGenerationLease(lease, "discarded"), false);
  assert.equal(lease.for("generate", body), commandId);
  assert.equal(settleGenerationLease(lease, "ready"), true);
  assert.equal(lease.for("generate", body), "generate-2");
  assert.equal(settleGenerationLease(lease, "failed"), true);
});

test("stable serialization is key-order independent and rejects unsupported values", () => {
  assert.equal(
    stableSerialize({ branchId: "main", nested: { b: 2, a: 1 } }),
    stableSerialize({ nested: { a: 1, b: 2 }, branchId: "main" }),
  );
  assert.throws(() => stableSerialize({ date: new Date() }), /plain objects/);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => stableSerialize(cyclic), /cyclic/);
});

test("Stage actor choices follow supported turn ownership and remain sorted", () => {
  assert.deepEqual(
    playableActors([
      { id: "board", name: "Board", kind: "affiliation" },
      { id: "coo", name: "COO", kind: "agent" },
      { id: "ceo", name: "CEO", kind: "agent" },
      { id: "guest", name: "Guest", kind: "stateless" },
    ]).map((actor) => actor.id),
    ["board", "ceo", "coo", "guest"],
  );
});

test("acceptance omits only byte-identical artifact text", () => {
  assert.deepEqual(acceptDraftBody("accept-1", "Generated text", "Generated text"), {
    commandId: "accept-1",
  });
  assert.deepEqual(acceptDraftBody("accept-2", "Generated text", "Generated text "), {
    commandId: "accept-2",
    finalText: "Generated text ",
  });
});

test("draft review classification distinguishes pending work and keeps failed output out of the editor", () => {
  const pending = classifyDraftReview({
    status: "generating",
    artifact: null,
    failure: null,
  });
  assert.equal(pending.kind, "pending");
  assert.match(pending.message, /still in progress/i);
  assert.equal("text" in pending, false);

  const ready = classifyDraftReview({
    status: "ready",
    artifact: {
      text: "A generated response.",
      provenance: {
        adapter: { id: "pi", version: "3.4" },
        providerId: "openai",
        modelId: "gpt-test",
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        stopReason: "stop",
      },
    },
    failure: null,
  });
  assert.deepEqual(ready, {
    kind: "ready",
    text: "A generated response.",
    provenance: {
      providerModel: "openai / gpt-test",
      adapter: "pi v3.4",
      usage: "20 tokens",
      stopReason: "stop",
    },
  });

  const failed = classifyDraftReview({
    status: "failed",
    artifact: null,
    failure: {
      message: "The runtime stopped before producing a draft.",
      provenance: {
        adapter: { id: "pi", version: "3.4" },
        providerId: null,
        modelId: null,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: null },
        stopReason: "error",
      },
    },
  });
  assert.equal(failed.kind, "failed");
  assert.equal(failed.message, "The runtime stopped before producing a draft.");
  assert.equal("text" in failed, false);
  assert.equal(failed.provenance.providerModel, "Provider / model unavailable");
});

test("staleness compares the draft basis against the current branch head, never transcript IDs", () => {
  assert.equal(
    isStaleDraftBasis(
      { branchId: "main", basisHeadCommitId: "commit-1" },
      { id: "main", headCommitId: "commit-1" },
    ),
    false,
  );
  assert.equal(
    isStaleDraftBasis(
      { branchId: "main", basisHeadCommitId: "commit-1" },
      { id: "main", headCommitId: "commit-2" },
    ),
    true,
  );
  assert.equal(
    isStaleDraftBasis(
      { branchId: "other", basisHeadCommitId: "commit-1" },
      { id: "main", headCommitId: "commit-1" },
    ),
    true,
  );
});

test("Stage uses supported manual and durable routes through scoped command leases", async () => {
  const page = await readFile(
    new URL("../src/local-ui/pages/stage.vue", import.meta.url),
    "utf8",
  );
  const session = await readFile(new URL("../src/local-ui/lib/stage-session.ts", import.meta.url), "utf8");
  const surface = page + session;
  for (const required of ["/runtime", "/drafts", '"accept"', '"discard"', "/turns", "createCommandLease", "runLeasedMutation", "settleGenerationLease", "refreshPendingDraft", "StageSession"])
    assert.ok(surface.includes(required), `missing ${required}`);
  for (const retired of ["/turn-draft", "localStorage", "modelItems", "inspectorTab"])
    assert.equal(surface.includes(retired), false, `retired Stage surface: ${retired}`);
  assert.ok(session.includes('stageWhisperIds: []'), "manual performance does not consume Direct whispers");
});
