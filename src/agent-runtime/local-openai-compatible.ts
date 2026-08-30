import {
  createModels,
  createProvider,
  type Model,
  type ModelThinkingLevel,
  type Transport,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { requiredSafeIdentifier } from "../core/draft-contracts.ts";
import { PiActorTurnRuntime } from "./pi.ts";

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
  thinkingLevel?: ModelThinkingLevel;
  transport?: Transport;
}>;

/** Creates exactly one deployment-configured OpenAI-compatible Pi runtime. */
export function createLocalOpenAICompatibleRuntime(
  config: LocalOpenAICompatibleRuntimeConfig,
): PiActorTurnRuntime {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const modelId = requiredModelId(config.modelId);
  const apiKey = config.apiKey || LOCAL_OPENAI_COMPATIBLE_KEYLESS_TRANSPORT_KEY;
  const contextWindow = boundedPositiveInteger(config.contextWindow, LOCAL_OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW, "contextWindow");
  const maxTokens = boundedPositiveInteger(config.maxTokens, LOCAL_OPENAI_COMPATIBLE_DEFAULT_MAX_TOKENS, "maxTokens");
  if (maxTokens > contextWindow) throw new Error("maxTokens must not exceed contextWindow.");
  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: LOCAL_OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl,
    reasoning: config.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
  const provider = createProvider({
    id: LOCAL_OPENAI_COMPATIBLE_PROVIDER_ID,
    name: "Local OpenAI-compatible",
    baseUrl,
    auth: { apiKey: { name: "Local OpenAI-compatible API key", resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return new PiActorTurnRuntime(models, model, {
    getApiKey: () => apiKey,
    ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
    ...(config.transport ? { transport: config.transport } : {}),
  });
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
  return requiredSafeIdentifier(value, "runtime model ID");
}

function boundedPositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 1_000_000)
    throw new Error(`${label} must be an integer from 1 to 1000000.`);
  return resolved;
}
