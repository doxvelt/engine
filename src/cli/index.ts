#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { DoxveltGenerationError, generateDoxveltObject, generateDoxveltText } from "../ai/generate.ts";
import { compileWorld } from "../core/compiler.ts";
import { assembleActorContext } from "../core/context.ts";
import { closeEpisode, type EpisodeClosureGenerator } from "../core/episode.ts";
import { initWorld } from "../core/init.ts";
import { loadModelRecord } from "../core/models.ts";
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
    if (command === "actors") return await actorsCommand(args);
    if (command === "context") return await contextCommand(args);
    if (command === "turn") return await turnCommand(args);
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
  const target = args.find((arg) => !arg.startsWith("--")) || "world/demo";
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
  const worldPath = args.find((arg) => !arg.startsWith("--")) || "world/demo";
  const compiled = await compileWorld(worldPath);
  print(compiled, hasFlag(args, "--json"));
}

async function startCommand(args: string[]): Promise<void> {
  const worldPath = args.find((arg) => !arg.startsWith("--")) || "world/demo";
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
      turns: store.listAccessibleTurns(simulationId, actorId)
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
  const audience = optionValue(args, "--audience")?.split(",").filter(Boolean) || [actorId];
  const store = await openRuntimeStore(dbPath).open();

  try {
    const isAiTurn = hasFlag(args, "--ai");
    const text = hasFlag(args, "--ai")
      ? await generateAiTurnText({ args, actorId, simulationId, store })
      : optionValue(args, "--manual");

    if (!text) {
      throw new CliError("Use --manual <text> or --ai --model <id>.", 1);
    }

    const turn = store.appendTurn({ simulationId, actorId, text, audience });
    print({ message: `Appended ${isAiTurn ? "AI" : "manual"} turn.`, turn }, hasFlag(args, "--json"));
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
  store
}: {
  args: string[];
  actorId: string;
  simulationId: string;
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
    turns: store.listAccessibleTurns(simulationId, actorId)
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
  doxvelt actors [--simulation <id>] [--db <path>] [--json]
  doxvelt context <actor-id> [--simulation <id>] [--db <path>] [--json]
  doxvelt turn <actor-id> --manual <text> [--audience <ids>] [--simulation <id>] [--db <path>] [--json]
  doxvelt turn <actor-id> --ai --model <id> [--audience <ids>] [--simulation <id>] [--db <path>] [--json]
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
