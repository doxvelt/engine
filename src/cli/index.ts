#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { DoxveltGenerationError, generateDoxveltObject, generateDoxveltText } from "../ai/generate.ts";
import { compileWorld } from "../core/compiler.ts";
import { assembleActorContext } from "../core/context.ts";
import { closeEpisode, type EpisodeClosureGenerator } from "../core/episode.ts";
import { initWorld } from "../core/init.ts";
import { loadModelRecord } from "../core/models.ts";
import { exportSimulationPackage, importSimulationPackage } from "../core/portable.ts";
import type { AssetRecord, EntityRecord } from "../core/types.ts";
import { openRuntimeStore, type RuntimeStore } from "../store/sqlite.ts";

async function main() {
  const [command, ...args] = process.argv.slice(2);

  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      printHelp();
      return;
    }

    if (command === "init") return await initCommand(args);
    if (command === "compile") return await compileCommand(args);
    if (command === "start") return await startCommand(args);
    if (command === "export") return await exportCommand(args);
    if (command === "import") return await importCommand(args);
    if (command === "actors") return await actorsCommand(args);
    if (command === "access") return await accessCommand(args);
    if (command === "audience") return await audienceCommand(args);
    if (command === "whisper") return await whisperCommand(args);
    if (command === "context") return await contextCommand(args);
    if (command === "turn") return await turnCommand(args);
    if (command === "transcript") return await transcriptCommand(args);
    if (command === "memories") return await memoriesCommand(args);
    if (command === "beliefs") return await beliefsCommand(args);
    if (command === "close-episode") return await closeEpisodeCommand(args);

    throw new CliError(`Unknown command: ${command}`, 1);
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exit(error.exitCode);
    }

    if (error instanceof DoxveltGenerationError) {
      console.error(error.message);
      process.exit(1);
    }

    const detail = error instanceof Error ? error.stack || error.message : String(error);
    console.error(detail);
    process.exit(1);
  }
}

async function initCommand(args: string[]): Promise<void> {
  const target = args.find((arg) => !arg.startsWith("--")) || "workspaces/demo";
  const template = optionValue(args, "--template") || null;
  if (existsSync(path.resolve(target))) {
    throw new CliError(`Target already exists: ${target}`, 1);
  }

  const result = await initWorld(target, { template });
  print(
    {
      message: template ? `Initialized Doxvelt world source from ${template}.` : "Initialized Doxvelt world scaffold.",
      root: result.root,
      template
    },
    hasFlag(args, "--json")
  );
}

async function compileCommand(args: string[]): Promise<void> {
  const worldPath = args.find((arg) => !arg.startsWith("--")) || "workspaces/demo";
  const compiled = await compileWorld(worldPath);
  print(compiled, hasFlag(args, "--json"));
}

async function startCommand(args: string[]): Promise<void> {
  const worldPath = args.find((arg) => !arg.startsWith("--")) || "workspaces/demo";
  const scenarioId = optionValue(args, "--scenario") || "default";
  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const compiled = await compileWorld(worldPath);
  const store = await openRuntimeStore(dbPath).open();

  try {
    store.saveSimulation({
      id: simulationId,
      sourceRoot: compiled.sourceRoot,
      scenarioId,
      compiled
    });
  } finally {
    store.close();
  }

  print(
    {
      message: "Started Doxvelt simulation.",
      simulationId,
      scenarioId,
      dbPath: path.resolve(dbPath),
      actors: compiled.entities.filter((entity) => entity.kind !== "artifact").map((entity) => entity.id)
    },
    hasFlag(args, "--json")
  );
}

async function exportCommand(args: string[]): Promise<void> {
  const targetDir = args.find((arg) => !arg.startsWith("--"));
  if (!targetDir) throw new CliError("Usage: doxvelt export <target-dir> [--simulation <id>] [--db <path>] [--json]", 1);

  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const result = await exportSimulationPackage({ dbPath, simulationId, targetDir });
  print(
    {
      message: "Exported Doxvelt simulation package.",
      ...result
    },
    hasFlag(args, "--json")
  );
}

