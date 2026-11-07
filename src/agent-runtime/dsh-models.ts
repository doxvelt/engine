import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as DshProviders from "@deepseek-ai/dsh-llm-pi-ai";
import type { LocalOpenAICompatibleRuntimeConfig } from "./local-openai-compatible.ts";

/** Profiles contain credential references. Values stay in the launch environment. */
export function dshProviderConfiguration(routes: Readonly<Record<string, LocalOpenAICompatibleRuntimeConfig>>) {
  const environment = new Map<string, string>();
  const providers: Record<string, DshProviders.PiAiProviderProfile> = {};
  for (const [provider, route] of Object.entries(routes)) {
    const ref = "DOXVELT_MODEL_KEY_" + environment.size;
    environment.set(ref, route.apiKey || "doxvelt-local-keyless");
    providers[provider] = {
      api: "openai-completions", baseURL: route.baseUrl, apiKeyEnv: ref,
      models: [{ id: route.modelId,
        ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
        ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
        ...(route.reasoning ? { reasoningEfforts: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" } } : {}),
      }],
      reasoning: route.thinkingLevel ?? "off",
      ...(route.transport === undefined ? {} : { transport: route.transport }),
      retryPolicy: { mode: "normal", maxRetries: 0 },
    };
  }
  return { providers, environment };
}

/** The headless API uses the same DSH service as the graphical host. */
export async function createDshModelService(routes: Readonly<Record<string, LocalOpenAICompatibleRuntimeConfig>>) {
  const { providers, environment } = dshProviderConfiguration(routes);
  const ctx = new Context();
  ctx.provide("launchEnvironment", {
    get: (name: string) => environment.has(name) ? { value: environment.get(name)!, source: "process" as const } : undefined,
    getFrom: (name: string, sources: readonly string[]) => sources.includes("process") && environment.has(name)
      ? { value: environment.get(name)!, source: "process" as const } : undefined,
  });
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(DshProviders, { providers });
  return ctx.llm;
}
