import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

type Element = { props: Record<string, unknown> };
type Component = (props: Record<string, unknown>) => Element;

async function composerFixture(carried = "") {
  const effects: (() => void | (() => void))[] = [];
  const frames = new Map<number, () => void>();
  const components = new Map<string, Component>();
  const snapshot = { draft: "", phase: "ready" };
  const saved = { opened: { simulationId: "story", branchId: "path" }, simulations: [], branches: [], episodes: [] };
  const body = {};
  let frameId = 0;
  let stateIndex = 0;
  let editor = "";
  let writes = 0;
  let refuseInsertion = false;
  let tree: Element;
  const bindings = {
    window: { __ModuleLoader__: { load: (definition: { factory: (require: (name: string) => unknown) => unknown }) =>
      definition.factory(name => name === "react" ? {
        createElement: (_type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) =>
          ({ props: { ...props, children } }),
        useState: (initial: unknown) => [stateIndex++ === 0 ? saved : initial, () => {}],
        useRef: (current: unknown) => ({ current }),
        useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
      } : { Button: "button", Modal: "dialog" }) } },
    document: { body, activeElement: body },
    requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    fetch: async () => ({ ok: true, json: async () => ({ opened: {} }) }),
  };
  const plugin = runInNewContext(await readFile("scripts/dsh-gui-spike/client.js", "utf8"), bindings);
  const input = { snapshot };
  const ctx = {
    effect: (effect: () => void) => { effect(); },
    inputTriggers: { registerSource() {} },
    uiConversation: { events: { register() {} } },
    slots: {
      inject: (_slot: string, callback: () => void) => { callback(); },
      register: (slot: { name: string }, component: Component) => { components.set(slot.name, component); },
    },
    workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
    sessions: {
      list: { getSnapshot: () => ({ byId: { old: { cwd: "." } } }) },
      create: async () => "next",
      binding: (sessionId: string) => ({ ctx: sessionId }),
    },
    conversation: { input: { for: (sessionId: string) =>
      sessionId === "old" ? { snapshot: { draft: carried, phase: "ready" } } : input } },
    uiWorkspace: { openSession() {} },
  };
  plugin.apply(ctx);
  const row = components.get("conversation.chat.node")!({ node: { data: { saved: true } }, sessionId: "old" });
  const openPath = row.props.openEpisodeSession as (selection: unknown, keepDraft: boolean) => Promise<void>;
  await openPath({ simulationId: "story" }, true);
  const actions = {
    setDraft: (text: string) => { editor = snapshot.draft = text; },
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
    insertText: (text: string, span: { start: number; end: number }) => {
      if (refuseInsertion) return false;
      writes++;
      editor = editor.slice(0, span.start) + text + editor.slice(span.end);
      // DSH's Lexical edit is accepted before its new draft/revision is published.
      return true;
    },
  };
  function render() {
    stateIndex = 0;
    effects.length = 0;
    tree = components.get("conversation.input.dock")!({
      sessionId: "next", inputActions: actions,
      useSession: (select: (state: unknown) => unknown) => select({ openState: "open" }),
      useInput: (select: (state: unknown) => unknown) => select(snapshot),
      getInputSnapshot: () => snapshot, focusComposer() {}, openEpisodeSession() {},
    });
    return effects.map(effect => effect()).filter((cleanup): cleanup is () => void => typeof cleanup === "function");
  }
  function control(label: string): Element {
    function find(element: unknown): Element | undefined {
      if (!element || typeof element !== "object" || !("props" in element)) return undefined;
      const node = element as Element;
      if (node.props.label === label || node.props['aria-label'] === label) return node;
      return (node.props.children as unknown[]).flat(Infinity).map(find).find(Boolean);
    }
    return find(tree)!;
  }
  return {
    render,
    value: (label: string) => control(label).props.value,
    select(label: string, value: string) {
      const node = control(label);
      (node.props.onChange as (input: unknown) => void)(node.props['aria-label'] ? { target: { value } } : value);
    },
    frame() {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback());
      snapshot.draft = editor;
    },
    change(text: string, phase = "ready") { editor = snapshot.draft = text; snapshot.phase = phase; },
    refuse(value: boolean) { refuseInsertion = value; },
    text: () => editor,
    writes: () => writes,
    switchMode(mode: string) {
      function find(element: unknown): Element | undefined {
        if (!element || typeof element !== "object" || !("props" in element)) return undefined;
        const node = element as Element;
        if (node.props.label === "Action") return node;
        return (node.props.children as unknown[]).flat(Infinity).map(find).find(Boolean);
      }
      const control = find(tree)!;
      (control.props.onChange as (mode: string) => void)(mode);
    },
  };
}

test("opening a corrected path restores unsent prose once when routing and caret effects share a frame", async () => {
  const typed = "/perform @Corin to @Nell | Unsent continuation after the edit.";
  const composer = await composerFixture(typed);
  composer.render();
  composer.frame();
  assert.equal(composer.text(), typed);
  assert.equal(composer.writes(), 1);
});

test("pending restoration preserves newer player input and leaves submitting input alone", async () => {
  for (const phase of ["ready", "sending"]) {
    const composer = await composerFixture();
    composer.render();
    const typed = phase === "ready" ? "A newly typed continuation" : "";
    composer.change(typed, phase);
    composer.frame();
    assert.equal(composer.text(), typed);
    assert.equal(composer.writes(), 0);
  }
});

test("an empty saved episode gets one ready-to-type route without an implicit audience", async () => {
  const composer = await composerFixture();
  composer.render();
  composer.frame();
  assert.equal(composer.text(), "/perform @Corin ");
  assert.equal(composer.writes(), 1);
});

test("refused restoration keeps the carried draft available for retry", async () => {
  const composer = await composerFixture("/perform @Nell to self | Remember the river.");
  composer.refuse(true);
  composer.render();
  composer.frame();
  assert.equal(composer.text(), "");
  composer.refuse(false);
  composer.render();
  composer.frame();
  assert.equal(composer.text(), "/perform @Nell to self | Remember the river.");
  assert.equal(composer.writes(), 1);
});

test("unmounting cancels composer restoration before mutation", async () => {
  const composer = await composerFixture("Unsent words");
  composer.render().forEach(cleanup => cleanup());
  composer.frame();
  assert.equal(composer.text(), "");
  assert.equal(composer.writes(), 0);
});

test("the action control keeps private direction separate from the player's performance", async () => {
  const composer = await composerFixture();
  composer.change("/perform @Corin #Nell My spoken words.");
  composer.render();
  composer.switchMode("generate");
  assert.doesNotMatch(composer.text(), /My spoken words/);
  composer.change("/generate @Nell #Mara My private direction.");
  composer.render();
  composer.switchMode("perform");
  assert.equal(composer.text(), "/perform @Corin #Nell My spoken words.");
  composer.render();
  composer.switchMode("generate");
  assert.equal(composer.text(), "/generate @Nell #Mara My private direction.");
});

test("DSH's visible default survives typed actor and turn overrides and is retained for the next performance", async () => {
  const composer = await composerFixture();
  composer.render(); composer.frame(); composer.render();
  assert.equal(composer.value("Default audience"), "!unset");
  composer.select("Default audience", "Mara");
  composer.change("/perform @Nell #Corin Only this turn."); composer.render();
  assert.equal(composer.value("Default audience"), "Mara");
  assert.equal(composer.value("Character"), "Corin");
  composer.change(""); composer.render(); composer.frame(); composer.render();
  assert.equal(composer.text(), "/perform @Corin ");
  assert.equal(composer.value("Default audience"), "Mara");
});
