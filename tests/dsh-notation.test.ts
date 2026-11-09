import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const cast = [
  { token: "Corin", name: "Corin", canGenerate: false },
  { token: "Nell", name: "Nell", canGenerate: true, configurations: [
    { key: "default", label: "Quick" }, { key: "careful", label: "Careful" },
  ] },
  { token: "Mara", name: "Mara", canGenerate: true },
];
const plugin = runInNewContext(await readFile("scripts/dsh-gui-spike/client.js", "utf8"), {
  window: { __ModuleLoader__: { load: (definition: { factory: (require: () => unknown) => unknown }) => definition.factory(() => ({})) } },
});

test("compact audiences round-trip groups, self, everyone and delegated choice without a pipe", () => {
  for (const [input, audience, body] of [
    ["/perform @Corin #Mara The ferry is ready.", "Mara", "The ferry is ready."],
    ["/perform @Corin #Mara #Nell #Mara I mentioned @Nell and #other in my words.", "Nell,Mara", "I mentioned @Nell and #other in my words."],
    ["/perform @Corin #all A | B\nSecond line", "!all", "A | B\nSecond line"],
    ["/perform @Corin #self A private thought", "!self", "A private thought"],
    ["/generate @Nell #actor Answer quietly.", "!actor", "Answer quietly."],
    ["/generate @Nell#careful #actor:Corin,Mara Consider the river.", "!actor:Corin,Mara", "Consider the river."],
  ]) {
    const command = plugin.parseDraft(input, cast);
    assert.ok(command?.actor);
    assert.equal(command.audience, audience);
    assert.equal(command.body, body);
    const reparsed = plugin.parseDraft(plugin.formatDraft(command), cast);
    assert.equal(reparsed.audience, audience);
    assert.equal(reparsed.body, body);
    assert.equal(reparsed.actor, command.actor);
  }
});

test("unknown recipients, ambiguous audience scope and unavailable actors cannot widen delivery", () => {
  for (const input of [
    "/perform @Corin #Nobody Don't widen this.",
    "/perform @Corin #all #Mara Conflicting audience.",
    "/perform @Corin #actor Choose for me.",
    "/generate @Nell#missing #all Wrong configuration.",
    "/perform @Unknown #all Wrong speaker.",
    "/perform @Corin #Mara:other Malformed recipient.",
  ]) {
    const command = plugin.parseDraft(input, cast);
    assert.ok(!command?.actor || !command.audience, input);
  }
  const command = plugin.parseDraft("/perform @Corin #Mara\n#Nell is a literal line in the performance.", cast);
  assert.equal(command.audience, "Mara");
  assert.equal(command.body, "\n#Nell is a literal line in the performance.");
});

test("an earlier web draft remains readable and is formatted into the compact notation", () => {
  const command = plugin.parseDraft("/perform @Corin to @Nell, @Mara | Keep the old unsent words.", cast);
  assert.equal(command.audience, "Nell,Mara");
  assert.equal(plugin.formatDraft(command), "/perform @Corin #Nell #Mara Keep the old unsent words.");
});

test("a character named All cannot turn a private picker selection into the everyone shorthand", () => {
  const characters = [...cast, { token: "All", name: "All", canGenerate: false }];
  const draft = plugin.formatDraft({ mode: "perform", character: "Corin", audience: "All", body: "Only for you." });
  assert.equal(draft, "/perform @Corin #[All] Only for you.");
  assert.equal(plugin.parseDraft(draft, characters).audience, "All");
  assert.equal(plugin.parseDraft("/perform @Corin #all Everyone.", characters).audience, "!all");
});

test("scoped Perform preserves turn overrides and spans while retaining the explicit composer default", () => {
  const defaults = { audience: "Mara", audienceSyntax: "scoped-fallback-v1" };
  const command = plugin.parseDraft('/perform @Corin #Mara,Nell Shared #Mara(secret|[unintelligible]) after', cast, defaults);
  assert.equal(command.character, "Corin");
  assert.equal(command.audience, "Mara", "typed turn selector must not mutate the default");
  assert.equal(command.body, '#Mara,Nell Shared #Mara(secret|[unintelligible]) after');
  assert.equal(plugin.formatDraft(command), '/perform @Corin #Mara,Nell Shared #Mara(secret|[unintelligible]) after');
  assert.equal(defaults.audience, "Mara");
  const privateTurn = plugin.parseDraft('/perform @Nell #Nell(private thought)', cast, { audience: '!unset', audienceSyntax: 'scoped-v1' });
  assert.equal(privateTurn.audience, '!unset');
  assert.equal(privateTurn.body, '#Nell(private thought)');
});
