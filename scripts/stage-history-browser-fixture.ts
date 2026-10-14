/** Deterministic real API fixture for probe-stage-history.mjs; never a live model. */
import { createLocalApiServer } from "../src/local-api/server.ts";
import type { RunActorTurnRequest, ActorTurnRuntime } from "../src/agent-runtime/contracts.ts";

export function stageHistoryBrowserFixture(dbPath: string, webOrigin: string) {
  const requests: RunActorTurnRequest[] = [];
  const runtime: ActorTurnRuntime = { identity: { id: "stage-history-browser", version: "1" }, async *runActorTurn(request) {
    requests.push(request);
    const direction = (request.context as { routingDirection?: { completeWhisper?: string; correctedAudience?: string[] | null } }).routingDirection;
    const whisper = direction?.completeWhisper ?? "";
    if (whisper === "DETERMINISTIC-FAIL") { yield { type: "failed", stopReason: "error" }; return; }
    yield { type: "completed", text: JSON.stringify({ text: `Fixture performance: ${whisper || "empty direction"}`,
      audience: [...new Set([request.actorId, ...(direction?.correctedAudience ?? [])])] }), stopReason: "stop" };
  } };
  return { server: createLocalApiServer({ dbPath, actorTurnRuntime: runtime, allowedOrigins: [webOrigin] }), requests };
}
