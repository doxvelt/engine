import assert from "node:assert/strict";
import test from "node:test";
import { HomeCollectionController } from "../src/local-ui/lib/home-collection.ts";

const item = { simulationId: "saved / run", branchId: "alternate", scenarioName: "Duplicate", createdAt: "2026-01-01", openedAt: null };
test("Home distinguishes loading/error/empty and navigates only by saved IDs", async t => {
  const home = new HomeCollectionController();
  assert.equal(home.status, "loading");
  let fail = true;
  t.mock.method(globalThis, "fetch", async () => {
    if (fail) throw new Error("Offline");
    return Response.json({ simulations: [item] });
  });
  await home.load("http://home.invalid");
  assert.equal(home.status, "error"); assert.equal(home.error, "Offline");
  fail = false; await home.load("http://home.invalid");
  assert.equal(home.status, "ready"); assert.deepEqual(home.items, [item]);
  assert.deepEqual(home.target(item), { path: "/stage", query: { simulation: item.simulationId, branch: item.branchId } });
});
test("late Home lists cannot replace a newer scope or an unmounted view", async t => {
  const home = new HomeCollectionController();
  let release: (response: Response) => void = () => {};
  t.mock.method(globalThis, "fetch", async (url: string) => url.startsWith("old") ? new Promise<Response>(r => { release = r; }) : Response.json({ simulations: [] }));
  const old = home.load("old"); await home.load("new"); release(Response.json({ simulations: [item] })); await old;
  assert.equal(home.status, "ready"); assert.deepEqual(home.items, []);
  const leaving = home.load("old"); home.dispose(); release(Response.json({ simulations: [item] })); await leaving;
  assert.deepEqual(home.items, []);
});
