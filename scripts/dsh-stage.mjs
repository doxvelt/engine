import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
  const { stageModelConfiguration, existingFile } = await import("./dsh-gui-spike/stage.mjs");
  const [dsh, reverie] = await Promise.all([
    existingFile(config.dsh, "DSH CLI"), existingFile(config.reverie, "Reverie executable"),
  ]);
  const root = path.resolve(config.data);
  const workspace = path.join(root, "stage");
  await mkdir(workspace, { recursive: true });
  const settings = path.join(root, "stage-launch.json");
  const overlay = path.join(root, "dsh-overlay.json");
  const plugin = fileURLToPath(new URL("./dsh-gui-spike/host.mjs", import.meta.url));
  const modelsPath = await realpath(config.models);
  const models = JSON.parse(await readFile(modelsPath, "utf8"));
  const snapshotRoute = route => route && Object.fromEntries(
    ["id", "label", "baseUrl", "modelId", "apiKeyEnv"].filter(key => route[key] !== undefined).map(key => [key, route[key]]));
  const modelSnapshot = {
    ...(models.defaultActor ? { defaultActor: snapshotRoute(models.defaultActor) } : {}),
    ...(models.reflection ? { reflection: snapshotRoute(models.reflection) } : {}),
    actors: Object.fromEntries(Object.entries(models.actors ?? {}).map(([id, entries]) =>
      [id, Array.isArray(entries) ? entries.map(snapshotRoute) : snapshotRoute(entries)])),
  };
  const { dshProviderConfiguration } = await import("../src/agent-runtime/dsh-models.ts");
  const { providers, environment } = dshProviderConfiguration(stageModelConfiguration(models).routes);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|comspec|pathext|temp|tmp|windir|localappdata|userprofile|lang|lc_all|tz)$/i.test(key)));
  for (const entry of [models.defaultActor, models.reflection, ...Object.values(models.actors ?? {}).flat()]) {
    if (!entry?.apiKeyEnv) continue;
    if (typeof entry.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.apiKeyEnv))
      throw new Error("A model has an invalid apiKeyEnv name.");
    if (!process.env[entry.apiKeyEnv]) throw new Error("Set the model credential environment variable " + entry.apiKeyEnv + ".");
    inherited[entry.apiKeyEnv] = process.env[entry.apiKeyEnv];
  }
  for (const [name, value] of environment) inherited[name] = value;
  await writeFile(settings, JSON.stringify({
    ...config, data: root, models: modelSnapshot, reverie,
    ...(config.database ? { database: await existingFile(config.database, "Doxvelt database") } : {}),
    ...(config.story ? { story: await realpath(config.story) } : {}),
  }));
  await writeFile(overlay, JSON.stringify([
    { id: "llm-pi-ai", config: { providers } },
    { insert: [{ id: "doxvelt-stage", name: plugin }] },
  ]));
  const child = spawn(process.execPath, [dsh, "web", "--patch", overlay, "--port", "0",
    ...(config["no-open"] ? ["--no-open"] : [])], {
    cwd: workspace, windowsHide: true, stdio: "inherit",
    env: { ...inherited, DSH_HOME: path.join(root, "dsh-home-v2"),
      DOXVELT_STAGE_WORKSPACE: workspace, DOXVELT_STAGE_CONFIG: settings },
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
}
