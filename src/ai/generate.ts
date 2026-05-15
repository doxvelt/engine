import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
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
