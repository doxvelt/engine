#!/usr/bin/env node
import {
  createLocalOpenAICompatibleRuntime,
} from "../agent-runtime/local-openai-compatible.ts";
import { createLocalApiServer } from "./server.ts";

const args = process.argv.slice(2);
const host = optionValue(args, "--host") || "127.0.0.1";
const port = Number(optionValue(args, "--port") || "8787");
const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
const allowedOrigins = optionValues(args, "--origin")
  .flatMap((value) => value.split(","))
  .map((value) => value.trim())
  .filter(Boolean);
const runtimeBaseUrl = singletonOption(args, "--runtime-base-url");
const runtimeModel = singletonOption(args, "--runtime-model");
const hasRuntimeSizingFlags = [
  "--runtime-context-window",
  "--runtime-max-tokens",
].some((flag) => args.includes(flag));

if (!Number.isInteger(port) || port <= 0 || port > 65535)
  fail("--port must be an integer from 1 to 65535.");
if (Boolean(runtimeBaseUrl) !== Boolean(runtimeModel))
  fail("--runtime-base-url and --runtime-model must be supplied together.");
if (hasRuntimeSizingFlags && !(runtimeBaseUrl && runtimeModel))
  fail("Runtime sizing flags require --runtime-base-url and --runtime-model.");

const actorTurnRuntime =
  runtimeBaseUrl && runtimeModel
    ? configuredRuntime(runtimeBaseUrl, runtimeModel)
    : undefined;
const server = createLocalApiServer({
  dbPath,
  ...(allowedOrigins.length ? { allowedOrigins } : {}),
  ...(actorTurnRuntime ? { actorTurnRuntime } : {}),
});
server.listen(port, host, () => {
  console.log(`Doxvelt local API listening at http://${host}:${port}`);
  console.log(`db: ${dbPath}`);
  console.log(
    actorTurnRuntime
      ? "runtime: local-character/v1 configured"
      : "runtime: not configured",
  );
});

function configuredRuntime(baseUrl: string, modelId: string) {
  const contextWindow = numericOption(
    args,
    "--runtime-context-window",
    "runtime context window",
  );
  const maxTokens = numericOption(args, "--runtime-max-tokens", "runtime max tokens");
  try {
    return createLocalOpenAICompatibleRuntime({
      baseUrl,
      modelId,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(process.env.DOXVELT_RUNTIME_API_KEY
        ? { apiKey: process.env.DOXVELT_RUNTIME_API_KEY }
        : {}),
    });
  } catch (error) {
    fail(error instanceof Error ? `Invalid local runtime configuration: ${error.message}` : "Invalid local runtime configuration.");
  }
}

function singletonOption(values: string[], flag: string): string | undefined {
  const positions = values.flatMap((value, index) => value === flag ? [index] : []);
  if (!positions.length) return undefined;
  if (positions.length !== 1) fail(`${flag} may be supplied only once.`);
  const value = values[positions[0]! + 1];
  if (value === undefined || value.startsWith("--"))
    fail(`${flag} requires a value.`);
  return value;
}

function numericOption(values: string[], flag: string, label: string): number | undefined {
  const positions = values.flatMap((value, index) => value === flag ? [index] : []);
  if (!positions.length) return undefined;
  if (positions.length !== 1) fail(`${flag} may be supplied only once.`);
  const value = values[positions[0]! + 1];
  if (value === undefined || value.startsWith("--"))
    fail(`${flag} requires a value.`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000_000)
    fail(`--${label.replaceAll(" ", "-")} must be an integer from 1 to 1000000.`);
  return parsed;
}

function optionValue(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  if (index === -1) return undefined;
  return values[index + 1];
}

function optionValues(values: string[], flag: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === flag && values[index + 1])
      result.push(values[index + 1]!);
  }
  return result;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
