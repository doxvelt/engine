import { Agent } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  Models,
  ModelThinkingLevel,
  Transport,
} from "@earendil-works/pi-ai";
import type {
  ActorTurnRuntime,
  AgentRuntimeEvent,
  RunActorTurnRequest,
  RuntimeAdapterIdentity,
} from "./contracts.ts";

export type PiActorTurnRuntimeOptions = Readonly<{
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  thinkingLevel?: ModelThinkingLevel;
  transport?: Transport;
}>;

export const PI_ACTOR_TURN_RUNTIME_ID = "pi-agent-core";
export const PI_ACTOR_TURN_RUNTIME_VERSION = "0.84.3";

/**
 * Disposable, text-only bridge from Doxvelt's runtime port to low-level Pi.
 * Pi transcripts are confined to one invocation and never escape this adapter.
 */
export class PiActorTurnRuntime implements ActorTurnRuntime {
  readonly identity: RuntimeAdapterIdentity;

  private readonly model: Model<Api>;
  private readonly models: Models;
  private readonly options: PiActorTurnRuntimeOptions;

  constructor(
    models: Models,
    model: Model<Api>,
    options: PiActorTurnRuntimeOptions = {},
  ) {
    const modelSnapshot = snapshotModel(model);
    const providerId = safeIdentityValue(modelSnapshot.provider);
    const modelId = safeIdentityValue(modelSnapshot.id);
    this.identity = Object.freeze({
      id: PI_ACTOR_TURN_RUNTIME_ID,
      version: PI_ACTOR_TURN_RUNTIME_VERSION,
      providerId,
      modelId,
    });
    this.models = models;
    this.model = modelSnapshot;
    this.options = Object.freeze({ ...options });
  }

  async *runActorTurn(
    request: RunActorTurnRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentRuntimeEvent> {
    if (signal?.aborted) {
      yield { type: "failed", stopReason: "aborted" };
      return;
    }

    const agent = new Agent({
      initialState: {
        model: this.model,
        systemPrompt: "",
        messages: [],
        tools: [],
        thinkingLevel: this.options.thinkingLevel ?? "off",
      },
      streamFn: this.models.streamSimple.bind(this.models),
      ...(this.options.getApiKey
        ? { getApiKey: this.options.getApiKey }
        : {}),
      ...(this.options.transport ? { transport: this.options.transport } : {}),
    });

    const queued: AgentRuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    let terminal = false;
    const enqueue = (event: AgentRuntimeEvent): void => {
      if (terminal && event.type !== "failed" && event.type !== "completed") return;
      queued.push(event);
      wake?.();
      wake = undefined;
    };
    const finish = (event: Extract<AgentRuntimeEvent, { type: "failed" | "completed" }>): void => {
      if (terminal) return;
      terminal = true;
      queued.push(event);
      wake?.();
      wake = undefined;
    };
    const finishFailure = (stopReason: "error" | "aborted" | "tool_use" | "other") =>
      finish({ type: "failed", stopReason });

    const unsubscribe = agent.subscribe((event) => {
      if (terminal) return;
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          enqueue({ type: "text_delta", text: update.delta });
        }
        return;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        if (hasToolCall(event.message)) {
          const usage = normalizeUsage(event.message.usage);
          if (usage) enqueue({ type: "usage", usage });
          finishFailure(usage ? "tool_use" : "error");
          agent.abort();
        }
        return;
      }
      if (event.type !== "agent_end") return;
      const final = lastAssistantMessage(event.messages);
      if (!final) {
        finishFailure("other");
        return;
      }
      if (hasToolCall(final)) {
        finishFailure("tool_use");
        return;
      }
      const usage = normalizeUsage(final.usage);
      if (!usage) {
        finishFailure("error");
        return;
      }
      enqueue({ type: "usage", usage });
      const stopReason = mapStopReason(final.stopReason);
      if (stopReason === "stop" || stopReason === "length") {
        finish({
          type: "completed",
          text: textFrom(final),
          stopReason,
        });
      } else {
        finishFailure(stopReason);
      }
    });
    const onAbort = () => {
      finishFailure("aborted");
      agent.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const prompting = agent.prompt(request.prompt).catch(() => {
      finishFailure(signal?.aborted ? "aborted" : "error");
    });

    try {
      while (!terminal || queued.length > 0) {
        const event = queued.shift();
        if (event) {
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (terminal || queued.length > 0) {
            wake = undefined;
            resolve();
          }
        });
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      agent.abort();
      await prompting;
      await agent.waitForIdle().catch(() => undefined);
    }
  }
}

function snapshotModel(model: Model<Api>): Model<Api> {
  const { samplingParams: _requestShapingDefaults, ...safeModel } =
    structuredClone(model);
  return deepFreeze(safeModel as Model<Api>);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safeIdentityValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) return null;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(normalized)) return null;
  if (/^[A-Za-z]:[\\/]/.test(normalized) || /^[\\/]/.test(normalized))
    return null;
  if (normalized.split("/").some((part) => /^(?:sk[_-](?:(?:proj|live)[_-])?|pk_|rk_|gh[pous]_|xox[baprs]-|AKIA|AIza|ya29\.)/i.test(part)))
    return null;
  if (!/^@?[A-Za-z0-9][A-Za-z0-9._/+@-]*$/.test(normalized)) return null;
  if (normalized.split("/").some((part) => !part || part === "." || part === ".."))
    return null;
  return normalized;
}

function normalizeUsage(value: unknown): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const input = safeUsage(source.input);
  const outputTokens = safeUsage(source.output);
  const cacheRead = safeUsage(source.cacheRead);
  const cacheWrite = safeUsage(source.cacheWrite);
  const piTotal = safeUsage(source.totalTokens);
  if (
    input === null ||
    outputTokens === null ||
    cacheRead === null ||
    cacheWrite === null ||
    piTotal === null
  ) return null;
  const inputTokens = safeUsageSum(input, cacheRead, cacheWrite);
  if (inputTokens === null) return null;
  const totalTokens = safeUsageSum(inputTokens, outputTokens);
  if (totalTokens === null || piTotal !== totalTokens) return null;
  return { inputTokens, outputTokens, totalTokens };
}

function safeUsageSum(...values: number[]): number | null {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function safeUsage(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function hasToolCall(message: AssistantMessage): boolean {
  return message.content.some((content) => content.type === "toolCall");
}

function textFrom(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
}

function lastAssistantMessage(
  messages: readonly { role: string }[],
): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message as AssistantMessage;
  }
  return undefined;
}

function mapStopReason(
  stopReason: AssistantMessage["stopReason"],
): "stop" | "length" | "tool_use" | "error" | "aborted" | "other" {
  switch (stopReason) {
    case "stop":
    case "length":
    case "error":
    case "aborted":
      return stopReason;
    case "toolUse":
      return "tool_use";
    case "pending":
    case "deferred":
      return "other";
  }
}
