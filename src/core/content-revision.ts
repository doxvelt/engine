import type { CompiledWorkspace, FrontmatterData } from "./types.ts";

const RAW_CREDENTIAL_KEY = /^api[_-]?key$/i;

export function prepareCompiledRevision(
  compiled: CompiledWorkspace,
): CompiledWorkspace {
  return {
    ...structuredClone(compiled),
    sourceRoot: "",
    models: compiled.models.map((model) => ({
      ...structuredClone(model),
      metadata: stripRawCredentials(model.metadata),
    })),
  };
}

function stripRawCredentials(metadata: FrontmatterData): FrontmatterData {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !RAW_CREDENTIAL_KEY.test(key)),
  );
}
