import { readWorldSource } from "./source.ts";
import type { AssetRecord, SourceFile } from "./types.ts";

export async function loadModelRecord(sourceRoot: string, modelId: string): Promise<AssetRecord | null> {
  const source = await readWorldSource(sourceRoot);
  const model = source.models.find((candidate) => candidate.id === modelId);
  return model ? toModelRecord(model) : null;
}

function toModelRecord(model: SourceFile): AssetRecord {
  return {
    id: model.id,
    kind: "model",
    name: stringValue(model.data.name) || model.id,
    path: model.path,
    metadata: model.data,
    body: model.body
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
