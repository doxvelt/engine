import { compileWorld } from "./compiler.ts";
import { assembleActorContext } from "./context.ts";
import { ensureFirstImpressions } from "./impressions.ts";
import type {
  ActorContext,
  AssetRecord,
  CompiledWorld,
  EntityRecord,
  StageWhisperRecord,
  TranscriptTurn
} from "./types.ts";
import type { RuntimeStore } from "../store/sqlite.ts";

export type StartSimulationResult = {
  simulationId: string;
  scenarioId: string | null;
  compiled: CompiledWorld;
  actors: EntityRecord[];
};

export type TurnTextGenerator = (input: {
  actor: EntityRecord;
  context: ActorContext;
  audience: string[];
}) => Promise<string> | string;

export type AdvanceTurnResult = {
  actor: EntityRecord;
  context: ActorContext;
  turn: TranscriptTurn;
  consumedStageWhispers: StageWhisperRecord[];
};

export async function startSimulation({
  store,
  worldPath,
  simulationId = "default",
  scenarioId = "default"
}: {
  store: RuntimeStore;
  worldPath: string;
  simulationId?: string;
  scenarioId?: string | null;
}): Promise<StartSimulationResult> {
  const compiled = await compileWorld(worldPath);
  assertNoCompilerErrors(compiled);

  store.saveSimulation({
    id: simulationId,
    sourceRoot: compiled.sourceRoot,
    scenarioId,
    compiled
  });

  return {
    simulationId,
    scenarioId,
    compiled,
    actors: compiled.entities.filter((entity) => entity.kind !== "artifact")
  };
}

export function buildActorContext({
  store,
  simulationId = "default",
  actorId,
  observedEntityIds = store.listActiveAudienceIds(simulationId),
  turns = store.listAccessibleTurns(simulationId, actorId),
  stageWhispers = store.listPendingStageWhispers(simulationId, actorId)
}: {
  store: RuntimeStore;
  simulationId?: string;
  actorId: string;
  observedEntityIds?: string[];
  turns?: TranscriptTurn[];
  stageWhispers?: StageWhisperRecord[];
}): ActorContext {
  const simulation = store.getSimulation(simulationId);
  if (!simulation) throw new Error(`Simulation not found: ${simulationId}`);

  const actor = store.getCompiledRecord<EntityRecord>(simulationId, "entity", actorId);
  if (!actor) throw new Error(`Actor not found: ${actorId}`);

  ensureFirstImpressions({
    store,
    simulationId,
    observerId: actorId,
    observedEntityIds
  });

  return assembleActorContext({
    simulation,
    actor,
    worlds: store.listCompiledRecords<AssetRecord>(simulationId, "world"),
    scenario: simulation.scenarioId
      ? store.getCompiledRecord<AssetRecord>(simulationId, "scenario", simulation.scenarioId)
      : null,
    formats: store.listCompiledRecords<AssetRecord>(simulationId, "format"),
    beliefs: store.listBeliefHistory(simulationId),
    accessLinks: store.listEffectiveAccessLinks(simulationId),
    surfaces: store.listSurfaces(simulationId),
    longTermMemories: store.listLongTermMemories(simulationId, actorId),
    observedEntityIds,
    currentAudience: [actorId, ...observedEntityIds],
    turns,
    stageWhispers
  });
}

export async function advanceTurn({
  store,
  simulationId = "default",
  actorId,
  manualText,
  generateText,
  whisperText,
  audience
}: {
  store: RuntimeStore;
  simulationId?: string;
  actorId: string;
  manualText?: string | null;
  generateText?: TurnTextGenerator;
  whisperText?: string | null;
  audience?: string[] | null;
}): Promise<AdvanceTurnResult> {
  if (!manualText && !generateText) {
    throw new Error("advanceTurn requires manualText or generateText.");
  }

  const actor = store.getCompiledRecord<EntityRecord>(simulationId, "entity", actorId);
  if (!actor) throw new Error(`Actor not found: ${actorId}`);

  const resolvedAudience = resolveTurnAudience({
    explicitAudience: audience || null,
    actorId,
    activeAudience: store.listActiveAudienceIds(simulationId)
  });

  if (whisperText) {
    store.createStageWhisper({
      simulationId,
      targetActorId: actorId,
      text: whisperText
    });
  }

  const context = buildActorContext({
    store,
    simulationId,
    actorId,
    observedEntityIds: resolvedAudience
  });
  const text = (manualText || (generateText ? await generateText({ actor, context, audience: resolvedAudience }) : null))?.trim();
  if (!text) throw new Error("Turn text is empty.");

  const turn = store.appendTurn({
    simulationId,
    actorId,
    text,
    audience: resolvedAudience
  });
  const consumedStageWhispers = store.listStageWhispers(simulationId).filter((whisper) => {
    return whisper.consumedTurnId === turn.id;
  });

  return {
    actor,
    context,
    turn,
    consumedStageWhispers
  };
}

export function assertNoCompilerErrors(compiled: { diagnostics: Array<{ severity: string; message: string }> }): void {
  const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length === 0) return;

  throw new Error(
    [
      "Cannot start Doxvelt simulation because compilation produced errors.",
      ...errors.map((error) => `- ${error.message}`)
    ].join("\n")
  );
}

function resolveTurnAudience({
  explicitAudience,
  actorId,
  activeAudience
}: {
  explicitAudience: string[] | null;
  actorId: string;
  activeAudience: string[];
}): string[] {
  const audience = explicitAudience || activeAudience;
  return [...new Set([actorId, ...audience])];
}
