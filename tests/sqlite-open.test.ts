import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { openBranchStore } from "../src/store/branch-sqlite.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "doxvelt-open-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "runtime.sqlite");
}

function worker(t: test.TestContext, dbPath: string, role: string, lock?: string) {
  const child = new Worker(new URL("./helpers/sqlite-open-worker.ts", import.meta.url), {
    workerData: { dbPath, role, lock },
  });
  const messages: string[] = [];
  let failure: Error | undefined;
  child.on("message", (message: string) => messages.push(message));
  child.on("error", (error) => { failure = error; });
  t.after(async () => { failure ??= new Error("Worker stopped during cleanup"); await child.terminate(); });
  const wait = async (expected: string) => {
    const deadline = performance.now() + 12000;
    while (!messages.includes(expected)) {
      if (failure) throw failure;
      if (performance.now() >= deadline) throw new Error(`Worker did not send ${expected}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { child, wait };
}

function configured(db: DatabaseSync) {
  assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.equal(db.prepare("PRAGMA busy_timeout").get()!.timeout, 5000);
  assert.equal(db.prepare("SELECT count(*) AS n FROM commits").get()!.n, 0);
}

for (const lock of ["reserved", "exclusive", "wal-exclusive", "writer"]) {
  for (const persistent of lock === "reserved" || lock === "wal-exclusive" ? [false, true] : [false]) {
    test(`open: ${lock} ${persistent ? "expires within one budget" : "survives transient lock"}`, { timeout: 15000 }, async (t) => {
      const dbPath = await fixture(t);
      if (lock === "wal-exclusive" || lock === "writer") (await openBranchStore(dbPath).open()).close();
      const holder = worker(t, dbPath, "holder", lock);
      await holder.wait("ready"); // BEGIN has succeeded in the other thread.
      const store = openBranchStore(dbPath);
      let captured: DatabaseSync | undefined;
      let failedSql: string | undefined;
      let signaled = false;
      const schemaWaits: number[] = [];
      const exec = DatabaseSync.prototype.exec;
      t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
        captured = this;
        // Also traces the old combined PRAGMA batch, proving the exact baseline failure.
        for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
          if (statement.includes("journal_mode") && !signaled) {
            signaled = true;
            holder.child.postMessage({ delay: persistent ? 5500 : 350 });
          }
          if (statement.startsWith("CREATE "))
            schemaWaits.push(Number(this.prepare("PRAGMA busy_timeout").get()!.timeout));
          try { exec.call(this, statement); }
          catch (error) { failedSql = statement; throw error; }
          if (statement.includes("journal_mode"))
            assert.throws(() => store.getContentRevision("owner", "missing"), /not open/i);
        }
      });
      t.after(() => store.close());
      const start = performance.now();
      if (persistent) {
        await assert.rejects(store.open(), (error: unknown) => {
          assert.equal((error as { errcode: number }).errcode, 5);
          return true;
        });
        const elapsed = performance.now() - start;
        assert.equal(failedSql, "PRAGMA journal_mode = WAL");
        assert.ok(elapsed >= 4900 && elapsed < 9000, `elapsed ${elapsed} ms`);
        assert.equal(captured!.isOpen, false);
        assert.throws(() => store.getContentRevision("owner", "missing"), /not open/i);
        holder.child.postMessage({ delay: 0 });
        await holder.wait("released");
        await store.open();
      } else {
        try { await store.open(); }
        catch (error) { t.diagnostic(`failure at ${failedSql}: ${String(error)}`); throw error; }
        await holder.wait("released");
        if (lock !== "writer") {
          assert.ok(schemaWaits.length > 1);
          assert.ok(schemaWaits.every((wait) => wait <= 4800), "DDL uses the remaining initialization budget");
        }
      }
      configured(captured!);
      assert.equal(store.getContentRevision("owner", "missing"), null);
    });
  }
}

test("open: concurrent first creation on an absent file", { timeout: 15000 }, async (t) => {
  const dbPath = await fixture(t);
  const openers = Array.from({ length: 4 }, () => worker(t, dbPath, "opener"));
  await Promise.all(openers.map((opener) => opener.wait("ready")));
  for (const opener of openers) opener.child.postMessage("go");
  await Promise.all(openers.map((opener) => opener.wait("opened")));
  const store = await openBranchStore(dbPath).open();
  store.close();
});

for (const seam of ["pragma", "WAL", "DDL", "column check"]) {
  for (const cleanupThrows of [false, true]) {
    test(`open: ${seam} failure closes handle${cleanupThrows ? " and preserves error when close throws" : ""}`, async (t) => {
      const store = openBranchStore(await fixture(t));
      const failure = Object.assign(new Error(`injected ${seam}`), { code: "ERR_SQLITE_ERROR", errcode: 1 });
      let captured: DatabaseSync | undefined;
      let hits = 0;
      const exec = DatabaseSync.prototype.exec;
      const prepare = DatabaseSync.prototype.prepare;
      const close = DatabaseSync.prototype.close;
      t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
        captured = this;
        if ((seam === "pragma" && sql.includes("foreign_keys")) ||
            (seam === "WAL" && sql.includes("journal_mode")) ||
            (seam === "DDL" && sql.includes("CREATE TABLE"))) {
          hits++;
          throw failure;
        }
        return exec.call(this, sql);
      });
      t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
        if (seam === "column check" && sql.includes("table_info")) { hits++; throw failure; }
        return prepare.call(this, sql);
      });
      if (cleanupThrows) t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
        close.call(this);
        throw new Error("cleanup failed after close");
      });
      try {
        await assert.rejects(store.open(), (error: unknown) => error === failure);
        assert.equal(hits, 1, "non-BUSY initialization failures must not retry");
        assert.equal(captured!.isOpen, false);
        assert.throws(() => store.getContentRevision("owner", "missing"), /not open/i);
      } finally {
        t.mock.restoreAll();
        store.close();
        if (captured?.isOpen) captured.close();
      }
      await store.open();
      assert.equal(store.getContentRevision("owner", "missing"), null);
      store.close();
    });
  }
}
