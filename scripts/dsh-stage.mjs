import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const { values } = parseArgs({ options: {
  dsh: { type: "string" },
  reverie: { type: "string" },
  models: { type: "string" },
  data: { type: "string", default: ".doxvelt/stage" },
  database: { type: "string" },
  story: { type: "string" },
  scenario: { type: "string" },
  "no-open": { type: "boolean" },
  help: { type: "boolean" },
} });
const usage = "node scripts/dsh-stage.mjs --dsh <DSH CLI bin.js> --reverie <native executable> --models <config.json> [--data <directory>] [--database <saved SQLite file>] [--story <source directory> --scenario <id>] [--no-open]";
if (values.help) {
  console.log(usage);
} else {
  if (!values.dsh || !values.reverie || !values.models) throw new Error(usage);
  if (Boolean(values.story) !== Boolean(values.scenario)) throw new Error("Supply --story and --scenario together.");
  await launch(values);
}

async function launch(config) {
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const { generateText } = await import("ai");
  const { createLocalOpenAICompatibleRuntime, normalizeLocalOpenAICompatibleBaseUrl } =
    await import("../src/agent-runtime/local-openai-compatible.ts");
  const { createLocalApiServer } = await import("../src/local-api/server.ts");
  const { EpisodeMemory } = await import("../src/memory/episodes.ts");
  const [dsh, reverie] = await Promise.all([
    existingFile(config.dsh, "DSH CLI"), existingFile(config.reverie, "Reverie executable"),
  ]);
  const models = JSON.parse(await readFile(config.models, "utf8"));
  const defaultRoute = models.defaultActor ? resolveRoute(models.defaultActor, "defaultActor") : undefined;
  const actorConfigurations = Object.entries(models.actors ?? {}).flatMap(([characterId, entry]) => {
    const choices = Array.isArray(entry) ? entry : [entry];
    if (!choices.length) throw new Error("Configure at least one model for " + characterId + ".");
    const configurations = choices.map(choice => {
      const key = choice?.id ?? (Array.isArray(entry) ? null : "default");
      if (typeof key !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(key))
        throw new Error("Actor configurations for " + characterId + " need a short lowercase id.");
      return actorConfiguration(characterId, key, choice?.label, resolveRoute(choice, "actors." + characterId + "." + key));
    });
    if (new Set(configurations.map(configuration => configuration.key)).size !== configurations.length)
      throw new Error("Actor configuration ids must be unique for " + characterId + ".");
    return configurations.sort((left, right) => Number(right.key === 'default') - Number(left.key === 'default'));
  });
  if (defaultRoute) actorConfigurations.push(actorConfiguration(null, "default", models.defaultActor.label, defaultRoute));
  if (!actorConfigurations.length) throw new Error("Configure defaultActor or at least one actor model.");

  function actorConfiguration(characterId, key, label, route) {
    if (label !== undefined && (typeof label !== "string" || !label.trim() || label.trim().length > 80))
      throw new Error("An actor configuration label must be 1 to 80 characters.");
    const runtime = createLocalOpenAICompatibleRuntime(route);
    return {
      characterId, key, label: label?.trim() ?? runtime.identity.modelId ?? key, runtime,
      profile: { id: "actor-" + key, version: hashIdentity(JSON.stringify([
        normalizeLocalOpenAICompatibleBaseUrl(route.baseUrl), route.modelId.trim(),
      ])) },
    };
  }
  const reflection = models.reflection ? resolveRoute(models.reflection, "reflection") : defaultRoute;
  if (!reflection) throw new Error("Configure the reflection model when defaultActor is absent.");
  const reflectionModel = createOpenAICompatible({
    name: "doxvelt-reflection",
    baseURL: normalizeLocalOpenAICompatibleBaseUrl(reflection.baseUrl),
    ...(reflection.apiKey ? { apiKey: reflection.apiKey } : {}),
  }).chatModel(reflection.modelId);

  const root = path.resolve(config.data);
  const defaultDatabase = path.join(root, "doxvelt.sqlite");
  const dbPath = config.database ? await existingFile(config.database, "Doxvelt database") : defaultDatabase;
  const memoryRoot = path.join(root, "memory");
  const memoryDirectory = path.relative(defaultDatabase, dbPath) === "" ? memoryRoot : path.join(memoryRoot, hashIdentity(dbPath));
  const workspace = path.join(root, "stage");
  const overlay = path.join(root, "dsh-overlay.json");
  const plugin = fileURLToPath(new URL("./dsh-gui-spike/host.mjs", import.meta.url));
  await mkdir(workspace, { recursive: true });
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: "doxvelt-stage", name: plugin }] }]));
  const memory = new EpisodeMemory({
    directory: memoryDirectory, executable: reverie, modelKey: reflection.modelId,
    async reflect(request, signal) {
      try {
        const result = await generateText({
          model: reflectionModel, system: request.system, prompt: JSON.stringify(request.input),
          maxOutputTokens: request.maxTokens, maxRetries: 0, abortSignal: signal,
        });
        if (result.finishReason !== "stop" || !result.text.trim())
          throw new Error("Incomplete reflection.");
        return result.text;
      } catch (error) {
        signal.throwIfAborted();
        throw new Error("The reflection model did not return a complete response.", { cause: error });
      }
    },
  });
  const engine = createLocalApiServer({
    dbPath, episodeMemory: memory,
    actorConfigurations,
  });
  try {
    engine.listen(0, "127.0.0.1");
    await once(engine, "listening");
    const origin = "http://127.0.0.1:" + engine.address().port;
    await prepareStory(origin, config);

    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(path|systemroot|comspec|pathext|temp|tmp|windir|localappdata|userprofile|lang|lc_all|tz)$/i.test(key)));
    const child = spawn(process.execPath, [dsh, "web", "--patch", overlay, "--port", "0",
      ...(config["no-open"] ? ["--no-open"] : [])], {
      cwd: workspace, windowsHide: true, stdio: "inherit",
      env: { ...inherited, DSH_HOME: path.join(root, "dsh-home-v2"),
        DOXVELT_STAGE_WORKSPACE: workspace, DOXVELT_STAGE_ENGINE: origin },
    });
    const stop = () => child.kill();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (process.connected) process.once("disconnect", stop);
    try {
      const [code, signal] = await once(child, "close");
      if (code !== 0 && signal === null) process.exitCode = code ?? 1;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      process.removeListener("disconnect", stop);
    }
  } finally {
    if (engine.listening) {
      const closed = once(engine, "close");
      engine.close();
      await closed;
    }
    memory.close();
  }
}

