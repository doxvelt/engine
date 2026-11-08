import { DshActorTurnRuntime } from "./dsh.ts";
import { createDshModelService } from "./dsh-models.ts";

export const LOCAL_OPENAI_COMPATIBLE_PROVIDER_ID = "local-openai-compatible";
export const LOCAL_OPENAI_COMPATIBLE_KEYLESS_TRANSPORT_KEY = "doxvelt-local-keyless";
export const LOCAL_OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW = 16_384;
export const LOCAL_OPENAI_COMPATIBLE_DEFAULT_MAX_TOKENS = 1_024;

export type LocalOpenAICompatibleRuntimeConfig = Readonly<{
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  transport?: "auto" | "sse" | "websocket" | "websocket-cached";
}>;

export function validatedModelRoute(config: LocalOpenAICompatibleRuntimeConfig): LocalOpenAICompatibleRuntimeConfig {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const modelId = requiredModelId(config.modelId);
  const contextWindow = boundedPositiveInteger(config.contextWindow, LOCAL_OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW, "contextWindow");
  const maxTokens = boundedPositiveInteger(config.maxTokens, LOCAL_OPENAI_COMPATIBLE_DEFAULT_MAX_TOKENS, "maxTokens");
  if (maxTokens > contextWindow) throw new Error("maxTokens must not exceed contextWindow.");
  return { ...config, baseUrl, modelId, contextWindow, maxTokens };
}

/** Creates a DSH model service with one explicit OpenAI-compatible route. */
export function createLocalOpenAICompatibleRuntime(config: LocalOpenAICompatibleRuntimeConfig) {
  const route = validatedModelRoute(config);
  let diagnostic: string | null = null;
  let ready: ReturnType<typeof createDshModelService> | undefined;
  const service = {
    async *stream(options: Parameters<Awaited<ReturnType<typeof createDshModelService>>["stream"]>[0]) {
      const llm = await (ready ??= createDshModelService({ [LOCAL_OPENAI_COMPATIBLE_PROVIDER_ID]: route }));
      yield* llm.stream(options);
    },
  };
  const runtime = new DshActorTurnRuntime(service, {
    provider: LOCAL_OPENAI_COMPATIBLE_PROVIDER_ID, model: route.modelId,
    maxTokens: route.maxTokens!,
    onStart: () => { diagnostic = null; },
    onFailure: detail => { diagnostic = safeRuntimeDiagnostic(detail); },
  });
  return Object.assign(runtime, { getDiagnostic: () => diagnostic });
}

export function normalizeLocalOpenAICompatibleBaseUrl(value: string): string {
  return normalizeBaseUrl(value);
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("runtime baseUrl must be a valid http or https URL."); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("runtime baseUrl must be http/https without credentials, query, or fragment.");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function requiredModelId(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("runtime model ID must be nonempty text without control characters (up to 1024 characters).");
  return value;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 1_000_000)
    throw new Error(`${label} must be an integer from 1 to 1000000.`);
  return resolved;
}

/** Classify internally, return only fixed copy. Never log or retain provider detail. */
export function safeRuntimeDiagnostic(detail: unknown): string {
  const text = typeof detail === "string" ? detail : detail instanceof Error ? detail.message : "";
  if (/\b(?:401|403)\b|unauthori[sz]ed|authentication|invalid.{0,12}(?:key|token)/i.test(text))
    return "Runtime authentication failed. Check the API key in server configuration or DOXVELT_RUNTIME_API_KEY, then restart.";
  if (/connect|ECONN|fetch failed|unavailable|timed? ?out|\b50[234]\b/i.test(text))
    return "Runtime unavailable. Check the configured endpoint and that the inference server is running, then retry.";
  return "Runtime request failed. Check server configuration, model availability and provider compatibility, then retry. Provider details are withheld.";
}
