#!/usr/bin/env node
import { createLocalOpenAICompatibleRuntime } from "../agent-runtime/local-openai-compatible.ts";
import { createLocalApiServer } from "./server.ts";
import { resolveStartup } from "./startup.ts";

try {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const config = resolveStartup(args);
  const actorTurnRuntime = (() => {
    if (!config.runtime) return undefined;
    try { return createLocalOpenAICompatibleRuntime(config.runtime); }
    catch { throw new Error("Cannot initialize the configured runtime. Check endpoint, model and sizing in server configuration."); }
  })();
  const server = createLocalApiServer({
    dbPath: config.dbPath,
    ...(config.allowedOrigins.length ? { allowedOrigins: config.allowedOrigins } : {}),
    ...(actorTurnRuntime ? { actorTurnRuntime, runtimeDiagnostic: actorTurnRuntime.getDiagnostic } : {}),
  });
  server.on("error", () => {
    console.error("API could not listen. Check --host/--port and whether the port is already in use.");
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`Doxvelt local API listening at http://${config.host}:${config.port}`);
    console.log(actorTurnRuntime ? "runtime: configured (connection unverified)" : "runtime: not configured; manual play available");
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid local startup configuration.");
  process.exitCode = 1;
}
