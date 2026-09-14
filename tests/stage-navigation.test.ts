import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { computed, effectScope, nextTick, ref, watch } from "vue";
import * as sessionModule from "../src/local-ui/lib/stage-session.ts";
import * as playModule from "../src/local-ui/lib/stage-play.ts";
import * as apiModule from "../src/local-ui/lib/stage-api.ts";

async function fixture(t: test.TestContext) {
  const source = await readFile("src/local-ui/pages/stage.vue", "utf8");
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!;
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const modules: Record<string, unknown> = { "../lib/stage-session": sessionModule, "../lib/stage-play": playModule, "../lib/stage-api": apiModule };
  let unmount = () => {};
  let resize = () => {};
  const document = { activeElement: {}, body: {} };
  const bindings = {
    require: (id: string) => modules[id], exports: {}, ref, computed, watch, nextTick,
    useRoute: () => ({ query: {} }), useRuntimeConfig: () => ({ public: { apiBase: "http://stage.invalid" } }),
    onMounted: () => {}, onBeforeUnmount: (cb: () => void) => { unmount = cb; },
    onBeforeRouteLeave: () => {}, onBeforeRouteUpdate: () => {}, document,
    window: { removeEventListener() {}, confirm: () => true },
    ResizeObserver: class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect() {} },
  };
  const scope = effectScope();
  const page = scope.run(() => new Function(...Object.keys(bindings), `${code}\nreturn { session, history, awayFromLatest, measureHistory, jumpToLatest, toggleEditing, chooseDraft, composer, resumeComposer, activateComposerMode, onDraftPickerOpen, ...(typeof onDraftCloseAutoFocus === "function" ? { onDraftCloseAutoFocus } : {}) };`)(...Object.values(bindings)));
  t.after(() => { unmount(); scope.stop(); });
  const editor = { value: "Existing\nprose", selectionStart: 2, selectionEnd: 2, focuses: 0,
    focus() { this.focuses++; document.activeElement = this; },
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; } };
  let top = 0;
  let turnTop = 500;
  const el = { scrollHeight: 2000, clientHeight: 400, focuses: 0,
    get scrollTop() { return top; }, set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    focus() { this.focuses++; }, getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () => editor,
    querySelectorAll: () => [
      { dataset: { historyKey: 'turn' }, getBoundingClientRect: () => ({ top: turnTop - top, bottom: turnTop + 300 - top }) },
      { dataset: { historyKey: 'last' }, getBoundingClientRect: () => ({ top: 1800 - top, bottom: 1948 - top }) },
    ],
  };
  page.history.value = el;
  page.composer.value = el;
  await nextTick(); await nextTick();
  const closeDraftPicker = async () => {
    // Invoke the callback through the actual USelect content binding. Reka emits
    // this event before its default trigger focus; a page-handler-only test misses it.
    const picker = source.match(/<USelect[^>]*aria-label="Saved drafts"[^>]*>/)?.[0] || "";
    const binding = picker.match(/:content="(\{ onCloseAutoFocus: \w+ \})"/);
    const content = binding ? new Function('page', `with (page) { return (${binding[1]}); }`)(page) : {};
    const event = new Event('closeAutoFocus', { cancelable: true });
    content.onCloseAutoFocus?.(event);
    if (!event.defaultPrevented) document.activeElement = trigger;
    await nextTick(); await nextTick();
    return event;
  };
  const trigger = {};
  return { page, el, editor, document, trigger, closeDraftPicker, resize: () => resize(), reflow: () => { turnTop += 100; resize(); }, unmount };
}

test("actual Stage history opens latest, preserves earlier reading on updates and resize, and returns keyboard focus on Jump", async t => {
  const f = await fixture(t);
  assert.equal(f.el.scrollTop, 1600, "initial mounted history opens at latest");
  f.el.scrollTop = 550; f.page.measureHistory();
  assert.equal(f.page.awayFromLatest.value, true);
  f.page.session.value.reviewText = "Draft update";
  await nextTick(); await nextTick();
  assert.equal(f.el.scrollTop, 550);
  f.el.clientHeight = 300; f.resize();
  assert.equal(f.el.scrollTop, 550);
  f.reflow();
  assert.equal(f.el.scrollTop, 650, "same earlier turn offset survives reflow above it");
  f.page.jumpToLatest();
  assert.equal(f.el.scrollTop, 1700);
  assert.equal(f.el.focuses, 1);
  assert.equal(f.page.awayFromLatest.value, false);
  f.el.scrollTop = 1680; f.page.measureHistory();
  assert.equal(f.page.awayFromLatest.value, false, "bottom padding alone does not make the latest turn offscreen");
  f.el.scrollTop = 1640; f.page.measureHistory();
  assert.equal(f.page.awayFromLatest.value, true, "the actual latest turn edge is offscreen");
});

