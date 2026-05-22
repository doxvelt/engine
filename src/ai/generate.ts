import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, jsonSchema, Output, RetryError } from "ai";
import type { AssetRecord } from "../core/types.ts";

export type DoxveltGenerationPurpose = "turn" | "memory" | "belief_extraction";

export type DoxveltGenerationRequest = {
  actorId: string;
  purpose: DoxveltGenerationPurpose;
  model: AssetRecord;
  prompt: string;
};

export type DoxveltGenerationResult = {
  text: string;
  raw?: unknown;
};

export type DoxveltObjectGenerationRequest<TOutput> = DoxveltGenerationRequest & {
  schema: Parameters<typeof jsonSchema<TOutput>>[0];
  schemaName?: string;
  schemaDescription?: string;
};

export type DoxveltObjectGenerationResult<TOutput> = {
  output: TOutput;
  text: string;
  raw?: unknown;
};

type ResolvedModelConfig = {
  provider: string;
  modelName: string;
  baseURL?: string;
  apiKeyEnv?: string;
  apiKeyPresent?: boolean;
};

export class DoxveltGenerationError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "DoxveltGenerationError";
  }
}

export async function generateDoxveltText(
  request: DoxveltGenerationRequest
): Promise<DoxveltGenerationResult> {
  try {
    const config = resolveModelConfig(request.model);
    const model = resolveLanguageModel(request.model, config);
    const result = await generateText({
      model,
      prompt: request.prompt
    });

    return {
      text: result.text,
      raw: result
    };
  } catch (error) {
    if (error instanceof DoxveltGenerationError) throw error;
    throw toDoxveltGenerationError(request, error);
  }
}

export async function generateDoxveltObject<TOutput>(
  request: DoxveltObjectGenerationRequest<TOutput>
): Promise<DoxveltObjectGenerationResult<TOutput>> {
  const outputOptions: Parameters<typeof Output.object<TOutput>>[0] = {
    schema: jsonSchema<TOutput>(request.schema)
  };

  if (request.schemaName) outputOptions.name = request.schemaName;
  if (request.schemaDescription) outputOptions.description = request.schemaDescription;

  try {
    const config = resolveModelConfig(request.model);
    const model = resolveLanguageModel(request.model, config);
    const result = await generateText({
      model,
      output: Output.object(outputOptions),
      prompt: request.prompt
    });

    return {
      output: result.output,
      text: result.text,
      raw: result
    };
  } catch (error) {
    if (error instanceof DoxveltGenerationError) throw error;
    throw toDoxveltGenerationError(request, error);
  }
}

export function describeModelForDiagnostics(model: AssetRecord): string {
  const config = resolveModelConfig(model);
  return modelConfigLines(model, config).join("\n");
}

function resolveModelConfig(model: AssetRecord): ResolvedModelConfig {
  const provider = stringMetadata(model, "provider");
  const modelName = stringMetadata(model, "model");

  if (!provider) {
    throw new Error(`Model ${model.id} is missing provider metadata.`);
  }

  if (!modelName) {
    throw new Error(`Model ${model.id} is missing model metadata.`);
  }

  if (provider === "openai-compatible") {
    const rawBaseURL = stringMetadata(model, "base_url");
    if (!rawBaseURL) {
      throw new Error(`OpenAI-compatible model ${model.id} is missing base_url metadata.`);
    }

    const baseURL = normalizeOpenAICompatibleBaseURL(model.id, rawBaseURL);
    const apiKeyEnv = stringMetadata(model, "api_key_env");
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;

    return {
      provider,
      modelName,
      baseURL,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      apiKeyPresent: Boolean(apiKey)
    };
  }

  if (provider === "gateway") {
    return {
      provider,
      modelName
    };
  }

  throw new Error(`Unsupported AI model provider for ${model.id}: ${provider}`);
}

function resolveLanguageModel(
  model: AssetRecord,
  config: ResolvedModelConfig
): Parameters<typeof generateText>[0]["model"] {
  if (config.provider === "openai-compatible") {
    if (!config.baseURL) {
      throw new Error(`OpenAI-compatible model ${model.id} is missing base_url metadata.`);
    }

    const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
    const compatible = createOpenAICompatible({
      name: model.id,
      baseURL: config.baseURL,
      ...(apiKey ? { apiKey } : {})
    });

    return compatible(config.modelName);
  }

  if (config.provider === "gateway") {
    return config.modelName;
  }

  throw new Error(`Unsupported AI model provider for ${model.id}: ${config.provider}`);
}

function normalizeOpenAICompatibleBaseURL(modelId: string, value: string): string {
  const raw = value.trim();

  if (/^[a-z][a-z\d+.-]*:\/\/[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
    throw new Error(
      `OpenAI-compatible model ${modelId} has invalid base_url metadata: ${raw}. ` +
        "It appears to contain more than one URL scheme. Use a single URL like http://localhost:11434/v1."
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `OpenAI-compatible model ${modelId} has invalid base_url metadata: ${raw}. ` +
        "Use an absolute URL with http:// or https://, for example http://localhost:11434/v1."
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `OpenAI-compatible model ${modelId} has unsupported base_url protocol: ${parsed.protocol}. ` +
        "Use http:// or https://."
    );
  }

  return parsed.toString().replace(/\/+$/, "");
}

function toDoxveltGenerationError(
  request: DoxveltGenerationRequest,
  error: unknown
): DoxveltGenerationError {
  const config = safeResolveModelConfig(request.model);
  const cause = deepestRelevantCause(error);
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const lines = [
    `AI generation failed for ${request.purpose} actor ${request.actorId} using model ${request.model.id}.`,
    ...fallbackModelConfigLines(request.model, config),
    `Cause: ${causeMessage}`,
    "",
    "For a local OpenAI-compatible endpoint, confirm the server is running and base_url includes the scheme and /v1 path.",
    "Example config: base_url: http://localhost:11434/v1",
    "Example command: ollama serve"
  ];

  if (config?.apiKeyEnv && !config.apiKeyPresent) {
    lines.push(`Note: ${config.apiKeyEnv} is not set; that is fine for local endpoints that do not require a key.`);
  }

  return new DoxveltGenerationError(lines.join("\n"), error);
}

function safeResolveModelConfig(model: AssetRecord): ResolvedModelConfig | null {
  try {
    return resolveModelConfig(model);
  } catch {
    return null;
  }
}

function modelConfigLines(model: AssetRecord, config: ResolvedModelConfig): string[] {
  const lines = [
    `Model file: ${model.path}`,
    `Provider: ${config.provider}`,
    `Model name: ${config.modelName}`
  ];

  if (config.baseURL) lines.push(`Base URL: ${config.baseURL}`);
  if (config.apiKeyEnv) {
    lines.push(`API key env: ${config.apiKeyEnv} (${config.apiKeyPresent ? "set" : "not set"})`);
  }

  return lines;
}

function fallbackModelConfigLines(model: AssetRecord, config: ResolvedModelConfig | null): string[] {
  if (config) return modelConfigLines(model, config);

  return [
    `Model file: ${model.path}`,
    `Provider: ${String(model.metadata.provider ?? "missing")}`,
    `Model name: ${String(model.metadata.model ?? "missing")}`
  ];
}

function deepestRelevantCause(error: unknown): unknown {
  if (RetryError.isInstance(error)) return deepestRelevantCause(error.lastError);
  if (APICallError.isInstance(error) && error.cause) return deepestRelevantCause(error.cause);
  return error;
}

function stringMetadata(model: AssetRecord, key: string): string | undefined {
  const value = model.metadata[key];
  return typeof value === "string" ? value : undefined;
}