function hashIdentity(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

async function existingFile(file, label) {
  const resolved = await realpath(file).catch(() => null);
  if (!resolved || !(await stat(resolved)).isFile()) throw new Error(label + " file was not found.");
  return resolved;
}

async function prepareStory(origin, config) {
  const list = await fetch(origin + "/simulations");
  if (!list.ok) throw new Error("Could not read the saved Doxvelt stories.");
  const { simulations } = await list.json();
  let endpoint;
  let body = {};
  if (config.story) {
    const workspacePath = await realpath(config.story);
    const scenarioId = config.scenario;
    const simulationId = "story-" + hashIdentity(JSON.stringify([workspacePath, scenarioId]));
    if (simulations.some(story => story.simulationId === simulationId)) return;
    const { compileWorkspace } = await import("../src/core/compiler.ts");
    const compiled = await compileWorkspace(workspacePath);
    if (!compiled.scenarios.some(item => item.id === scenarioId)) throw new Error("The scenario was not found in this story.");
    endpoint = "/simulations/start";
    body = { workspacePath, scenarioId, simulationId, commandId: simulationId + "-start" };
  } else if (!simulations.length && !config.database) {
    endpoint = "/examples/last-crossing/play";
  }
  if (!endpoint) return;
  const response = await fetch(origin + endpoint, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Could not prepare the Doxvelt story.");
}

function resolveRoute(value, label) {
  if (!value || typeof value.baseUrl !== "string" || typeof value.modelId !== "string" || !value.modelId.trim())
    throw new Error(label + " requires baseUrl and modelId.");
  let apiKey;
  if (value.apiKeyEnv !== undefined) {
    if (typeof value.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv))
      throw new Error(label + " has an invalid apiKeyEnv name.");
    apiKey = process.env[value.apiKeyEnv];
    if (!apiKey) throw new Error("Set the model credential environment variable " + value.apiKeyEnv + ".");
  }
  return { baseUrl: value.baseUrl, modelId: value.modelId, ...(apiKey ? { apiKey } : {}) };
}
