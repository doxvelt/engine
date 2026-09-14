import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";
import { computed, effectScope, nextTick, reactive, ref, watch, type Ref } from "vue";
import * as sessionModule from "../src/local-ui/lib/stage-session.ts";
import * as playModule from "../src/local-ui/lib/stage-play.ts";
import * as apiModule from "../src/local-ui/lib/stage-api.ts";

// Execute the actual page script, with real Vue reactivity and its actual API/session
// modules. Only Nuxt navigation/lifecycle and the HTTP transport are test boundaries.
async function pageFixture(t: test.TestContext, initialHydration = false) {
  const source = await readFile(new URL("../src/local-ui/pages/stage.vue", import.meta.url), "utf8");
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const route = reactive({ query: { simulation: "starting", branch: "main", workspace: "workspace" } });
  const navigation: unknown[] = [];
  let unmount = () => {};
  let mount = async () => {};
  const scope = effectScope();
  const modules: Record<string, unknown> = { "../lib/stage-session": sessionModule, "../lib/stage-play": playModule, "../lib/stage-api": apiModule };
  const bindings = {
    require: (id: string) => { assert.ok(id in modules); return modules[id]; },
    exports: {}, ref, computed, watch, nextTick,
    useRoute: () => route,
    useRuntimeConfig: () => ({ public: { apiBase: "http://stage.invalid" } }),
    navigateTo: async (target: unknown) => { navigation.push(target); },
    useNuxtApp: () => ({ isHydrating: initialHydration }),
    onMounted: (callback: () => Promise<void>) => { mount = callback; },
    onBeforeUnmount: (callback: () => void) => { unmount = callback; },
    onBeforeRouteLeave: () => {}, onBeforeRouteUpdate: () => {},
    window: { removeEventListener: () => {}, addEventListener: () => {}, performance: { getEntriesByType: () => [{ type: "reload" }] } },
  };
  const page = scope.run(() => new Function(...Object.keys(bindings), `${code}\nreturn { startSimulation, openRun, session, setupBusy, setupError, apiBase, simulationId, scenarioId, navigationWarning, refreshPendingDraft };`)(...Object.values(bindings))) as {
    startSimulation(): Promise<void>; openRun(updateRoute?: boolean): Promise<void>;
    session: Ref<sessionModule.StageSession>; setupBusy: Ref<boolean>; setupError: Ref<string>;
    navigationWarning: Ref<string>; refreshPendingDraft(): Promise<void>;
    apiBase: Ref<string>; simulationId: Ref<string>; scenarioId: Ref<string>;
  };
  page.scenarioId.value = "scenario";
  t.after(() => { unmount(); scope.stop(); });
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  let resolveStart: (response: Response) => void = () => {};
  let rejectStart: (error: Error) => void = () => {};
  const delayedStart = new Promise<Response>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  let delay = true;
  let projectionFailures = 0;
  let missingProjection = false;
  let navigationFailure = false;
  let recordRelease: (response: Response) => void = () => {};
  let delayRecord = false;
  let delayProjection = false;
  let resolveProjection: (response: Response) => void = () => {};
  const delayedProjection = new Promise<Response>(resolve => { resolveProjection = resolve; });
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    const target = new URL(url);
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : null;
    calls.push({ url, body });
    if (target.pathname === "/simulations/start") return delay ? delayedStart : Response.json({});
    if (target.pathname === "/runtime") return Response.json({ configured: true });
    if (target.pathname.endsWith("/stage")) {
      if (missingProjection) return Response.json({ error: "Saved branch missing" }, { status: 404 });
      if (delayProjection && target.pathname.includes("/starting/")) return delayedProjection;
      if (projectionFailures-- > 0) throw new Error("Projection unavailable");
      return Response.json({ scenarioName: target.pathname.split("/")[2], branch: { id: target.searchParams.get("branchId"), headCommitId: "head" }, actors: [], transcript: [], audience: [] });
    }
    if (target.pathname.endsWith("/navigation")) {
      if (body) {
        if (navigationFailure) throw new Error("Navigation offline");
        if (delayRecord && target.pathname.includes("/starting/")) return new Promise<Response>(resolve => { recordRelease = resolve; });
        return Response.json({ version: body.operationId, openedAt: "2026-01-01" });
      }
      return Response.json({ version: null });
    }
    if (target.pathname.endsWith("/drafts")) return Response.json({ drafts: [] });
    throw new Error(`Unexpected request ${url}`);
  });
  return {
    mount: () => mount(),
    missingProjection: () => { missingProjection = true; },
    failNavigation: () => { navigationFailure = true; },
    delayRecord: () => { delayRecord = true; },
    releaseRecord: () => recordRelease(Response.json({ error: "Old navigation failure" }, { status: 500 })),
    page, route, navigation, calls, unmount: () => unmount(),
    release: () => resolveStart(Response.json({})),
    reject: () => rejectStart(new Error("Old Start failed")),
    immediate: () => { delay = false; },
    failProjection: () => { projectionFailures++; },
    delayProjection: () => { delayProjection = true; },
    releaseProjection: () => resolveProjection(Response.json({ scenarioName: "starting", branch: { id: "main", headCommitId: "head" }, actors: [], transcript: [], audience: [] })),
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) { if (check()) return; await setImmediate(); }
  assert.fail("Page orchestration did not reach the expected state");
}

