#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { compileWorld } from "../core/compiler.js";
import { assembleActorContext } from "../core/context.js";
import { initWorld } from "../core/init.js";
import { openRuntimeStore } from "../store/sqlite.js";

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

    throw new CliError(`Unknown command: ${command}`, 1);
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exit(error.exitCode);
    }

    console.error(error.stack || error.message);
    process.exit(1);
  }
}

async function initCommand(args) {
  const target = args[0] || "world/demo";
  if (existsSync(path.resolve(target))) {
    throw new CliError(`Target already exists: ${target}`, 1);
  }

  const result = await initWorld(target);
  print({ message: "Initialized Doxvelt world source.", root: result.root }, hasFlag(args, "--json"));
}

async function compileCommand(args) {
  const worldPath = args.find((arg) => !arg.startsWith("--")) || "world/demo";
  const compiled = await compileWorld(worldPath);
  print(compiled, hasFlag(args, "--json"));
}

async function startCommand(args) {
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

async function actorsCommand(args) {
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

async function contextCommand(args) {
  const actorId = args.find((arg) => !arg.startsWith("--"));
  if (!actorId) throw new CliError("Usage: doxvelt context <actor-id> [--json]", 1);

  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const store = await openRuntimeStore(dbPath).open();

  try {
    const simulation = store.getSimulation(simulationId);
    if (!simulation) throw new CliError(`Simulation not found: ${simulationId}`, 1);

    const actor = store.getCompiledRecord(simulationId, "entity", actorId);
    if (!actor) throw new CliError(`Actor not found: ${actorId}`, 1);

    const context = assembleActorContext({
      simulation,
      actor,
      worlds: store.listCompiledRecords(simulationId, "world"),
      scenario: simulation.scenarioId
        ? store.getCompiledRecord(simulationId, "scenario", simulation.scenarioId)
        : null,
      formats: store.listCompiledRecords(simulationId, "format"),
      beliefs: store.listBeliefs(simulationId),
      turns: store.listAccessibleTurns(simulationId, actorId)
    });

    print(context, hasFlag(args, "--json"));
  } finally {
    store.close();
  }
}

async function turnCommand(args) {
  const actorId = args.find((arg) => !arg.startsWith("--"));
  if (!actorId) throw new CliError("Usage: doxvelt turn <actor-id> --manual <text>", 1);

  const text = optionValue(args, "--manual");
  if (!text) throw new CliError("Only manual turns are implemented. Use --manual <text>.", 1);

  const simulationId = optionValue(args, "--simulation") || "default";
  const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
  const audience = optionValue(args, "--audience")?.split(",").filter(Boolean) || [actorId];
  const store = await openRuntimeStore(dbPath).open();

  try {
    const turn = store.appendTurn({ simulationId, actorId, text, audience });
    print({ message: "Appended manual turn.", turn }, hasFlag(args, "--json"));
  } finally {
    store.close();
  }
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
`);
}

function print(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (value.message) console.log(value.message);
  if (value.root) console.log(`root: ${value.root}`);
  if (value.dbPath) console.log(`db: ${value.dbPath}`);
  if (value.actors) console.log(`actors: ${value.actors.map((actor) => actor.id || actor).join(", ")}`);
  if (!value.message && !value.root && !value.dbPath && !value.actors) {
    console.log(JSON.stringify(value, null, 2));
  }
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

class CliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

await main();