async function importCommand(args: string[]): Promise<void> {
  const packageDir = args.find((arg) => !arg.startsWith("--"));
  if (!packageDir) {
    throw new CliError("Usage: doxvelt import <package-dir> --world <target-source-dir> --db <target-db-path> [--json]", 1);
  }

  const targetSourceDir = optionValue(args, "--world");
  const targetDbPath = optionValue(args, "--db");
  if (!targetSourceDir || !targetDbPath) {
    throw new CliError("Use doxvelt import with --world <target-source-dir> and --db <target-db-path>.", 1);
  }

  const result = await importSimulationPackage({
    packageDir,
    targetSourceDir,
    targetDbPath
  });
  print(
    {
      message: "Imported Doxvelt simulation package.",
      ...result
    },
    hasFlag(args, "--json")
  );
}

async function actorsCommand(args: string[]): Promise<void> {
  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const store = await openRuntimeStore(dbPath).open();

  try {
    const actors = store.listActors(simulationId);
    print({ simulationId, actors }, hasFlag(args, "--json"));
  } finally {
    store.close();
  }
}

async function accessCommand(args: string[]): Promise<void> {
  const [action, member, container] = args.filter((arg) => !arg.startsWith("--"));
  if (action !== "grant" && action !== "revoke" && action !== "list") {
    throw new CliError("Usage: doxvelt access (grant|revoke|list) [member-id] [container-id] [--reason <text>] [--json]", 1);
  }

  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const store = await openRuntimeStore(dbPath).open();

  try {
    const simulation = store.getSimulation(simulationId);
    if (!simulation) throw new CliError(`Simulation not found: ${simulationId}`, 1);

    if (action === "list") {
      print(
        {
          simulationId,
          accessEvents: store.listRuntimeAccessEvents(simulationId),
          effectiveAccessLinks: store.listEffectiveAccessLinks(simulationId)
        },
        hasFlag(args, "--json")
      );
      return;
    }

    if (!member || !container) {
      throw new CliError(`Usage: doxvelt access ${action} <member-id> <container-id> [--reason <text>] [--json]`, 1);
    }

    const event = store.appendRuntimeAccessEvent({
      simulationId,
      action,
      member,
      container,
      reason: optionValue(args, "--reason") || null,
      turnId: numericOptionValue(args, "--turn"),
      episodeId: numericOptionValue(args, "--episode")
    });

    print(
      {
        message: `${action === "grant" ? "Granted" : "Revoked"} @${member} member access ${action === "grant" ? "to" : "from"} @${container}.`,
        event,
        effectiveAccessLinks: store.listEffectiveAccessLinks(simulationId)
      },
      hasFlag(args, "--json")
    );
  } finally {
    store.close();
  }
}

async function audienceCommand(args: string[]): Promise<void> {
  const [action, actorId] = args.filter((arg) => !arg.startsWith("--"));
  if (action !== "add" && action !== "remove" && action !== "deactivate" && action !== "reactivate" && action !== "list") {
    throw new CliError("Usage: doxvelt audience (add|remove|deactivate|reactivate|list) [actor-id] [--reason <text>] [--json]", 1);
  }

  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const store = await openRuntimeStore(dbPath).open();

  try {
    const simulation = store.getSimulation(simulationId);
    if (!simulation) throw new CliError(`Simulation not found: ${simulationId}`, 1);

    if (action === "list") {
      print(
        {
          simulationId,
          audienceEvents: store.listAudienceEvents(simulationId),
          audienceMembers: store.listAudienceMembers(simulationId),
          activeAudience: store.listActiveAudienceIds(simulationId)
        },
        hasFlag(args, "--json")
      );
      return;
    }

    if (!actorId) {
      throw new CliError(`Usage: doxvelt audience ${action} <actor-id> [--reason <text>] [--json]`, 1);
    }

    const event = store.appendAudienceEvent({
      simulationId,
      actorId,
      action,
      reason: optionValue(args, "--reason") || null,
      turnId: numericOptionValue(args, "--turn"),
      episodeId: numericOptionValue(args, "--episode")
    });

    print(
      {
        message: `Recorded audience ${action} for @${actorId}.`,
        event,
        audienceMembers: store.listAudienceMembers(simulationId),
        activeAudience: store.listActiveAudienceIds(simulationId)
      },
      hasFlag(args, "--json")
    );
  } finally {
    store.close();
  }
}

