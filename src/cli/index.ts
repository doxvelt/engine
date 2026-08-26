#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { generateDoxveltText } from "../ai/generate.ts";
import { resolveCurrentBeliefs } from "../core/beliefs.ts";
import {
  closeBranchEpisode,
  type EpisodeClosureGenerator,
} from "../core/branch-episode.ts";
import {
  assertExpectedBranchHead,
  commitManualTurn,
  commitRuntimeEffects,
  editAcceptedMessage,
  forkBranch,
  inspectActorContext,
  LOCAL_OWNER_SCOPE,
  projectBranch,
  regenerateAcceptedResponse,
  stageWhisper,
  startBranchSimulation,
} from "../core/branch-kernel.ts";
import { compileWorkspace } from "../core/compiler.ts";
import { resolveBeliefAccess } from "../core/context.ts";
import { initWorkspace } from "../core/init.ts";
import { loadModelRecord } from "../core/models.ts";
import {
  exportSimulationPackage,
  importSimulationPackage,
} from "../store/portable.ts";
import type { ActorContext } from "../core/types.ts";
import {
  openBranchStore,
  type SqliteSimulationRepository,
} from "../store/branch-sqlite.ts";

async function main() {
  const [name, ...args] = process.argv.slice(2);
  try {
    if (!name || ["help", "--help", "-h"].includes(name)) return help();
    if (name === "init") return init(args);
    if (name === "compile") return compile(args);
    if (name === "export")
      return print(
        await exportSimulationPackage({
          dbPath: db(args),
          ownerScope: owner(args),
          simulationId: simulation(args),
          targetDir: requiredPositional(args, "target directory"),
        }),
        json(args),
      );
    if (name === "import")
      return print(
        await importSimulationPackage({
          packageDir: requiredPositional(args, "package directory"),
          targetSourceDir: required(args, "--world"),
          targetDbPath: db(args),
        }),
        json(args),
      );
    const commands: Record<
      string,
      (
        args: string[],
        store: SqliteSimulationRepository,
      ) => Promise<unknown> | unknown
    > = {
      start,
      actors,
      access,
      audience,
      whisper,
      context,
      turn,
      draft,
      edit,
      regenerate,
      fork,
      transcript,
      memories,
      beliefs,
      "close-episode": closeEpisode,
    };
    const command = commands[name];
    if (!command) throw new CliError(`Unknown command: ${name}`);
    const store = await openBranchStore(db(args)).open();
    try {
      const result = await command(args, store);
      if (result !== undefined) print(result, json(args));
    } finally {
      store.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function init(args: string[]) {
  const target = positional(args)[0] || "workspaces/demo";
  if (existsSync(path.resolve(target)))
    throw new CliError(`Target already exists: ${target}`);
  print(
    await initWorkspace(target, {
      template: value(args, "--template") || null,
    }),
    json(args),
  );
}
async function compile(args: string[]) {
  print(
    await compileWorkspace(positional(args)[0] || "workspaces/demo"),
    json(args),
  );
}
async function start(args: string[], store: SqliteSimulationRepository) {
  const result = await startBranchSimulation(store, {
    ownerScope: owner(args),
    simulationId: simulation(args),
    workspacePath: positional(args)[0] || "workspaces/demo",
    scenarioId: value(args, "--scenario") || "default",
    branchId: value(args, "--branch") || "main",
    commandId: required(args, "--command"),
  });
  return {
    message: "Started Doxvelt branch simulation.",
    simulationId: result.simulation.id,
    scenarioId: result.simulation.scenarioId,
    branch: result.branch,
    head: result.root.id,
    contentRevisionId: result.contentRevision.id,
    actors: result.compiled.entities
      .filter((item) => item.kind !== "artifact")
      .map((item) => item.id),
  };
}
function actors(args: string[], store: SqliteSimulationRepository) {
  const content = revision(args, store);
  return {
    simulationId: simulation(args),
    actors: content.compiled.entities.filter(
      (item) => item.kind !== "artifact",
    ),
  };
}
function access(args: string[], store: SqliteSimulationRepository) {
  const [action, member, container] = positional(args);
  if (!action || action === "list") {
    const p = projection(args, store);
    return {
      simulationId: simulation(args),
      branch: p.branch,
      accessEvents: p.commits
        .flatMap((item) => item.events)
        .filter((item) => item.type === "access_changed"),
      effectiveAccessLinks: p.accessLinks,
    };
  }
  if ((action !== "grant" && action !== "revoke") || !member || !container)
    throw new CliError(
      "Usage: access (grant|revoke|list) [member] [container]",
    );
  const result = commitRuntimeEffects(store, {
    ...envelope(args),
    payload: {
      accessChanges: [
        { action, member, container, reason: value(args, "--reason") || null },
      ],
    },
  });
  return {
    message: `Recorded access ${action}.`,
    ...result,
    effectiveAccessLinks: projectBranch(store, query(args, store)).accessLinks,
  };
}
function audience(args: string[], store: SqliteSimulationRepository) {
  const [action, actorId] = positional(args);
  if (!action || action === "list") {
    const p = projection(args, store);
    return {
      simulationId: simulation(args),
      branch: p.branch,
      audienceEvents: p.commits
        .flatMap((item) => item.events)
        .filter((item) => item.type === "audience_changed"),
      audienceMembers: p.audience,
      activeAudience: p.audience
        .filter((item) => item.status === "active")
        .map((item) => item.actorId),
    };
  }
  if (
    !(["add", "remove", "deactivate", "reactivate"] as string[]).includes(
      action,
    ) ||
    !actorId
  )
    throw new CliError(
      "Usage: audience (add|remove|deactivate|reactivate|list) [actor]",
    );
  const result = commitRuntimeEffects(store, {
    ...envelope(args),
    payload: {
      audienceChanges: [
        {
          actorId,
          action: action as "add" | "remove" | "deactivate" | "reactivate",
          reason: value(args, "--reason") || null,
        },
      ],
    },
  });
  const p = projectBranch(store, query(args, store));
  return {
    message: `Recorded audience ${action}.`,
    ...result,
    audienceMembers: p.audience,
    activeAudience: p.audience
      .filter((item) => item.status === "active")
      .map((item) => item.actorId),
  };
}
function whisper(args: string[], store: SqliteSimulationRepository) {
  const actorId = positional(args)[0];
  if (actorId === "list") {
    const actor = value(args, "--actor");
    if (!actor) throw new CliError("whisper list requires --actor");
    const e = envelope(args);
    return {
      stageWhispers: store.listPendingStageWhispers(
        e.ownerScope,
        e.simulationId,
        e.branchId,
        e.expectedHead,
        actor,
      ),
    };
  }
  if (!actorId) throw new CliError("whisper requires an actor");
  const e = envelope(args);
  const staged = stageWhisper(store, {
    ...e,
    targetActorId: actorId,
    text: required(args, "--text"),
  });
  return {
    message: `Staged private direction for @${actorId}.`,
    whisper: staged,
  };
}
function context(args: string[], store: SqliteSimulationRepository) {
  const actorId = positional(args)[0];
  if (!actorId) throw new CliError("context requires an actor");
  const q = query(args, store);
  const pending = store.listPendingStageWhispers(
    q.ownerScope,
    q.simulationId,
    q.branchId,
    q.head ||
      store.getBranch(q.ownerScope, q.simulationId, q.branchId)!.headCommitId,
    actorId,
  );
  return inspectActorContext(store, { ...q, actorId, stageWhispers: pending });
}
async function turn(args: string[], store: SqliteSimulationRepository) {
  const actorId = positional(args)[0];
  if (!actorId) throw new CliError("turn requires an actor");
  const e = envelope(args);
  if (flag(args, "--ai"))
    throw new CliError(
      "Model output must be generated with draft and accepted separately with turn --manual.",
    );
  assertExpectedBranchHead(store, e);
  const p = projectBranch(store, {
    ownerScope: e.ownerScope,
    simulationId: e.simulationId,
    branchId: e.branchId,
    head: e.expectedHead,
  });
  const audienceIds =
    parseAudience(value(args, "--audience")) ||
    p.audience
      .filter((item) => item.status === "active")
      .map((item) => item.actorId);
  const pending = store.listPendingStageWhispers(
    e.ownerScope,
    e.simulationId,
    e.branchId,
    e.expectedHead,
    actorId,
  );
  const actorContext = inspectActorContext(store, {
    ownerScope: e.ownerScope,
    simulationId: e.simulationId,
    branchId: e.branchId,
    head: e.expectedHead,
    actorId,
    audience: audienceIds,
    stageWhispers: pending,
  });
  const text = required(args, "--manual");
  const result = commitManualTurn(store, {
    ...e,
    payload: {
      actorId,
      text,
      audience: audienceIds,
      stageWhisper: value(args, "--whisper") || null,
      ...(args.includes("--whisper-ids")
        ? { stageWhisperIds: parseAudience(value(args, "--whisper-ids")) || [] }
        : {}),
    },
  });
  return {
    message: "Committed manual turn.",
    turn: projectBranch(store, query(args, store)).transcript.at(-1),
    commit: result.commit,
    consumedStageWhispers: result.commit.events.filter(
      (item) => item.type === "stage_whisper_consumed",
    ),
  };
}
async function draft(args: string[], store: SqliteSimulationRepository) {
  const actorId = positional(args)[0];
  if (!actorId) throw new CliError("draft requires an actor");
  const ownerScope = owner(args);
  const simulationId = simulation(args);
  const branchId = required(args, "--branch");
  const expectedHead = required(args, "--expected-head");
  assertExpectedBranchHead(store, {
    ownerScope,
    simulationId,
    branchId,
    expectedHead,
  });
  const projection = projectBranch(store, {
    ownerScope,
    simulationId,
    branchId,
    head: expectedHead,
  });
  const audience =
    parseAudience(value(args, "--audience")) ||
    projection.audience
      .filter((item) => item.status === "active")
      .map((item) => item.actorId);
  const stageWhispers = store.listPendingStageWhispers(
    ownerScope,
    simulationId,
    branchId,
    expectedHead,
    actorId,
  );
  const inlineWhisper = value(args, "--whisper");
  if (inlineWhisper)
    stageWhispers.push({
      id: "draft-inline",
      ownerScope,
      simulationId,
      branchId,
      expectedHead,
      commandId: "draft-inline",
      targetActorId: actorId,
      text: inlineWhisper,
      createdAt: new Date().toISOString(),
    });
  const actorContext = inspectActorContext(store, {
    ownerScope,
    simulationId,
    branchId,
    head: expectedHead,
    actorId,
    audience,
    stageWhispers,
  });
  const text = await generateTurn(args, actorId, actorContext);
  return {
    simulationId,
    branchId,
    head: expectedHead,
    actorId,
    modelId: required(args, "--model"),
    text: text.trim(),
    stageWhisperIds: stageWhispers
      .filter((whisper) => whisper.id !== "draft-inline")
      .map((whisper) => String(whisper.id)),
    context: actorContext,
  };
}
function edit(args: string[], store: SqliteSimulationRepository) {
  const actorId = positional(args)[0];
  if (!actorId) throw new CliError("edit requires an actor");
  const e = envelope(args);
  return editAcceptedMessage(store, {
    ownerScope: e.ownerScope,
    simulationId: e.simulationId,
    sourceBranchId: e.branchId,
    expectedHead: e.expectedHead,
    commandId: e.commandId,
    sourceCommitId: required(args, "--source-commit"),
    branchId: required(args, "--new-branch"),
    payload: {
      actorId,
      text: required(args, "--manual"),
      audience: parseAudience(value(args, "--audience")) || [],
    },
  });
}
function regenerate(args: string[], store: SqliteSimulationRepository) {
  const actorId = positional(args)[0];
  if (!actorId) throw new CliError("regenerate requires an actor");
  const e = envelope(args);
  return regenerateAcceptedResponse(store, {
    ownerScope: e.ownerScope,
    simulationId: e.simulationId,
    sourceBranchId: e.branchId,
    expectedHead: e.expectedHead,
    commandId: e.commandId,
    sourceCommitId: required(args, "--source-commit"),
    branchId: required(args, "--new-branch"),
    payload: {
      actorId,
      text: required(args, "--manual"),
      audience: parseAudience(value(args, "--audience")) || [],
    },
  });
}
function fork(args: string[], store: SqliteSimulationRepository) {
  return forkBranch(store, {
    ownerScope: owner(args),
    simulationId: simulation(args),
    sourceBranchId: required(args, "--branch"),
    expectedHead: required(args, "--expected-head"),
    atCommitId: required(args, "--at"),
    branchId: required(args, "--new-branch"),
    commandId: required(args, "--command"),
    name: value(args, "--name") || null,
  });
}
function transcript(args: string[], store: SqliteSimulationRepository) {
  const p = projection(args, store);
  return {
    simulationId: simulation(args),
    branch: p.branch,
    transcript: p.transcript,
  };
}
function memories(args: string[], store: SqliteSimulationRepository) {
  const p = projection(args, store);
  return {
    simulationId: simulation(args),
    branch: p.branch,
    memories: p.episodeMemories,
    longTermMemories: p.longTermMemories,
  };
}
function beliefs(args: string[], store: SqliteSimulationRepository) {
  const actorId = positional(args)[0];
  const p = projection(args, store);
  if (!actorId)
    return {
      simulationId: simulation(args),
      branch: p.branch,
      beliefs: p.beliefs,
    };
  const resolution = resolveCurrentBeliefs(
    resolveBeliefAccess(actorId, p.beliefs, p.accessLinks),
  );
  return {
    simulationId: simulation(args),
    branch: p.branch,
    actorId,
    currentBeliefs: resolution.current,
    conflictingBeliefs: resolution.conflicting,
    supersededBeliefs: resolution.superseded,
    groups: resolution.groups,
  };
}
async function closeEpisode(args: string[], store: SqliteSimulationRepository) {
  const generator = flag(args, "--ai")
    ? await aiClosureGenerator(args, store)
    : undefined;
  const result = await closeBranchEpisode(
    store,
    { ...envelope(args), payload: { label: value(args, "--label") || null } },
    generator,
  );
  return {
    message: `Closed ${generator ? "AI" : "deterministic"} episode.`,
    ...result.closure,
    commit: result.commit,
  };
}

async function generateTurn(
  args: string[],
  actorId: string,
  context: ActorContext,
) {
  const model = await modelFor(args, context.simulation.sourceRoot);
  return (
    await generateDoxveltText({
      actorId,
      purpose: "turn",
      model,
      prompt: context.promptPreview,
    })
  ).text;
}
async function aiClosureGenerator(
  args: string[],
  store: SqliteSimulationRepository,
): Promise<EpisodeClosureGenerator> {
  const sim = store.getSimulation(owner(args), simulation(args));
  if (!sim) throw new CliError("Simulation not found.");
  const model = await modelFor(args, sim.sourceRoot);
  return {
    async writeMemory({ actor, context }) {
      return (
        await generateDoxveltText({
          actorId: actor.id,
          purpose: "memory",
          model,
          prompt: context.promptPreview,
        })
      ).text;
    },
    extractBeliefs({ memory }) {
      return [
        {
          strength: 1,
          propositionText: `@${memory.actorId} treats this episode as meaningful.`,
        },
      ];
    },
  };
}
async function modelFor(args: string[], root: string) {
  const id = required(args, "--model");
  const model = await loadModelRecord(root, id);
  if (!model) throw new CliError(`Model not found: ${id}`);
  return model;
}
function projection(args: string[], store: SqliteSimulationRepository) {
  return projectBranch(store, query(args, store));
}
function query(args: string[], store: SqliteSimulationRepository) {
  const ownerScope = owner(args);
  const simulationId = simulation(args);
  const sim = store.getSimulation(ownerScope, simulationId);
  if (!sim) throw new CliError(`Simulation not found: ${simulationId}`);
  const head = value(args, "--head");
  return {
    ownerScope,
    simulationId,
    branchId: value(args, "--branch") || sim.defaultBranchId,
    ...(head ? { head } : {}),
  };
}
function envelope(args: string[]) {
  return {
    ownerScope: owner(args),
    simulationId: simulation(args),
    branchId: required(args, "--branch"),
    expectedHead: required(args, "--expected-head"),
    commandId: required(args, "--command"),
  };
}
function revision(args: string[], store: SqliteSimulationRepository) {
  const sim = store.getSimulation(owner(args), simulation(args));
  if (!sim) throw new CliError(`Simulation not found: ${simulation(args)}`);
  const content = store.getContentRevision(owner(args), sim.contentRevisionId);
  if (!content) throw new Error("Pinned content revision is missing.");
  return content;
}
function value(args: string[], key: string) {
  const i = args.indexOf(key);
  return i < 0 ? undefined : args[i + 1];
}
function required(args: string[], key: string) {
  const item = value(args, key);
  if (!item) throw new CliError(`${key} is required.`);
  return item;
}
function flag(args: string[], key: string) {
  return args.includes(key);
}
function positional(args: string[]) {
  const result: string[] = [];
  const boolean = new Set(["--json", "--ai"]);
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i]!;
    if (item.startsWith("--")) {
      if (!boolean.has(item)) i += 1;
    } else result.push(item);
  }
  return result;
}
function requiredPositional(args: string[], label: string) {
  const item = positional(args)[0];
  if (!item) throw new CliError(`${label} is required.`);
  return item;
}
function parseAudience(item: string | undefined) {
  return item === undefined
    ? null
    : item
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
}
function db(args: string[]) {
  return value(args, "--db") || ".doxvelt/runtime.sqlite";
}
function owner(args: string[]) {
  return value(args, "--owner") || LOCAL_OWNER_SCOPE;
}
function simulation(args: string[]) {
  return value(args, "--simulation") || "default";
}
function json(args: string[]) {
  return flag(args, "--json");
}
function print(item: unknown, asJson: boolean) {
  console.log(
    asJson
      ? JSON.stringify(item, null, 2)
      : typeof item === "string"
        ? item
        : JSON.stringify(item, null, 2),
  );
}
function help() {
  console.log(
    [
      "Doxvelt branch-aware runtime",
      "Commands: init compile start export import actors access audience whisper context",
      "turn draft edit regenerate fork transcript memories beliefs close-episode",
      "All mutations require --command; branch mutations require --branch and --expected-head.",
      "Turn/draft options: --whisper <text>; turn acceptance also supports --whisper-ids <ids>.",
    ].join("\n"),
  );
}
class CliError extends Error {}
await main();
