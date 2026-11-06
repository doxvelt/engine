import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { resolveStartup } from "../src/local-api/startup.ts";
import { assertPortsAvailable, supervise, uiEnvironment, watchStartup } from "./dev-processes.ts";

try {
  const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
  const config = resolveStartup(args);
  const apiHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  const apiBase = `http://${isIP(apiHost) === 6 ? `[${apiHost}]` : apiHost}:${config.port}`;
  await assertPortsAvailable([{ host: config.host, port: config.port }, { host: "127.0.0.1", port: config.uiPort }]);
  const origins = [`http://127.0.0.1:${config.uiPort}`, `http://localhost:${config.uiPort}`];
  const options = { detached: process.platform !== "win32", stdio: "inherit" };
  const api = spawn("node", ["src/local-api/index.ts", ...args, ...origins.flatMap(origin => ["--origin", origin])], options);
  const ui = spawn("node", ["node_modules/@nuxt/cli/bin/nuxi.mjs", "dev", "src/local-ui", "--host", "127.0.0.1", "--port", String(config.uiPort), "--dotenv", fileURLToPath(new URL("./empty.env", import.meta.url)), "--no-fork"], { ...options, env: uiEnvironment(process.env, apiBase) });
  console.log(`Open Doxvelt at http://127.0.0.1:${config.uiPort} once startup completes. Manual play is available.`);
  console.log(`Optional AI configuration: ${config.configPath} (edit privately, then restart; values are never displayed).`);
  console.log(`Doxvelt dev child PIDs: API ${api.pid}, UI ${ui.pid}`);
  const startup = new AbortController();
  const failed = new AbortController();
  const ready = watchStartup([`${apiBase}/runtime`, `http://127.0.0.1:${config.uiPort}/`], startup.signal).catch(error => {
    console.error(error.message);
    failed.abort();
  });
  try { process.exitCode = await supervise([api, ui], 1500, failed.signal); }
  finally { startup.abort(); await ready; }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Startup failed.");
  process.exitCode = 1;
}
