import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

type Element = { type: string | ((props: Record<string, unknown>) => Element); props: Record<string, unknown> };

/** Render the registered SavedTurn component and invoke its actual event handlers. */
async function editorFixture(audience: string[] | null) {
  const hooks: { value: unknown }[] = [];
  const components = new Map<string, (props: Record<string, unknown>) => Element>();
  const requests: Record<string, unknown>[] = [];
  let hookIndex = 0;
  const origin = { actor: "Corin", audience, whisper: "", version: "message", expectedHead: "head", body: "#Mara(Private performance.)", next: null,
    cast: ["Corin", "Mara", "Nell"].map(token => ({ token, name: token, canGenerate: token !== "Corin" })) };
  const plugin = runInNewContext(await readFile("scripts/dsh-gui-spike/client.js", "utf8"), {
    window: { __ModuleLoader__: { load: (definition: { factory(require: (name: string) => unknown): unknown }) => definition.factory(name => name === "react" ? {
      createElement: (type: Element["type"], props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: { ...props, children } }),
      useState(initial: unknown) {
        const index = hookIndex++;
        const state = hooks[index] ?? (hooks[index] = { value: initial });
        return [state.value, (next: unknown) => { state.value = typeof next === "function" ? next(state.value) : next; }];
      },
      useRef(initial: unknown) {
        const index = hookIndex++;
        return (hooks[index] ?? (hooks[index] = { value: { current: initial } })).value;
      },
    } : { Button: "button", Modal: "dialog" }) } },
    crypto: { randomUUID },
    fetch: async (_url: string, options: RequestInit) => {
      const command = JSON.parse(String(options.body)) as Record<string, unknown>;
      requests.push(command);
      assert.ok(["history-origin", "history-edit-next"].includes(String(command.mode)));
      return { ok: true, json: async () => command.mode === "history-origin" ? origin : { selection: { simulationId: "story", branchId: "alternate" } } };
    },
  });
  plugin.apply({ effect(fn: () => void) { fn(); }, inputTriggers: { registerSource() {} }, uiConversation: { events: { register() {} } },
    slots: { inject(_name: string, fn: () => void) { fn(); }, register(slot: { name: string }, component: (props: Record<string, unknown>) => Element) { components.set(slot.name, component); } } });
  const node = components.get("conversation.chat.node")!({ sessionId: "episode", node: { data: { saved: true, id: "turn", version: "message", character: "Corin", body: origin.body } } });
  assert.equal(typeof node.type, "function");
  let tree: Element;
  function render() { hookIndex = 0; tree = (node.type as (props: Record<string, unknown>) => Element)(node.props); }
  function find(predicate: (node: Element) => boolean): Element {
    function visit(value: unknown): Element | undefined {
      if (!value || typeof value !== "object" || !("props" in value)) return undefined;
      const element = value as Element;
      if (predicate(element)) return element;
      return (element.props.children as unknown[]).flat(Infinity).map(visit).find(Boolean);
    }
    const result = visit(tree);
    assert.ok(result, "expected historical-editor control");
    return result;
  }
  const button = (label: string) => find(node => node.type === "button" && (node.props.children as unknown[]).includes(label));
  async function click(label: string) {
    (button(label).props.onClick as (event: unknown) => void)({ currentTarget: {} });
    await new Promise<void>(resolve => setImmediate(resolve));
    render();
  }
  render();
  await click("Edit turn");
  return { requests, button, render,
    speaker: () => find(node => node.props["aria-label"] === "Speaking character"),
    click,
  };
}

for (const [label, audience, expected] of [
  ["unresolved base", null, null],
  ["explicit actor-only base", [], []],
  ["selected base", ["Mara", "Nell"], ["Nell"]],
] as const) {
  test(`DSH historical speaker changes preserve the ${label}`, async () => {
    const fixture = await editorFixture(audience === null ? null : [...audience]);
    assert.equal(fixture.speaker().props.value, "Corin");
    assert.doesNotThrow(() => (fixture.speaker().props.onChange as (event: unknown) => void)({ target: { value: "Mara" } }));
    fixture.render();
    assert.equal(fixture.speaker().props.value, "Mara");
    assert.equal(fixture.button("Save correction").props.disabled, true, "a speaker change requires a replacement path");
    assert.equal(fixture.button("Save & generate next turn").props.disabled, false);
    await fixture.click("Save & generate next turn");
    const request = fixture.requests.find(command => command.mode === "history-edit-next")!;
    assert.equal(request.speaker, "Mara");
    assert.equal(JSON.stringify(request.editedAudience), JSON.stringify(expected));
  });
}
