import type {
  ActorTurnRuntime,
  AgentRuntimeEvent,
  RunActorTurnRequest,
} from "../../src/agent-runtime/contracts.ts";

export class DeterministicFakeRuntime implements ActorTurnRuntime {
  readonly identity = { id: "deterministic-fake", version: "1" };
  calls = 0;

  private readonly events: readonly AgentRuntimeEvent[];
  private readonly beforeEvents: ((request: RunActorTurnRequest) => void) | undefined;

  constructor(
    events: readonly AgentRuntimeEvent[],
    beforeEvents?: (request: RunActorTurnRequest) => void,
  ) {
    this.events = events;
    this.beforeEvents = beforeEvents;
  }

  async *runActorTurn(
    request: RunActorTurnRequest,
    _signal?: AbortSignal,
  ): AsyncIterable<AgentRuntimeEvent> {
    this.calls++;
    this.beforeEvents?.(request);
    for (const event of this.events) yield structuredClone(event);
  }
}