async function whisperCommand(args: string[]): Promise<void> {
  const actionOrActor = args.find((arg) => !arg.startsWith("--"));
  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const store = await openRuntimeStore(dbPath).open();

  try {
    const simulation = store.getSimulation(simulationId);
    if (!simulation) throw new CliError(`Simulation not found: ${simulationId}`, 1);

    if (actionOrActor === "list") {
      print(
        {
          simulationId,
          stageWhispers: store.listStageWhispers(simulationId)
        },
        hasFlag(args, "--json")
      );
      return;
    }

    const targetActorId = actionOrActor;
    const text = optionValue(args, "--text");
    if (!targetActorId || !text) {
      throw new CliError("Usage: doxvelt whisper <actor-id> --text <text> [--simulation <id>] [--db <path>] [--json]", 1);
    }

    const whisper = store.createStageWhisper({
      simulationId,
      targetActorId,
      text
    });

    print(
      {
        message: `Stored private stage whisper for @${targetActorId}.`,
        whisper
      },
      hasFlag(args, "--json")
    );
  } finally {
    store.close();
  }
}

async function contextCommand(args: string[]): Promise<void> {
  const actorId = args.find((arg) => !arg.startsWith("--"));
  if (!actorId) throw new CliError("Usage: doxvelt context <actor-id> [--json]", 1);

  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const store = await openRuntimeStore(dbPath).open();

  try {
    const simulation = store.getSimulation(simulationId);
    if (!simulation) throw new CliError(`Simulation not found: ${simulationId}`, 1);

    const actor = store.getCompiledRecord<EntityRecord>(simulationId, "entity", actorId);
    if (!actor) throw new CliError(`Actor not found: ${actorId}`, 1);

    const context = assembleActorContext({
      simulation,
      actor,
      worlds: store.listCompiledRecords<AssetRecord>(simulationId, "world"),
      scenario: simulation.scenarioId
        ? store.getCompiledRecord<AssetRecord>(simulationId, "scenario", simulation.scenarioId)
        : null,
      formats: store.listCompiledRecords<AssetRecord>(simulationId, "format"),
      beliefs: store.listBeliefs(simulationId),
      accessLinks: store.listEffectiveAccessLinks(simulationId),
      surfaces: store.listSurfaces(simulationId),
      observedEntityIds: store.listActiveAudienceIds(simulationId),
      turns: store.listAccessibleTurns(simulationId, actorId),
      stageWhispers: store.listPendingStageWhispers(simulationId, actorId)
    });

    print(context, hasFlag(args, "--json"));
  } finally {
    store.close();
  }
}

