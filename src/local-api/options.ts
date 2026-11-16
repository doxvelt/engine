import type { ActorConfiguration } from "../agent-runtime/selection.ts";
import type { ActorTurnRuntime } from "../agent-runtime/contracts.ts";
import type { EpisodeMemory } from "../memory/episodes.ts";

/** Deployment-owned services. Simulation rules and persistence live in Rust. */
export type LocalApiOptions = {
  runtimeDiagnostic?: () => string | null;
  dbPath?: string;
  actorTurnRuntime?: ActorTurnRuntime;
  actorTurnRuntimes?: ReadonlyMap<string, ActorTurnRuntime>;
  actorConfigurations?: readonly ActorConfiguration[];
  episodeMemory?: EpisodeMemory;
  sceneHeadings?: {readonly nativeDatabase:string};
  allowedOrigins?: readonly string[];
  cliGeneration?: (params:Record<string,unknown>,signal:AbortSignal)=>Promise<{text:string}>;
};
