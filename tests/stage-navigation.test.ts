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
  let rangeReads = 0;
  let proseText = '';
  let columns = 40;
  const textNode = { nodeType: 3, get textContent() { return proseText; }, get length() { return proseText.length; } };
  function lineAt(offset: number): number {
    const parts = proseText.slice(0, offset).split('\n');
    return parts.slice(0, -1).reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / columns)), 0)
      + Math.floor(parts.at(-1)!.length / columns);
  }
  const document = { activeElement: {}, body: {}, createRange() {
    let offset = 0;
    return { setStart(_text: unknown, value: number) { offset = value; }, setEnd() {},
      getBoundingClientRect() { rangeReads++; const y = turnTop + 40 + lineAt(offset) * 20 - top; return { top: y, bottom: y + 20 }; } };
  } };
  const bindings = {
    require: (id: string) => modules[id], exports: {}, ref, computed, watch, nextTick,
    requestAnimationFrame: (cb: () => void) => setImmediate(cb),
    useRoute: () => ({ query: {} }), useRuntimeConfig: () => ({ public: { apiBase: "http://stage.invalid" } }),
    onMounted: () => {}, onBeforeUnmount: (cb: () => void) => { unmount = cb; },
    onBeforeRouteLeave: () => {}, onBeforeRouteUpdate: () => {}, document,
    window: { removeEventListener() {}, confirm: () => true },
    ResizeObserver: class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect() {} },
  };
  const scope = effectScope();
  const page = scope.run(() => new Function(...Object.keys(bindings), `${code}\nreturn { get readingAnchor() { return readingAnchor; }, session, history, awayFromLatest, measureHistory, jumpToLatest, toggleEditing, chooseDraft, composer, resumeComposer, beginComposerMode, activateComposerMode, onDraftPickerOpen, ...(typeof onDraftCloseAutoFocus === "function" ? { onDraftCloseAutoFocus } : {}) };`)(...Object.values(bindings)));
  t.after(() => { unmount(); scope.stop(); });
  const editor = { value: "Existing\nprose", selectionStart: 2, selectionEnd: 2, focuses: 0,
    focus() { this.focuses++; document.activeElement = this; },
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; } };
  let top = 0;
  let roundScroll = false;
  let turnTop = 500;
  const el = { scrollHeight: 2000, clientHeight: 400, focuses: 0,
    get scrollTop() { return top; }, set scrollTop(value: number) { top = Math.max(0, Math.min(roundScroll ? Math.round(value) : value, this.scrollHeight - this.clientHeight)); },
    focus() { this.focuses++; }, getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () => editor,
    querySelectorAll: () => [
      { dataset: { historyKey: 'turn' }, querySelector: () => proseText ? { firstChild: textNode } : null, getBoundingClientRect: () => ({ top: turnTop - top, bottom: turnTop + (proseText ? 60 + lineAt(proseText.length) * 20 : 300) - top }) },
      { dataset: { historyKey: 'last' }, querySelector: () => null, getBoundingClientRect: () => ({ top: (proseText ? 19800 : 1800) - top, bottom: (proseText ? 19948 : 1948) - top }) },
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
  const historyTag = source.match(/<section[^>]*ref="history"[^>]*>/)![0];
  const historyScroll = () => {
    const handler = historyTag.match(/@scroll="(\w+)"/)?.[1];
    assert.ok(handler, 'history scroll is wired');
    page[handler](new Event('scroll'));
  };
  const tabs = source.match(/<UTabs[^>]*>/)![0];
  const modeEvent = (name: string, event: unknown) => {
    const handler = tabs.match(new RegExp(`@${name}="(\\w+)"`))?.[1];
    assert.ok(handler, `template wires ${name}`);
    return page[handler](event);
  };
  return { page, el, editor, document, trigger, closeDraftPicker, modeEvent, historyScroll,
    prose: (text: string) => { proseText = text; el.scrollHeight = 20000; },
    passageTop: (offset: number) => turnTop + 40 + lineAt(offset) * 20 - top,
    wrap: (width: number) => { columns = width; resize(); },
    roundedGeometry: () => { roundScroll = true; turnTop += 0.375; },
    rangeReads: () => rangeReads, resize: () => resize(), reflow: () => { turnTop += 100; resize(); }, unmount };
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

for (const separator of ['\n\n', ' ']) {
  test(`same-turn character passage survives internal rewrap (${separator === ' ' ? 'continuous prose' : 'paragraphs'}) without touching selection`, async t => {
    const f = await fixture(t);
    const paragraphs = Array.from({ length: 45 }, (_, i) => `${i + 1}. ${'A long sentence with words to wrap. '.repeat(4)}`);
    const text = paragraphs.join(separator);
    const passage = paragraphs.slice(0, 24).join(separator).length + separator.length;
    f.prose(text);
    f.el.scrollTop += f.passageTop(passage) - 40;
    f.page.measureHistory();
    const selection = { anchorNode: {}, anchorOffset: passage, focusOffset: passage + 50 };
    f.document.activeElement = selection;
    f.editor.selectionStart = 3; f.editor.selectionEnd = 8;
    const before = f.rangeReads();
    const originalAnchor = { ...f.page.readingAnchor };
    f.wrap(36);
    assert.ok(Math.abs(f.passageTop(passage) - 40) <= 20, 'passage stays within one rewrapped line');
    f.wrap(100);
    assert.ok(Math.abs(f.passageTop(passage) - 40) <= 20, 'rotation keeps the same passage');
    // Return to the original width, then repeat. Passive scroll events may be
    // coalesced, repeated, or arrive after several restores.
    for (const width of [40, 36, 100, 40, 36, 100, 40]) {
      f.wrap(width);
      f.historyScroll(); f.historyScroll();
      assert.deepEqual(f.page.readingAnchor, originalAnchor, 'passive reflows retain the exact character and offset');
      if (width === 40) assert.equal(f.passageTop(passage), 40, 'round trip restores the original passage exactly');
    }
    f.page.session.value.reviewText = 'incoming update';
    await nextTick(); await nextTick();
    assert.ok(Math.abs(f.passageTop(passage) - 40) <= 20);
    assert.equal(f.document.activeElement, selection);
    assert.equal(f.editor.selectionStart, 3); assert.equal(f.editor.selectionEnd, 8);
    assert.equal(f.editor.focuses, 0);
    assert.ok(f.rangeReads() - before < 100, 'range reads are logarithmic, not a full text scan');
    // Removing the anchored turn falls back to the prior scroll position.
    const previousTop = f.el.scrollTop;
    f.el.querySelectorAll = () => [];
    f.resize();
    assert.equal(f.el.scrollTop, previousTop);
  });
}

test('pointer mode entry survives Reka mousedown update and a final click on the moved form', async t => {
  const f = await fixture(t);
  f.page.session.value.direction = 'Private buffer';
  f.page.session.value.performance = 'Performance buffer';
  const tab = { hasAttribute: () => false, getAttribute: () => f.page.session.value.mode === 'perform' ? 'true' : 'false' };
  const pending = f.modeEvent('mousedown.capture', { button: 0, ctrlKey: false, target: { closest: () => tab } });
  // Reka's target mousedown changes mode; browser default focuses the trigger.
  f.page.session.value.mode = 'perform';
  f.document.activeElement = tab;
  await pending;
  f.modeEvent('click', { detail: 1, target: { closest: () => null } });
  await nextTick();
  assert.equal(f.document.activeElement, f.editor);
  assert.equal(f.editor.focuses, 1);
  assert.equal(f.editor.selectionStart, f.editor.value.length);
  assert.equal(f.editor.selectionEnd, f.editor.value.length);
  assert.equal(f.page.session.value.direction, 'Private buffer');
  assert.equal(f.page.session.value.performance, 'Performance buffer');
  f.modeEvent('click', { detail: 1, target: { closest: () => tab } });
  await nextTick();
  assert.equal(f.editor.focuses, 1, 'an unmoved pointer click does not focus twice');
});

for (const change of ['session', 'unmount', 'mode', 'selection', 'focus', 'locked']) {
  test(`pointer mode entry is cancelled by ${change}`, async t => {
    const f = await fixture(t);
    const tab = { hasAttribute: () => false, getAttribute: () => f.page.session.value.mode === 'perform' ? 'true' : 'false' };
    const pending = f.modeEvent('mousedown.capture', { button: 0, ctrlKey: false, target: { closest: () => tab } });
    f.page.session.value.mode = 'perform';
    f.document.activeElement = tab;
    if (change === 'session') f.page.session.value = new sessionModule.StageSession({ apiBase: 'http://stage.invalid', simulationId: 'other', branchId: 'main' });
    if (change === 'unmount') f.unmount();
    if (change === 'mode') f.page.session.value.mode = 'direct';
    if (change === 'selection') f.page.chooseDraft('saved');
    if (change === 'focus') f.document.activeElement = {};
    if (change === 'locked') f.page.session.value.busy = true;
    await pending;
    assert.equal(f.editor.focuses, 0);
  });
}

test('automatic tab focus does not enter editor; keyboard click uses template activation', async t => {
  const f = await fixture(t);
  const tab = { getAttribute: () => 'true' };
  f.document.activeElement = tab;
  f.page.session.value.mode = 'perform';
  await nextTick(); await nextTick();
  assert.equal(f.editor.focuses, 0);
  await f.modeEvent('click', { detail: 0, target: { closest: () => tab } });
  await nextTick(); await nextTick();
  assert.equal(f.editor.focuses, 1);
});

test('real scrolling after passive restore replaces the anchor even before its queued scroll event', async t => {
  const f = await fixture(t);
  f.prose('Continuous prose with enough words to wrap. '.repeat(200));
  f.el.scrollTop = 2500; f.historyScroll();
  const original = { ...f.page.readingAnchor };
  f.wrap(100);
  f.el.scrollTop += 160; // User moves before the programmatic scroll is delivered.
  f.historyScroll();
  const moved = { ...f.page.readingAnchor };
  assert.notEqual(moved.textOffset, original.textOffset);
  for (const width of [40, 36, 100, 40, 100]) {
    f.wrap(width); f.historyScroll();
    assert.deepEqual(f.page.readingAnchor, moved);
    assert.equal(f.passageTop(moved.textOffset), moved.textTop);
  }
  f.page.jumpToLatest(); f.historyScroll();
  assert.equal(f.el.scrollTop, f.el.scrollHeight - f.el.clientHeight);
  f.el.scrollHeight += 100;
  f.resize(); f.historyScroll();
  assert.equal(f.el.scrollTop, f.el.scrollHeight - f.el.clientHeight, 'intentional latest navigation resumes following');
});

test('clamped passive restores keep the reading anchor and do not swallow the next real scroll', async t => {
  const f = await fixture(t);
  f.prose('Continuous prose with enough words to wrap. '.repeat(200));
  f.el.scrollTop = 2500; f.historyScroll();
  const anchor = { ...f.page.readingAnchor };
  f.el.scrollHeight = 500;
  f.wrap(100); f.historyScroll(); f.historyScroll();
  assert.equal(Number(f.el.scrollTop), 100, 'browser clamps the attempted restore');
  assert.deepEqual(f.page.readingAnchor, anchor);
  f.el.scrollHeight = 20000;
  f.wrap(40); f.historyScroll();
  assert.equal(Number(f.el.scrollTop), 2500, 'unclamped reflow returns to the preserved passage');
  f.el.scrollTop -= 1; f.historyScroll();
  assert.notDeepEqual(f.page.readingAnchor, anchor, 'even a small genuine scroll captures its own offset');
});

test('rounded scroll writes retain the original anchor through repeated passive reflows', async t => {
  const f = await fixture(t);
  f.prose('Continuous prose with enough words to wrap. '.repeat(200));
  f.el.scrollTop = 2500; f.historyScroll();
  const anchor = { ...f.page.readingAnchor };
  f.roundedGeometry();
  for (const width of [36, 100, 40, 36, 100, 40]) {
    f.wrap(width); f.historyScroll(); f.historyScroll();
    assert.deepEqual(f.page.readingAnchor, anchor, 'readback suppresses generated events even when the requested scroll was fractional');
    assert.ok(Math.abs(f.passageTop(anchor.textOffset) - anchor.textTop) <= 0.5, 'only browser pixel rounding remains');
  }
  f.el.scrollTop += 1; f.historyScroll();
  assert.notDeepEqual(f.page.readingAnchor, anchor, 'a one-pixel user scroll is not suppressed by a tolerance flag');
});
