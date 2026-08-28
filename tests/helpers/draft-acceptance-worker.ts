import { parentPort, workerData } from "node:worker_threads";
import {
  acceptActorTurnDraft,
  discardActorTurnDraft,
} from "../../src/core/draft-lifecycle.ts";
import {
  openBranchStore,
  type SqliteSimulationRepository,
} from "../../src/store/branch-sqlite.ts";

type Work = {
  dbPath: string;
  action: "accept" | "discard";
  commandId: string;
  draftId: string;
};

const work = workerData as Work;
let store: SqliteSimulationRepository | undefined;
try {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      store = await openBranchStore(work.dbPath).open();
      break;
    } catch (error) {
      if (
        (error as { code?: string }).code !== "ERR_SQLITE_ERROR" ||
        attempt === 39
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!store) throw new Error("worker could not open draft store");
  let result: { replayed: boolean } | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      result =
        work.action === "accept"
          ? acceptActorTurnDraft(store, {
              ownerScope: "owner",
              simulationId: "sim",
              draftId: work.draftId,
              commandId: work.commandId,
            })
          : discardActorTurnDraft(store, {
              ownerScope: "owner",
              simulationId: "sim",
              draftId: work.draftId,
              commandId: work.commandId,
            });
      break;
    } catch (error) {
      if (
        (error as { code?: string }).code !== "ERR_SQLITE_ERROR" ||
        attempt === 39
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!result) throw new Error("worker could not settle draft command");
  parentPort?.postMessage({ ok: true, replayed: result.replayed });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    name: error instanceof Error ? error.name : "Error",
  });
} finally {
  store?.close();
}
