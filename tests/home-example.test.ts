import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { computed, ref } from "vue";
import * as exampleModule from "../src/local-ui/lib/example-entry.ts";

async function home(t: test.TestContext) {
  const source = await readFile(new URL("../src/local-ui/pages/index.vue", import.meta.url), "utf8");
  assert.match(source, /@click="playExample"/);
  assert.match(source, /Play the example/);
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const navigation: unknown[] = [];
  let unmount = () => {};
  const bindings = {
    require: (id: string) => { assert.equal(id, "../lib/example-entry"); return exampleModule; }, exports: {},
    ref, computed, useRuntimeConfig: () => ({ public: { apiBase: "http://home.invalid" } }),
    useToast: () => ({ add: () => {} }), onMounted: () => {},
    onBeforeUnmount: (callback: () => void) => { unmount = callback; },
    navigateTo: async (target: unknown) => { navigation.push(target); },
  };
  const page = new Function(...Object.keys(bindings), `${code}\nreturn { playExample, example };`)(...Object.values(bindings)) as {
    playExample(): Promise<void>; example: { value: { busy: boolean; error: string } };
  };
  t.after(() => unmount());
  return { page, navigation, unmount: () => unmount() };
}

const result = { workspacePath: "/app/chosen/source", simulationId: "example-last-crossing", branchId: "main" };

test("Home plays straight into Stage, blocks double clicks and retries a lost response", async (t) => {
  const f = await home(t);
  const calls: unknown[] = [];
  let reject: (error: Error) => void = () => {};
  let fail = true;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(options.body)) });
    if (fail) return new Promise<Response>((_resolve, rejectRequest) => { reject = rejectRequest; });
    return Response.json(result);
  });
  const playing = f.page.playExample();
  await f.page.playExample();
  assert.equal(calls.length, 1);
  reject(new Error("Response lost")); await playing;
  assert.equal(f.page.example.value.error, "Response lost");
  assert.equal(f.page.example.value.busy, false);
  assert.deepEqual(f.navigation, []);
  fail = false;
  await f.page.playExample();
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0], { url: "http://home.invalid/examples/last-crossing/play", body: {} });
  assert.equal(f.page.example.value.error, "");
  assert.deepEqual(f.navigation, [{ path: "/stage", query: { workspace: result.workspacePath, simulation: result.simulationId, branch: result.branchId } }]);
});

test("Home ignores a late setup response after leaving the page", async (t) => {
  const f = await home(t);
  let resolve: (value: Response) => void = () => {};
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(r => { resolve = r; }));
  const playing = f.page.playExample();
  f.unmount(); resolve(Response.json(result)); await playing;
  assert.deepEqual(f.navigation, []);
});
