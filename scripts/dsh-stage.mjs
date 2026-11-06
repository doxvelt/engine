import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const { values } = parseArgs({ options: {
  dsh: { type: "string" },
  reverie: { type: "string" },
  models: { type: "string" },
  data: { type: "string", default: ".doxvelt/stage" },
  "no-open": { type: "boolean" },
  help: { type: "boolean" },
} });
const usage = "node scripts/dsh-stage.mjs --dsh <DSH CLI bin.js> --reverie <native executable> --models <config.json> [--data <directory>] [--no-open]";
if (values.help) {
  console.log(usage);
} else {
  if (!values.dsh || !values.reverie || !values.models) throw new Error(usage);
  await launch(values);
}

async function launch(config) {
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const { generateText } = await import("ai");
  const { createLocalOpenAICompatibleRuntime, normalizeLocalOpenAICompatibleBaseUrl } =
    await import("../src/agent-runtime/local-openai-compatible.ts");
  const { createLocalApiServer } = await import("../src/local-api/server.ts");
  const { EpisodeMemory } = await import("../src/memory/episodes.ts");
  const models = JSON.parse(await readFile(config.models, "utf8"));
  const defaultRoute = models.defaultActor ? resolveRoute(models.defaultActor, "defaultActor") : undefined;
  const actors = new Map(Object.entries(models.actors ?? {}).map(([id, route]) =>
    [id, createLocalOpenAICompatibleRuntime(resolveRoute(route, "actors." + id))]));
  if (!defaultRoute && !actors.size) throw new Error("Configure defaultActor or at least one actor model.");
  const reflection = models.reflection ? resolveRoute(models.reflection, "reflection") : defaultRoute;
  if (!reflection) throw new Error("Configure the reflection model when defaultActor is absent.");
  const reflectionModel = createOpenAICompatible({
    name: "doxvelt-reflection",
    baseURL: normalizeLocalOpenAICompatibleBaseUrl(reflection.baseUrl),
    ...(reflection.apiKey ? { apiKey: reflection.apiKey } : {}),
  }).chatModel(reflection.modelId);

  const root = path.resolve(config.data);
  const workspace = path.join(root, "stage");
  const overlay = path.join(root, "dsh-overlay.json");
  const plugin = fileURLToPath(new URL("./dsh-gui-spike/host.mjs", import.meta.url));
  await mkdir(workspace, { recursive: true });
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: "doxvelt-stage", name: plugin }] }]));
  const memory = new EpisodeMemory({
    directory: path.join(root, "memory"), executable: path.resolve(config.reverie), modelKey: reflection.modelId,
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
    dbPath: path.join(root, "doxvelt.sqlite"), episodeMemory: memory,
    ...(defaultRoute ? { actorTurnRuntime: createLocalOpenAICompatibleRuntime(defaultRoute) } : {}),
    actorTurnRuntimes: actors,
  });
  try {
    engine.listen(0, "127.0.0.1");
    await once(engine, "listening");
    const origin = "http://127.0.0.1:" + engine.address().port;
    const seeded = await fetch(origin + "/examples/last-crossing/play", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    if (!seeded.ok) throw new Error("Could not open The Last Crossing in Doxvelt.");
    await seeded.arrayBuffer();

    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(path|systemroot|comspec|pathext|temp|tmp|windir|localappdata|userprofile|lang|lc_all|tz)$/i.test(key)));
    const child = spawn(process.execPath, [path.resolve(config.dsh), "web", "--patch", overlay, "--port", "0",
      ...(config["no-open"] ? ["--no-open"] : [])], {
      cwd: workspace, windowsHide: true, stdio: "inherit",
      env: { ...inherited, DSH_HOME: path.join(root, "dsh-home"),
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