async function turnCommand(args: string[]): Promise<void> {
  const actorId = args.find((arg) => !arg.startsWith("--"));
  if (!actorId) throw new CliError("Usage: doxvelt turn <actor-id> (--manual <text> | --ai --model <id>)", 1);

  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const store = await openRuntimeStore(dbPath).open();

  try {
    const audience = resolveTurnAudience({
      explicitAudience: optionValue(args, "--audience"),
      actorId,
      activeAudience: store.listActiveAudienceIds(simulationId)
    });
    const whisperText = optionValue(args, "--whisper");
    if (whisperText) {
      store.createStageWhisper({
        simulationId,
        targetActorId: actorId,
        text: whisperText
      });
    }

    const isAiTurn = hasFlag(args, "--ai");
    const text = hasFlag(args, "--ai")
      ? await generateAiTurnText({ args, actorId, simulationId, audience, store })
      : optionValue(args, "--manual");

    if (!text) {
      throw new CliError("Use --manual <text> or --ai --model <id>.", 1);
    }

    const turn = store.appendTurn({ simulationId, actorId, text, audience });
    const consumedStageWhispers = store.listStageWhispers(simulationId).filter((whisper) => {
      return whisper.consumedTurnId === turn.id;
    });

    print(
      {
        message: `Appended ${isAiTurn ? "AI" : "manual"} turn.`,
        turn,
        consumedStageWhispers
      },
      hasFlag(args, "--json")
    );
  } finally {
    store.close();
  }
}

async function transcriptCommand(args: string[]): Promise<void> {
  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const store = await openRuntimeStore(dbPath).open();

  try {
    const simulation = store.getSimulation(simulationId);
    if (!simulation) throw new CliError(`Simulation not found: ${simulationId}`, 1);
    print({ simulationId, transcript: store.listTranscript(simulationId) }, hasFlag(args, "--json"));
  } finally {
    store.close();
  }
}

async function memoriesCommand(args: string[]): Promise<void> {
  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const store = await openRuntimeStore(dbPath).open();

  try {
    const simulation = store.getSimulation(simulationId);
    if (!simulation) throw new CliError(`Simulation not found: ${simulationId}`, 1);
    print({ simulationId, memories: store.listEpisodeMemories(simulationId) }, hasFlag(args, "--json"));
  } finally {
    store.close();
  }
}

async function beliefsCommand(args: string[]): Promise<void> {
  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const store = await openRuntimeStore(dbPath).open();

  try {
    const simulation = store.getSimulation(simulationId);
    if (!simulation) throw new CliError(`Simulation not found: ${simulationId}`, 1);
    print({ simulationId, beliefs: store.listBeliefHistory(simulationId) }, hasFlag(args, "--json"));
  } finally {
    store.close();
  }
}

async function closeEpisodeCommand(args: string[]): Promise<void> {
  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const label = optionValue(args, "--label") || null;
  const store = await openRuntimeStore(dbPath).open();

  try {
    const simulation = store.getSimulation(simulationId);
    if (!simulation) throw new CliError(`Simulation not found: ${simulationId}`, 1);

    const generator = hasFlag(args, "--ai")
      ? await createAiEpisodeClosureGenerator({ args, simulationId, store })
      : null;
    const closure = generator
      ? await closeEpisode({ store, simulationId, label, generator })
      : await closeEpisode({ store, simulationId, label });
    print({ message: `Closed ${generator ? "AI" : "deterministic"} episode.`, ...closure }, hasFlag(args, "--json"));
  } finally {
    store.close();
  }
}

async function generateAiTurnText({
  args,
  actorId,
  simulationId,
  audience,
  store
}: {
  args: string[];
  actorId: string;
  simulationId: string;
  audience: string[];
  store: RuntimeStore;
}): Promise<string> {
  const modelId = optionValue(args, "--model");
  if (!modelId) throw new CliError("Use --ai with --model <id>.", 1);

  const simulation = store.getSimulation(simulationId);
  if (!simulation) throw new CliError(`Simulation not found: ${simulationId}`, 1);

  const actor = store.getCompiledRecord<EntityRecord>(simulationId, "entity", actorId);
  if (!actor) throw new CliError(`Actor not found: ${actorId}`, 1);

  const model = await loadModelRecord(simulation.sourceRoot, modelId);
  if (!model) throw new CliError(`Model not found: ${modelId}`, 1);

  const context = assembleActorContext({
    simulation,
    actor,
    worlds: store.listCompiledRecords<AssetRecord>(simulationId, "world"),
    scenario: simulation.scenarioId
      ? store.getCompiledRecord<AssetRecord>(simulationId, "scenario", simulation.scenarioId)
      : null,
    formats: store.listCompiledRecords<AssetRecord>(simulationId, "format"),
    beliefs: store.listBeliefs(simulationId),
    accessLinks: store.listEffectiveAccessLinks(simulationId),
    surfaces: store.listSurfaces(simulationId),
    observedEntityIds: audience,
    turns: store.listAccessibleTurns(simulationId, actorId),
    stageWhispers: store.listPendingStageWhispers(simulationId, actorId)
  });

  const result = await generateDoxveltText({
    actorId,
    purpose: "turn",
    model,
    prompt: context.promptPreview
  });

  return result.text;
}

