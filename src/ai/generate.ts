import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, Output } from "ai";
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

export async function generateDoxveltText(
  request: DoxveltGenerationRequest
): Promise<DoxveltGenerationResult> {
  const model = resolveLanguageModel(request.model);

  const result = await generateText({
    model,
    prompt: request.prompt
  });

  return {
    text: result.text,
    raw: result
  };
}

export async function generateDoxveltObject<TOutput>(
  request: DoxveltObjectGenerationRequest<TOutput>
): Promise<DoxveltObjectGenerationResult<TOutput>> {
  const model = resolveLanguageModel(request.model);
  const outputOptions: Parameters<typeof Output.object<TOutput>>[0] = {
    schema: jsonSchema<TOutput>(request.schema)
  };

  if (request.schemaName) outputOptions.name = request.schemaName;
  if (request.schemaDescription) outputOptions.description = request.schemaDescription;

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
}

function resolveLanguageModel(model: AssetRecord): Parameters<typeof generateText>[0]["model"] {
  const provider = stringMetadata(model, "provider");
  const modelName = stringMetadata(model, "model");

  if (!provider) {
    throw new Error(`Model ${model.id} is missing provider metadata.`);
  }

  if (!modelName) {
    throw new Error(`Model ${model.id} is missing model metadata.`);
  }

  if (provider === "openai-compatible") {
    const baseURL = stringMetadata(model, "base_url");
    if (!baseURL) {
      throw new Error(`OpenAI-compatible model ${model.id} is missing base_url metadata.`);
    }

    const apiKeyEnv = stringMetadata(model, "api_key_env");
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
    const compatible = createOpenAICompatible({
      name: model.id,
      baseURL,
      apiKey: apiKey || "not-needed"
    });

    return compatible(modelName);
  }

  if (provider === "gateway") {
    return modelName;
  }

  throw new Error(`Unsupported AI model provider for ${model.id}: ${provider}`);
}

function stringMetadata(model: AssetRecord, key: string): string | undefined {
  const value = model.metadata[key];
  return typeof value === "string" ? value : undefined;
}