test("actual Stage explicit editor reopening sets caret at existing end once without editing prose", async t => {
  const f = await fixture(t);
  await f.page.toggleEditing();
  assert.equal(f.editor.selectionStart, f.editor.value.length);
  assert.equal(f.editor.selectionEnd, f.editor.value.length);
  f.editor.selectionStart = 3;
  f.page.session.value.reviewText = "ordinary input";
  f.page.session.value.actorId = "picker";
  await nextTick(); await nextTick();
  assert.equal(f.editor.selectionStart, 3);
  assert.equal(f.editor.focuses, 1);
  await f.page.toggleEditing(); await f.page.toggleEditing();
  assert.equal(f.editor.value, "Existing\nprose");
  assert.equal(f.editor.selectionStart, f.editor.value.length);
});

test("explicit draft editing reveals its editor when the player was reading earlier history", async t => {
  const f = await fixture(t);
  f.el.scrollTop = 550;
  f.page.measureHistory();
  await f.page.toggleEditing();
  assert.equal(f.el.scrollTop, f.el.scrollHeight - f.el.clientHeight, "Edit is an explicit navigation to the draft, not a passive update");
  assert.equal(f.editor.focuses, 1);
});

for (const change of ["session", "focus", "unmount"] as const) {
  test(`queued editor focus does not steal focus after ${change} changes`, async t => {
    const f = await fixture(t);
    const focusing = f.page.toggleEditing();
    if (change === "session") f.page.session.value = new sessionModule.StageSession({ apiBase: "http://stage.invalid", simulationId: "other", branchId: "main" });
    if (change === "focus") f.document.activeElement = {};
    if (change === "unmount") f.unmount();
    await focusing;
    assert.equal(f.editor.focuses, 0);
  });
}

test("Home and identity composition stay inside the approved disclosure and navigation boundary", async () => {
  const home = await readFile("src/local-ui/pages/index.vue", "utf8");
  assert.match(home, /<h1[^>]*>The last crossing<\/h1>/);
  assert.match(home, /Create your own/);
  assert.match(home, /Browser workspaces/);
  assert.match(home, /@click="createBlankWorkspace"/);
  assert.match(home, /@click="deleteWorkspace\(workspace\)"/);
  const identity = await readFile("src/local-ui/components/StageIdentity.vue", "utf8");
  assert.doesNotMatch(identity, /actor\?\.(?:context|prompt|beliefs|memories|stageWhispers)/);
  const audience = await readFile("src/local-ui/components/StageAudience.vue", "utf8");
  assert.doesNotMatch(audience, /· Accepted/);
});


test("composer resume and mode entry preserve independent text and ignore ordinary picker/input updates", async t => {
  const f = await fixture(t);
  const session = f.page.session.value;
  session.direction = "Private\ndirection";
  session.performance = "Public performance";
  f.page.chooseDraft('compose');
  await f.closeDraftPicker();
  assert.equal(f.editor.selectionStart, f.editor.value.length);
  session.mode = 'perform';
  await f.page.resumeComposer();
  assert.equal(f.editor.focuses, 2);
  f.editor.selectionStart = 1;
  session.audienceMode = 'selected'; session.audienceIds = ['actor'];
  session.performance += '!';
  await nextTick(); await nextTick();
  assert.equal(f.editor.selectionStart, 1);
  assert.equal(f.editor.focuses, 2);
  session.mode = 'direct';
  await f.page.resumeComposer();
  assert.equal(session.direction, "Private\ndirection");
  assert.equal(session.performance, "Public performance!");
  assert.equal(f.editor.value, "Existing\nprose");
});

test("queued composer resume is invalidated by a newer mode entry", async t => {
  const f = await fixture(t);
  const first = f.page.resumeComposer();
  f.page.session.value.mode = 'perform';
  const second = f.page.resumeComposer();
  await Promise.all([first, second]);
  assert.equal(f.editor.focuses, 1);
});