async function createAiEpisodeClosureGenerator({
  args,
  simulationId,
  store
}: {
  args: string[];
  simulationId: string;
  store: RuntimeStore;
}): Promise<EpisodeClosureGenerator> {
  const modelId = optionValue(args, "--model");
  if (!modelId) throw new CliError("Use close-episode --ai with --model <id>.", 1);

  const simulation = store.getSimulation(simulationId);
  if (!simulation) throw new CliError(`Simulation not found: ${simulationId}`, 1);

  const model = await loadModelRecord(simulation.sourceRoot, modelId);
  if (!model) throw new CliError(`Model not found: ${modelId}`, 1);

  return {
    async writeMemory({ actor, context, label }) {
      const prompt = [
        "Write one Doxvelt episode memory for the actor below.",
        "The memory must be subjective: use only the actor's accessible context and transcript.",
        "Write in the actor's own first-person perspective. Include feelings, interpretations, uncertainty, and what now matters to them.",
        "Do not reveal objective truth the actor could not access. Do not list bullet points.",
        label ? `Episode label: ${label}` : "Episode label: unlabeled",
        "",
        context.promptPreview
      ].join("\n");

      const result = await generateDoxveltText({
        actorId: actor.id,
        purpose: "memory",
        model,
        prompt
      });

      return result.text.trim();
    },
    async extractBeliefs({ actor, memory }) {
      const result = await generateDoxveltObject<BeliefExtractionOutput>({
        actorId: actor.id,
        purpose: "belief_extraction",
        model,
        schemaName: "episode_belief_extraction",
        schemaDescription: "Subjective beliefs extracted from one actor-written Doxvelt episode memory.",
        schema: beliefExtractionSchema,
        prompt: [
          "Extract subjective belief candidates from this Doxvelt episode memory.",
          "Only extract beliefs the actor appears to hold after writing the memory.",
          "Use strength values from this exact scale: +3 treats as true, +1 suspects true, 0 neutral, -1 doubts, -3 treats as false.",
          "Write propositionText as a concise claim, preserving @entity handles when present.",
          "Return an empty beliefs array if the memory contains no meaningful belief change.",
          "",
          `Actor: ${actor.name} (${actor.id})`,
          "",
          "# Memory",
          memory.text
        ].join("\n")
      });

      return result.output.beliefs.map((belief) => ({
        strength: belief.strength,
        propositionText: belief.propositionText.trim()
      }));
    }
  };
}

