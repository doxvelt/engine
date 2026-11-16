import { actorRuntimeFor, configurationsFor, type RuntimeOptions } from "./selection.ts";
import type { AgentRuntimeEvent, RunActorTurnRequest } from "./contracts.ts";
import { DEFAULT_ACTOR_PROFILE } from "../core/types.ts";

type ModelStream = {
  draftId: string;
  iterator: AsyncIterator<AgentRuntimeEvent>;
  controller: AbortController;
};

/** DSH retains credentials and provider mechanics; Rust owns candidate semantics. */
export class NativeModelHost {
  private streams = new Map<string, ModelStream>();
  private sequence = 0;
  private options: RuntimeOptions;
  constructor(options: RuntimeOptions) { this.options = options; }

  async call(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (method === "model.catalog") {
      if (!Array.isArray(params.actorIds) || params.actorIds.some(id => typeof id !== "string")) throw new Error("Invalid model catalog request.");
      const actors = params.actorIds as string[];
      return { generationActorIds: actors.filter(id => actorRuntimeFor(this.options, id).runtime),
        ...(this.options.actorConfigurations ? { actorConfigurations: actors.flatMap(id => configurationsFor(this.options, id).map(({ key, label, profile }) => ({ characterId: id, key, label, profile }))) } : {}) };
    }
    if (method === "model.status") {
      const runtime = this.options.actorTurnRuntime ?? this.options.actorTurnRuntimes?.values().next().value ?? this.options.actorConfigurations?.[0]?.runtime;
      const identity = runtime?.identity;
      return { configured: Boolean(runtime), runtimeProfile: DEFAULT_ACTOR_PROFILE, adapter: runtime ? { id: publicStatusIdentity(identity?.id), version: publicStatusIdentity(identity?.version) } : null,
        provider: runtime ? publicStatusIdentity(identity?.providerId) : null, model: runtime ? publicStatusIdentity(identity?.modelId) : null };
    }
    if (method === "model.describe") {
      const selection = actorRuntimeFor(this.options, String(params.actorId), (params.profile ?? params.configuration) as Parameters<typeof actorRuntimeFor>[2]);
      return { configured: Boolean(selection.runtime), profile: selection.profile, defaultProfile: selection.profile === DEFAULT_ACTOR_PROFILE };
    }
    if (method === "model.open") {
      const request = params.request as RunActorTurnRequest;
      const { runtime } = actorRuntimeFor(this.options, request.actorId, request.runtimeProfile);
      if (!runtime) throw new Error("No local actor-turn runtime is configured.");
      const controller = new AbortController();
      const identity = capturedIdentity(runtime);
      const captured = deepFreeze(structuredClone(request));
      let active: AsyncIterator<AgentRuntimeEvent> | undefined;
      const iterator: AsyncIterator<AgentRuntimeEvent> = {
        next() { active ??= runtime.runActorTurn(captured, controller.signal)[Symbol.asyncIterator](); return active.next(); },
        return() { return active?.return?.() ?? Promise.resolve({ done: true, value: undefined }); },
      };
      const streamId = "model-stream-" + ++this.sequence;
      this.streams.set(streamId, { draftId: request.draftId, iterator, controller });
      return { streamId, identity };
    }
    const streamId = String(params.streamId);
    const stream = this.streams.get(streamId);
    if (method === "model.close") {
      if (stream) this.closeStream(streamId, stream);
      if (typeof params.draftId === "string") for (const [id, candidate] of this.streams)
        if (candidate.draftId === params.draftId) this.closeStream(id, candidate);
      return {};
    }
    if (method !== "model.next" || !stream) throw new Error("Unknown native model stream.");
    let rejectAbort: ((error: Error) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abort = () => { this.closeStream(streamId, stream); rejectAbort?.(new Error("Model request aborted.")); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const next = await Promise.race([stream.iterator.next(), aborted]);
      if (next.done) this.streams.delete(streamId);
      return next.done ? { done: true } : { done: false, event: wireEvent(next.value) };
    } catch { this.closeStream(streamId, stream); throw new Error("Model service failed."); }
    finally { signal.removeEventListener("abort", abort); }
  }
  close(): void { for (const [id, stream] of this.streams) this.closeStream(id, stream); }
  private closeStream(id: string, stream: ModelStream): void {
    if (this.streams.get(id) !== stream) return;
    this.streams.delete(id); stream.controller.abort();
    try { void Promise.resolve(stream.iterator.return?.()).catch(() => {}); }
    catch { /* Provider cleanup is best effort after cancellation. */ }
  }
}
function publicStatusIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return !normalized || normalized.length > 160 || /^[a-z][a-z\d+.-]*:\/\//i.test(normalized) || /(?:^|[/_=-])(?:sk|pk|rk|api[_-]?key|token|secret)(?:[/_=-]|$)/i.test(normalized) ? null : normalized;
}
/** Keep malformed provider values JSON-safe so Rust can reject the stream. */
function wireEvent(event: unknown): unknown {
  if (!event || typeof event !== "object") return null;
  const input = event as Record<string, unknown>;
  const type = typeof input.type === "string" && ["text_delta", "usage", "completed", "failed", "tool_requested", "tool_completed"].includes(input.type)
    ? input.type : "invalid_event";
  const output: Record<string, unknown> = { type };
  if (type === "text_delta" || type === "completed") {
    const text = input.text;
    output.text = typeof text === "string" && text.length <= 1_000_000 && text.isWellFormed() ? text : null;
  }
  if (["usage", "completed", "failed"].includes(type) && input.usage !== undefined) {
    const usage = input.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) output.usage = null;
    else {
      const fields: Record<string, unknown> = {};
      for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
        const value = (usage as Record<string, unknown>)[key];
        if (value !== undefined) fields[key] = typeof value === "number" && Number.isFinite(value) ? value : null;
      }
      output.usage = fields;
    }
  }
  if (["completed", "failed"].includes(type) && input.stopReason !== undefined) output.stopReason = input.stopReason === null
    ? null : typeof input.stopReason === "string" && ["stop", "length", "tool_use", "error", "aborted", "other"].includes(input.stopReason)
      ? input.stopReason : "invalid_stop_reason";
  return output;
}
function capturedIdentity(runtime: RuntimeOptions["actorTurnRuntime"]) {
  const safe = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    if (!normalized || normalized.length > 160 || !/^@?[A-Za-z0-9][A-Za-z0-9._/+@-]*$/.test(normalized)) return null;
    if (normalized.split("/").some(part => !part || part === "." || part === ".." ||
      /^(?:sk[_-](?:(?:proj|live)[_-])?|pk_|rk_|gh[pous]_|xox[baprs]-|AKIA|AIza|ya29\.)/i.test(part) ||
      /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(part))) return null;
    return normalized;
  };
  try {
    const identity = runtime?.identity;
    return { id: safe(identity?.id) ?? "unknown", version: safe(identity?.version) ?? "unknown",
      providerId: safe(identity?.providerId), modelId: safe(identity?.modelId) };
  } catch { return { id: "unknown", version: "unknown", providerId: null, modelId: null }; }
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
