import { DEFAULT_ACTOR_PROFILE, type RuntimeProfileRef } from "../core/types.ts";
import type { ActorTurnRuntime } from "./contracts.ts";

export type ActorConfiguration = {
  characterId: string | null;
  key: string;
  label: string;
  profile: RuntimeProfileRef;
  runtime: ActorTurnRuntime;
};
export type RuntimeOptions = {
  actorTurnRuntime?: ActorTurnRuntime;
  actorTurnRuntimes?: ReadonlyMap<string, ActorTurnRuntime>;
  actorConfigurations?: readonly ActorConfiguration[];
};
export class RuntimeSelectionError extends Error {
  readonly status = 409;
}
export function configurationsFor(options: RuntimeOptions, actorId: string) {
  const all = options.actorConfigurations ?? [];
  const specific = all.filter(configuration => configuration.characterId === actorId);
  return specific.length ? specific : all.filter(configuration => configuration.characterId === null);
}
export function actorRuntimeFor(options: RuntimeOptions, actorId: string, requested?: string | RuntimeProfileRef) {
  const available = configurationsFor(options, actorId);
  const recorded = typeof requested === "object" ? requested : undefined;
  const exactProfile = recorded && (recorded.id !== DEFAULT_ACTOR_PROFILE.id || recorded.version !== DEFAULT_ACTOR_PROFILE.version);
  const match = typeof requested === "string" ? available.find(item => item.key === requested)
    : exactProfile ? available.find(item => item.profile.id === recorded.id && item.profile.version === recorded.version)
    : available[0];
  if (!match && (typeof requested === "string" || exactProfile))
    throw new RuntimeSelectionError("That actor configuration is unavailable for this character.");
  return match ?? { runtime: options.actorTurnRuntimes?.get(actorId) ?? options.actorTurnRuntime, profile: DEFAULT_ACTOR_PROFILE };
}
