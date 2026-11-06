import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { withReverie } from "../src/memory/reverie.ts";

const executable = process.env.DOXVELT_REVERIE_EXECUTABLE;
test("the independent Reverie executable publishes inspectable memory and recalls it after restart", {
  skip: !executable && "Set DOXVELT_REVERIE_EXECUTABLE to a protocol-1 native build.",
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "doxvelt-reverie-wire-"));
  const options = { executable: executable!, database: path.join(directory, "reverie.sqlite"), characterId: "nell" };
  let reflections = 0;
  await withReverie({
    ...options,
    async readSource(id) {
      assert.equal(id, "ferry");
      return { foundation: "Nell keeps the quay.", messages: [
        { id: "turn-1", role: "user", text: "Corin offers Nell a sealed letter." },
      ] };
    },
    async reflect(request, modelKey) {
      assert.equal(modelKey, "scripted");
      assert.match(JSON.stringify(request.input), /sealed letter/);
      reflections++;
      return JSON.stringify({ memories: [{
        gist: "Corin trusted me with the sealed letter.",
        detail: "", feeling: "trusted", cues: ["sealed letter"], salience: 0.9,
        confidence: 0.7, sourceMessageIds: ["m1"],
      }], impressions: [] });
    },
  }, async engine => {
    await engine.request("when", { episodeId: "ferry", position: "2000-03-01", label: "Ferry" });
    assert.equal((await engine.request("memorize", { episodeId: "ferry", modelKey: "scripted" })).status, "published");
    const inspection = await engine.request("inspect", { episodeId: "ferry" });
    assert.deepEqual(inspection.episodes[0]?.contribution?.memories[0]?.sourceMessageIds, ["turn-1"]);
  });
  assert.equal(reflections, 1);

  await withReverie(options, async engine => {
    const cue = "sealed letter";
    assert.equal((await engine.request("retrieve", { at: "1999-03-01", cue })).memories.length, 0);
    assert.equal((await engine.request("retrieve", { at: "2001-03-01", cue, episodeId: "ferry" })).memories.length, 0);
    const recall = await engine.request("retrieve", { at: "2001-03-01", cue });
    assert.match(recall.text, /Corin trusted me/);
  });
});
