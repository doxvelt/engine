#!/usr/bin/env node
import { createLocalApiServer } from "./server.ts";

const args = process.argv.slice(2);
const host = optionValue(args, "--host") || "127.0.0.1";
const port = Number(optionValue(args, "--port") || "8787");
const dbPath = optionValue(args, "--db") || ".doxvelt/runtime.sqlite";
const allowedOrigins = optionValues(args, "--origin")
  .flatMap((value) => value.split(","))
  .map((value) => value.trim())
  .filter(Boolean);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("--port must be an integer from 1 to 65535.");
  process.exit(1);
}

const server = createLocalApiServer({
  dbPath,
  ...(allowedOrigins.length ? { allowedOrigins } : {}),
});
server.listen(port, host, () => {
  console.log(`Doxvelt local API listening at http://${host}:${port}`);
  console.log(`db: ${dbPath}`);
});

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