function printHelp() {
  console.log(`Doxvelt engine CLI

Usage:
  doxvelt init [world-path] [--template executive-interviews] [--json]
  doxvelt compile [world-path] [--json]
  doxvelt start [world-path] --scenario <id> [--simulation <id>] [--db <path>] [--json]
  doxvelt export <target-dir> [--simulation <id>] [--db <path>] [--json]
  doxvelt import <package-dir> --world <target-source-dir> --db <target-db-path> [--json]
  doxvelt actors [--simulation <id>] [--db <path>] [--json]
  doxvelt access list [--simulation <id>] [--db <path>] [--json]
  doxvelt access grant <member-id> <container-id> [--reason <text>] [--turn <id>] [--episode <id>] [--simulation <id>] [--db <path>] [--json]
  doxvelt access revoke <member-id> <container-id> [--reason <text>] [--turn <id>] [--episode <id>] [--simulation <id>] [--db <path>] [--json]
  doxvelt audience list [--simulation <id>] [--db <path>] [--json]
  doxvelt audience add <actor-id> [--reason <text>] [--turn <id>] [--episode <id>] [--simulation <id>] [--db <path>] [--json]
  doxvelt audience remove <actor-id> [--reason <text>] [--turn <id>] [--episode <id>] [--simulation <id>] [--db <path>] [--json]
  doxvelt audience deactivate <actor-id> [--reason <text>] [--turn <id>] [--episode <id>] [--simulation <id>] [--db <path>] [--json]
  doxvelt audience reactivate <actor-id> [--reason <text>] [--turn <id>] [--episode <id>] [--simulation <id>] [--db <path>] [--json]
  doxvelt whisper <actor-id> --text <text> [--simulation <id>] [--db <path>] [--json]
  doxvelt whisper list [--simulation <id>] [--db <path>] [--json]
  doxvelt context <actor-id> [--simulation <id>] [--db <path>] [--json]
  doxvelt turn <actor-id> --manual <text> [--whisper <text>] [--audience <ids>] [--simulation <id>] [--db <path>] [--json]
  doxvelt turn <actor-id> --ai --model <id> [--whisper <text>] [--audience <ids>] [--simulation <id>] [--db <path>] [--json]
  doxvelt transcript [--simulation <id>] [--db <path>] [--json]
  doxvelt memories [--simulation <id>] [--db <path>] [--json]
  doxvelt beliefs [--simulation <id>] [--db <path>] [--json]
  doxvelt close-episode [--label <text>] [--simulation <id>] [--db <path>] [--json]
  doxvelt close-episode --ai --model <id> [--label <text>] [--simulation <id>] [--db <path>] [--json]
`);
}

function print(value: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (!isPrintableRecord(value)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (typeof value.message === "string") console.log(value.message);
  if (typeof value.root === "string") console.log(`root: ${value.root}`);
  if (typeof value.dbPath === "string") console.log(`db: ${value.dbPath}`);
  if (Array.isArray(value.actors)) {
    console.log(`actors: ${value.actors.map((actor) => actorLabel(actor)).join(", ")}`);
  }
  if (!value.message && !value.root && !value.dbPath && !value.actors) {
    console.log(JSON.stringify(value, null, 2));
  }
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function numericOptionValue(args: string[], flag: string): number | null {
  const value = optionValue(args, flag);
  if (!value) return null;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliError(`${flag} must be a non-negative integer.`, 1);
  }

  return parsed;
}

function resolveTurnAudience({
  explicitAudience,
  actorId,
  activeAudience
}: {
  explicitAudience: string | undefined;
  actorId: string;
  activeAudience: string[];
}): string[] {
  const audience = explicitAudience?.split(",").filter(Boolean) || activeAudience;
  return [...new Set([actorId, ...audience])];
}

class CliError extends Error {
  exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

function isPrintableRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function actorLabel(actor: unknown): string {
  if (typeof actor === "string") return actor;
  if (typeof actor === "object" && actor !== null && "id" in actor && typeof actor.id === "string") {
    return actor.id;
  }

  return String(actor);
}

type BeliefExtractionOutput = {
  beliefs: Array<{
    strength: -3 | -1 | 0 | 1 | 3;
    propositionText: string;
  }>;
};

const beliefExtractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["beliefs"],
  properties: {
    beliefs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["strength", "propositionText"],
        properties: {
          strength: {
            type: "integer",
            enum: [-3, -1, 0, 1, 3]
          },
          propositionText: {
            type: "string",
            minLength: 1
          }
        }
      }
    }
  }
} as const;

await main();