test("page binds focus only to explicit entry and retains Nuxt popover focus ownership", async () => {
  const page = await readFile("src/local-ui/pages/stage.vue", "utf8");
  assert.doesNotMatch(page, /@update:model-value="resumeComposer"/);
  assert.match(page, /@click="activateComposerMode"/);
  assert.match(page, /ref="composer"/);
  assert.match(page, /ref="historyContent"/);
  assert.match(page, /aria-controls="stage-history"/);
  for (const path of ["src/local-ui/components/StageIdentity.vue", "src/local-ui/components/StageAudience.vue"]) {
    const component = await readFile(path, "utf8");
    assert.match(component, /<UPopover>/);
    assert.doesNotMatch(component, /mode="hover"|preventDefault|closeAutoFocus|onCloseAutoFocus/);
  }
});


test("Saved drafts close lifecycle leaves resumed prose focused at its unchanged end", async t => {
  const f = await fixture(t);
  f.page.chooseDraft('saved');
  await f.closeDraftPicker();
  assert.equal(f.document.activeElement, f.trigger, "ordinary selection returns focus to the trigger");
  for (let i = 0; i < 2; i++) {
    f.page.chooseDraft('compose');
    await nextTick(); await nextTick();
    const event = await f.closeDraftPicker();
    assert.equal(event.defaultPrevented, true, "resume owns the cancellable close autofocus");
    assert.equal(f.document.activeElement, f.editor);
    assert.equal(f.editor.selectionStart, f.editor.value.length);
    assert.equal(f.editor.selectionEnd, f.editor.value.length);
    assert.equal(f.editor.value, "Existing\nprose");
    f.page.chooseDraft('saved');
    await f.closeDraftPicker();
    assert.equal(f.document.activeElement, f.trigger);
  }
});

test("Saved drafts resumes after pointer leave moves focus to the closing listbox", async t => {
  const f = await fixture(t);
  const listbox = { contains: (el: unknown) => el === listbox };
  f.document.activeElement = { closest: () => listbox };
  f.page.onDraftPickerOpen(true);
  f.page.chooseDraft("compose");
  f.document.activeElement = listbox;
  const event = await f.closeDraftPicker();
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.document.activeElement, f.editor);
});

test("Saved drafts resumes when its closing listbox is removed before Vue mounts the editor", async t => {
  const f = await fixture(t);
  const listbox = { isConnected: true, contains: (el: unknown) => el === listbox };
  f.document.activeElement = { closest: () => listbox };
  f.page.chooseDraft("compose");
  f.document.activeElement = listbox;
  const event = new Event('closeAutoFocus', { cancelable: true });
  f.page.onDraftCloseAutoFocus(event);
  listbox.isConnected = false;
  f.document.activeElement = f.document.body;
  await nextTick(); await nextTick();
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.document.activeElement, f.editor);
});

for (const change of ["session", "unmount", "mode", "selection", "focus", "locked", "reopen"] as const) {
  test(`Saved drafts pending resume is cancelled by ${change} before close`, async t => {
    const f = await fixture(t);
    f.page.chooseDraft('compose');
    if (change === "session") f.page.session.value = new sessionModule.StageSession({ apiBase: "http://stage.invalid", simulationId: "other", branchId: "main" });
    if (change === "unmount") f.unmount();
    if (change === "mode") f.page.session.value.mode = 'perform';
    if (change === "selection") f.page.chooseDraft('saved');
    if (change === "focus") f.document.activeElement = {};
    if (change === "locked") f.page.session.value.busy = true;
    if (change === "reopen") f.page.onDraftPickerOpen(true);
    const event = await f.closeDraftPicker();
    assert.equal(event.defaultPrevented, false);
    assert.equal(f.editor.focuses, 0);
  });
}


test("automatic mode changes retain tab focus; explicit activation enters the composer", async t => {
  const f = await fixture(t);
  const tab = { getAttribute: () => 'true' };
  f.document.activeElement = tab;
  f.page.session.value.mode = 'perform';
  await nextTick(); await nextTick();
  assert.equal(f.document.activeElement, tab);
  assert.equal(f.editor.focuses, 0);
  f.page.activateComposerMode({ target: { closest: () => tab } });
  await nextTick(); await nextTick();
  assert.equal(f.document.activeElement, f.editor);
  assert.equal(f.editor.selectionStart, f.editor.value.length);
});
