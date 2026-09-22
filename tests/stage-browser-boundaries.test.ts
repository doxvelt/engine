import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

test("reopened historical editor cancels to the selected immutable turn, even when row and version IDs differ", async () => {
  const source = await readFile(new URL("../src/local-ui/pages/stage.vue", import.meta.url), "utf8");
  const attribute = source.match(/:data-revise-turn="([^"]+)"/)?.[1];
  const cancel = source.match(/async function cancelHistory\(\): Promise<void> \{[\s\S]*?\n\}/)?.[0];
  assert.ok(attribute); assert.ok(cancel);
  // Read the actual template binding and execute the actual page handler. The
  // absent trigger models close/reopen; a decoy catches accidental row-ID lookup.
  const binding = new Function("turn", `return ${attribute};`) as (turn: { id: string; messageVersionId: string }) => string;
  const turns = [
    { id: "immutable-selected", messageVersionId: "immutable-other" },
    { id: "transcript-row-selected", messageVersionId: "immutable-selected" },
  ];
  const focused: number[] = [];
  const buttons = turns.map((turn, index) => ({ dataset: { reviseTurn: binding(turn) }, focus(options: unknown) { assert.deepEqual(options, { preventScroll: true }); focused.push(index); } }));
  let cancelled = false, measured = false, ticked = false;
  const history = { value: { scrollTop: 999, querySelectorAll(selector: string) { assert.equal(selector, "[data-revise-turn]"); return buttons; } } };
  const session = { value: { history: { editor: { selection: { messageVersionId: "immutable-selected" } }, cancel() { cancelled = true; } } } };
  const code = ts.transpileModule(cancel, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = new Function("session", "history", "historyTrigger", "suspendedReadingTop", "nextTick", "measureHistory", `${code}\nreturn cancelHistory;`)(session, history, null, 120,
    async () => { ticked = true; }, () => { measured = true; }) as () => Promise<void>;
  await run();
  assert.deepEqual(focused, [1], "focus returns to the selected version, never the decoy row ID");
  assert.equal(history.value.scrollTop, 120);
  assert.ok(cancelled && ticked && measured);
});