for (const completion of ["success", "error"] as const) {
  test(`page Start ignores late ${completion} after route change without replacing unsaved session`, async (t) => {
    const f = await pageFixture(t);
    const starting = f.page.startSimulation();
    f.route.query.simulation = "existing";
    await until(() => f.page.session.value.projection?.scenarioName === "existing" && !f.page.setupBusy.value);
    const newer = f.page.session.value;
    newer.performance = "Unsaved performance";
    newer.direction = "Unsaved direction";
    newer.reviewText = "Unsaved review";
    f.page.setupError.value = "Newer recovery error";
    f.page.setupBusy.value = true;
    const callsBeforeCompletion = f.calls.length;
    if (completion === "success") f.release(); else f.reject();
    await starting;
    assert.equal(f.page.session.value, newer, "old completion must not replace the newer session");
    assert.equal(newer.performance, "Unsaved performance");
    assert.equal(newer.direction, "Unsaved direction");
    assert.equal(newer.reviewText, "Unsaved review");
    assert.equal(f.page.setupError.value, "Newer recovery error");
    assert.equal(f.page.setupBusy.value, true, "old finally must not clear newer busy state");
    assert.equal(f.calls.length, callsBeforeCompletion, "old completion must not issue new reads");
    assert.deepEqual(f.navigation, []);
  });

  test(`page Start ignores late ${completion} after unmount`, async (t) => {
    const f = await pageFixture(t);
    const starting = f.page.startSimulation();
    const owner = f.page.session.value;
    f.unmount();
    f.page.setupError.value = "Unmounted state";
    const calls = f.calls.length;
    if (completion === "success") f.release(); else f.reject();
    await starting;
    assert.equal(f.page.session.value, owner);
    assert.equal(f.page.setupError.value, "Unmounted state");
    assert.equal(f.calls.length, calls);
    assert.deepEqual(f.navigation, []);
  });
}

test("page Start opens its captured scope normally and retains command identity through projection failure", async (t) => {
  const f = await pageFixture(t);
  f.immediate(); f.failProjection();
  await f.page.startSimulation();
  assert.equal(f.page.session.value.projection === null, true);
  assert.ok(f.page.setupError.value);
  assert.equal(f.page.setupBusy.value, false);
  await f.page.startSimulation();
  const starts = f.calls.filter(call => call.body?.commandId);
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0], starts[1]);
  assert.equal(f.page.session.value.projection?.scenarioName, "starting");
  assert.equal(f.page.setupBusy.value, false);
  assert.equal(f.page.setupError.value, "");
  assert.equal(f.navigation.length, 1);
});


test("page Start ignores completion after API scope changes without opening that scope", async (t) => {
  const f = await pageFixture(t);
  const starting = f.page.startSimulation();
  const owner = f.page.session.value;
  f.page.apiBase.value = "http://another-stage.invalid";
  f.page.setupError.value = "New API state";
  f.release(); await starting;
  assert.equal(f.page.session.value, owner);
  assert.equal(f.page.setupError.value, "New API state");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.url, "http://stage.invalid/simulations/start");
});

test("page Start retains ownership checks while its successful response loads the projection", async (t) => {
  const f = await pageFixture(t);
  f.immediate(); f.delayProjection();
  const starting = f.page.startSimulation();
  await until(() => f.calls.some(call => call.url.includes("/starting/stage")));
  f.route.query.simulation = "existing";
  await until(() => f.page.session.value.projection?.scenarioName === "existing" && !f.page.setupBusy.value);
  const newer = f.page.session.value;
  newer.performance = "Keep this performance";
  f.page.setupError.value = "Keep this error";
  f.page.setupBusy.value = true;
  f.releaseProjection(); await starting;
  assert.equal(f.page.session.value, newer);
  assert.equal(newer.performance, "Keep this performance");
  assert.equal(f.page.setupError.value, "Keep this error");
  assert.equal(f.page.setupBusy.value, true);
  assert.deepEqual(f.navigation, []);
});

