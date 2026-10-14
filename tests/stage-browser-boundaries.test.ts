import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { baseParse, type ElementNode } from "@vue/compiler-dom";

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

test("pending continuation exposes the actual Retry request control without a transient error", async () => {
  const source = await readFile(new URL("../src/local-ui/pages/stage.vue", import.meta.url), "utf8");
  const template = source.slice(source.indexOf("<template>") + 10, source.indexOf("</template>\n\n<script"));
  const root = baseParse(template);
  let retryAncestors: ElementNode[] | undefined;
  function visit(node: { type: number; children?: unknown[] }, ancestors: ElementNode[]) {
    if (node.type === 1) {
      const element = node as ElementNode;
      ancestors = [...ancestors, element];
      if (element.tag === "UButton" && element.children.some(c => c.type === 2 && c.content.trim() === "Retry request")) retryAncestors = ancestors;
    }
    for (const child of node.children ?? []) visit(child as typeof node, ancestors);
  }
  visit(root, []); assert.ok(retryAncestors, "the visible UI offers exact request reconciliation");
  const session = { projection: {}, error: "", needsReconcile: true, busy: false, history: { editor: null } };
  for (const element of retryAncestors) {
    for (const prop of element.props) {
      if (prop.type === 7 && prop.name === "if" && prop.exp?.type === 4) {
        assert.ok(new Function("session", `return ${prop.exp.content};`)(session), `Retry is hidden by ${prop.exp.content} after reopen`);
      }
      if (element.tag === "UButton" && prop.type === 7 && prop.name === "bind" && prop.arg?.type === 4 && prop.arg.content === "disabled" && prop.exp?.type === 4) {
        assert.equal(Boolean(new Function("session", "locked", `return ${prop.exp.content};`)(session, true)), false, "mutation lock must not disable reconciliation");
      }
    }
  }
  const retry = retryAncestors.at(-1)!;
  assert.ok(retry.props.some(p => p.type === 7 && p.name === "on" && p.arg?.type === 4 && p.arg.content === "click" && p.exp?.type === 4 && p.exp.content === "session.resume()"));
});
