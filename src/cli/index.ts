#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { generateDoxveltText } from "../ai/generate.ts";
import { compileWorld } from "../core/compiler.ts";
import { assembleActorContext } from "../core/context.ts";
import { closeEpisode } from "../core/episode.ts";
import { initWorld } from "../core/init.ts";
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

    const detail = error instanceof Error ? error.stack || error.message : String(error);
    console.error(detail);
    process.exit(1);
  }
}

async function initCommand(args: string[]): Promise<void> {
  const target = args[0] || "world/demo";
  if (existsSync(path.resolve(target))) {
    throw new CliError(`Target already exists: ${target}`, 1);
  }

  const result = await initWorld(target);
  print({ message: "Initialized Doxvelt world source.", root: result.root }, hasFlag(args, "--json"));
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

    const closure = closeEpisode({ store, simulationId, label });
    print({ message: "Closed episode.", ...closure }, hasFlag(args, "--json"));
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

  const model = store.getCompiledRecord<AssetRecord>(simulationId, "model", modelId);
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

function printHelp() {
  console.log(`Doxvelt engine CLI

Usage:
  doxvelt init [world-path] [--json]
  doxvelt compile [world-path] [--json]
  doxvelt start [world-path] --scenario <id> [--simulation <id>] [--db <path>] [--json]
  doxvelt actors [--simulation <id>] [--db <path>] [--json]
  doxvelt context <actor-id> [--simulation <id>] [--db <path>] [--json]
  doxvelt turn <actor-id> --manual <text> [--audience <ids>] [--simulation <id>] [--db <path>] [--json]
  doxvelt turn <actor-id> --ai --model <id> [--audience <ids>] [--simulation <id>] [--db <path>] [--json]
  doxvelt close-episode [--label <text>] [--simulation <id>] [--db <path>] [--json]
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

await main();