test("page Start retries a lost response with its original immutable request", async (t) => {
  const f = await pageFixture(t);
  const starting = f.page.startSimulation();
  f.reject(); await starting;
  assert.equal(f.page.setupError.value, "Old Start failed");
  f.immediate(); await f.page.startSimulation();
  const starts = f.calls.filter(call => call.body?.commandId);
  assert.deepEqual(starts[0], starts[1]);
  assert.equal(f.page.session.value.projection?.scenarioName, "starting");
  assert.equal(f.page.setupError.value, "");
  assert.equal(f.navigation.length, 1);
});


test("intentional Stage entry records once after projection; ordinary refresh and failed entry never promote", async t => {
  const f = await pageFixture(t);
  f.failProjection(); await f.page.openRun(false);
  assert.equal(f.calls.filter(c => c.url.endsWith('/navigation') && c.body).length, 0);
  await f.page.openRun(false);
  const writes = () => f.calls.filter(c => c.url.endsWith('/navigation') && c.body);
  assert.equal(writes().length, 1);
  assert.equal(writes()[0]!.body!.branchId, 'main');
  assert.ok(f.calls.findIndex(c => c.url.includes('/stage?')) < f.calls.indexOf(writes()[0]!));
  await f.page.refreshPendingDraft();
  assert.equal(writes().length, 1);
});

test("metadata failure warns honestly without removing the playable projection or editor text", async t => {
  const f = await pageFixture(t); f.failNavigation();
  await f.page.openRun(false);
  assert.ok(f.page.session.value.projection);
  assert.match(f.page.navigationWarning.value, /could not confirm/i);
  f.page.session.value.performance = 'Keep my prose';
  await f.page.refreshPendingDraft();
  assert.equal(f.page.session.value.performance, 'Keep my prose');
  assert.match(f.page.navigationWarning.value, /could not confirm/i);
});

test("late navigation responses cannot overwrite a newer view or unmounted state", async t => {
  const f = await pageFixture(t); f.delayRecord();
  const opening = f.page.openRun(false);
  await until(() => f.calls.some(c => c.url.endsWith('/navigation') && c.body));
  f.unmount(); f.page.navigationWarning.value = 'Keep current notice';
  f.releaseRecord(); await opening;
  assert.equal(f.page.navigationWarning.value, 'Keep current notice');
});


test("direct non-default entry records that branch and suppresses duplicate loads", async t => {
  const f = await pageFixture(t); f.delayProjection();
  f.route.query.branch = 'alternate';
  await until(() => f.calls.some(c => c.url.includes('/stage?branchId=alternate')));
  await f.page.openRun(false);
  assert.equal(f.calls.filter(c => c.url.includes('/stage?branchId=alternate')).length, 1);
  f.releaseProjection();
  await until(() => !f.page.setupBusy.value);
  const writes = f.calls.filter(c => c.url.endsWith('/navigation') && c.body);
  assert.equal(writes.length, 1); assert.equal(writes[0]!.body!.branchId, 'alternate');
});

test("late projection never records the abandoned scope; late record errors never replace newer notices", async t => {
  const f = await pageFixture(t); f.delayProjection();
  const opening = f.page.openRun(false);
  await until(() => f.calls.some(c => c.url.includes('/starting/stage')));
  f.route.query.simulation = 'existing';
  await until(() => !f.page.setupBusy.value);
  f.releaseProjection(); await opening;
  assert.deepEqual(f.calls.filter(c => c.url.endsWith('/navigation') && c.body).map(c => new URL(c.url).pathname), ['/simulations/existing/navigation']);
});

test("late metadata failure cannot overwrite newer scope or its editor", async t => {
  const f = await pageFixture(t); f.delayRecord();
  const opening = f.page.openRun(false);
  await until(() => f.calls.some(c => c.url.endsWith('/navigation') && c.body));
  f.route.query.simulation = 'existing';
  await until(() => !f.page.setupBusy.value);
  f.page.session.value.performance = 'Newer prose';
  f.page.navigationWarning.value = 'Newer notice';
  f.releaseRecord(); await opening;
  assert.equal(f.page.session.value.performance, 'Newer prose');
  assert.equal(f.page.navigationWarning.value, 'Newer notice');
});

test("known missing Stage entry reports failure without source discovery or automatic Start", async t => {
  const f = await pageFixture(t); f.missingProjection(); await f.mount();
  assert.match(f.page.setupError.value, /Saved branch missing/);
  assert.equal(f.page.session.value.projection, null);
  assert.ok(!f.calls.some(c => c.url.includes('/source') || c.url.includes('/start') && c.body));
});

for (const hydration of [true, false]) {
  test(`browser reload suppression applies only to initial hydration (${hydration})`, async t => {
    const f = await pageFixture(t, hydration); await f.mount();
    assert.ok(f.page.session.value.projection);
    assert.equal(f.calls.filter(c => c.url.endsWith('/navigation') && c.body).length, hydration ? 0 : 1);
  });
}
