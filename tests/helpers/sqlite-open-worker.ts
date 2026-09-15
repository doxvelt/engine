import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { openBranchStore } from "../../src/store/branch-sqlite.ts";

const port = parentPort!;
const { dbPath, role, lock } = workerData as {
  dbPath: string; role: "holder" | "opener"; lock?: string;
};
if (role === "holder") {
  const db = new DatabaseSync(dbPath);
  if (lock === "wal-exclusive") db.exec("PRAGMA locking_mode=EXCLUSIVE");
  db.exec(lock === "reserved" || lock === "writer" ? "BEGIN IMMEDIATE" : "BEGIN EXCLUSIVE");
  let timer: ReturnType<typeof setTimeout>;
  port.on("message", ({ delay }: { delay: number }) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      db.exec("ROLLBACK");
      db.close();
      port.postMessage("released");
      port.close();
    }, delay);
  });
  port.postMessage("ready");
} else {
  port.once("message", async () => {
    const store = openBranchStore(dbPath);
    try {
      await store.open();
      port.postMessage("opened");
    } finally {
      store.close();
      port.close();
    }
  });
  port.postMessage("ready");
}
