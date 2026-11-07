import { BlockAssembler, type GenerateOptions, type LlmRuntime, type TokenUsage } from "@deepseek-ai/dsh-llm";
import { actorOutputContract, AUDIENCE_PROPOSAL_JSON_SCHEMA } from "../core/output-contracts.ts";
import type { ActorTurnRuntime, AgentRuntimeEvent, RunActorTurnRequest, RuntimeAdapterIdentity } from "./contracts.ts";

export const DSH_ACTOR_TURN_RUNTIME_ID = "dsh-llm";
export const DSH_ACTOR_TURN_RUNTIME_VERSION = "0.2.2-rc.1";
export const DSH_TURN_RESULT_TOOL = "doxvelt_turn";

export type DshModelService = Pick<LlmRuntime, "stream">;
export type DshActorTurnOptions = Readonly<{
  provider: string;
  model: string;
  maxTokens?: number;
  reasoningEffort?: GenerateOptions["reasoningEffort"];
  onStart?: () => void;
  onFailure?: (detail: unknown) => void;
}>;

/** One DSH model call over Doxvelt's already projected character context. */
export class DshActorTurnRuntime implements ActorTurnRuntime {
  readonly identity: RuntimeAdapterIdentity;
  private readonly service: DshModelService;
  private readonly options: DshActorTurnOptions;

  constructor(service: DshModelService, options: DshActorTurnOptions) {
    this.service = service;
    this.options = Object.freeze({ ...options });
    this.identity = Object.freeze({
      id: DSH_ACTOR_TURN_RUNTIME_ID, version: DSH_ACTOR_TURN_RUNTIME_VERSION,
      providerId: safeIdentityValue(options.provider), modelId: safeIdentityValue(options.model),
    });
  }

  async *runActorTurn(request: RunActorTurnRequest, signal?: AbortSignal): AsyncIterable<AgentRuntimeEvent> {
    this.options.onStart?.();
    if (signal?.aborted) {
      yield { type: "failed", stopReason: "aborted" };
      return;
    }
    const contract = actorOutputContract(request.outputSchema);
    if (contract === null) {
      yield { type: "failed", stopReason: "error" };
      return;
    }
    const controller = new AbortController();
    const abortSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const assembler = new BlockAssembler();
    let finished = false;
    try {
      const call: GenerateOptions = {
        provider: this.options.provider, model: this.options.model,
        messages: [{ role: "user", content: [{ type: "text", text: request.prompt }] }],
        signal: abortSignal,
        ...(this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens }),
        ...(this.options.reasoningEffort === undefined ? {} : { reasoningEffort: this.options.reasoningEffort }),
        ...(contract === "audience-proposal" ? {
          system: "Return the character's turn by calling doxvelt_turn exactly once with its text and audience. This reports a result. It performs no action. Return no other text or tool calls.",
          tools: [{ name: DSH_TURN_RESULT_TOOL, description: "Report the complete character turn and the characters who can perceive it.", parameters: structuredClone(AUDIENCE_PROPOSAL_JSON_SCHEMA) }],
        } : { tools: [] }),
      };
      for await (const chunk of this.service.stream(call)) {
        abortSignal.throwIfAborted();
        assembler.push(chunk);
        if (chunk.type === "text-delta" && contract === "legacy-text") yield { type: "text_delta", text: chunk.text };
        if (chunk.type === "finish") { finished = true; break; }
      }
      if (!finished) throw new Error("DSH returned an incomplete stream.");
      let finish = assembler.finish;
      // The legacy port lets the domain classify an empty completed response.
      if (contract === "legacy-text" && finish.kind === "error" && finish.failure.code === "EMPTY_RESPONSE")
        finish = { kind: "stop" };
      const usage = normalizeDshUsage(assembler.usage);
      if (usage) yield { type: "usage", usage };
      if (contract === "audience-proposal" && usage && finish.kind === "error" && finish.failure.code === "MALFORMED_RESPONSE") {
        // DSH rejects malformed tool arguments before closing their block.
        // Let the domain classify that output without forwarding provider detail.
        const blocks = assembler.blocks();
        const results = blocks.filter(block => block.type === "tool-call");
        const result = results[0];
        if (results.length === 1 && result?.name === DSH_TURN_RESULT_TOOL &&
            blocks.every(block => block.type === "tool-call" || block.type === "reasoning"))
          yield { type: "completed", text: result.arguments || "{}", stopReason: "stop" };
        else yield { type: "failed", stopReason: "error" };
        return;
      }
      if (finish.kind === "error" || finish.kind === "aborted") {
        if (finish.kind === "error") this.options.onFailure?.(finish.failure.message);
        yield { type: "failed", stopReason: finish.kind };
        return;
      }
      if (!usage) throw new Error("DSH returned invalid token accounting.");
      const blocks = assembler.blocks();
      if (contract === "audience-proposal") {
        const results = blocks.filter(block => block.type === "tool-call");
        const result = results[0];
        if (finish.kind !== "tool-calls" || results.length !== 1 || result?.name !== DSH_TURN_RESULT_TOOL ||
            blocks.some(block => block.type !== "tool-call" && block.type !== "reasoning")) {
          yield { type: "failed", stopReason: "error" };
          return;
        }
        // Domain validation checks exact keys, text, audience membership and limits.
        // The reporting tool is never executed and grants no model capabilities.
        yield { type: "completed", text: result.arguments, stopReason: "stop" };
      } else if (blocks.some(block => block.type === "tool-call")) {
        yield { type: "failed", stopReason: "tool_use" };
      } else if (finish.kind === "stop" || finish.kind === "max-tokens") {
        const text = blocks.filter(block => block.type === "text").map(block => block.text).join("");
        yield { type: "completed", text, stopReason: finish.kind === "stop" ? "stop" : "length" };
      } else {
        yield { type: "failed", stopReason: "other" };
      }
    } catch (error) {
      if (!abortSignal.aborted) this.options.onFailure?.(error);
      yield { type: "failed", stopReason: abortSignal.aborted ? "aborted" : "error" };
    } finally {
      controller.abort();
    }
  }
}

function normalizeDshUsage(usage: TokenUsage | undefined) {
  if (!usage) return null;
  const fields = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0];
  if (fields.some(value => !Number.isSafeInteger(value) || value < 0)) return null;
  const inputTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const totalTokens = inputTokens + usage.outputTokens;
  if (!Number.isSafeInteger(totalTokens) || (usage.totalTokens !== undefined && usage.totalTokens !== totalTokens)) return null;
  return { inputTokens, outputTokens: usage.outputTokens, totalTokens };
}

export function safeIdentityValue(value: unknown): string | null {
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
