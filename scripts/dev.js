import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { nativeApiExecutable } from "../src/local-api/native-server.ts";

const { values } = parseArgs({ args: process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--")), options: {
  dsh: { type: "string" }, reverie: { type: "string" }, data: { type: "string", default: ".doxvelt/development" },
  "no-open": { type: "boolean" }, help: { type: "boolean" },
} });
if (values.help) {
  console.log("bun run dev [--dsh <DSH CLI bin.js>] [--reverie <Reverie executable>] [--data <directory>] [--no-open]");
  console.log("For the normal desktop app, install this checkout using scripts/install-dsh.ps1 and open DSH.");
} else {
  const executable = nativeApiExecutable();
  const root = path.resolve(values.data);
  const cli = path.resolve(values.dsh ?? process.env.DOXVELT_DSH_CLI ?? ".doxvelt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
  const plugin = fileURLToPath(new URL("./dsh-gui-spike/host.mjs", import.meta.url));
  await mkdir(root, { recursive: true });
  const overlay = path.join(root, "doxvelt.json");
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: "doxvelt", name: plugin,
    config: { ...(values.reverie ? { reverie: path.resolve(values.reverie) } : {}) } }] }]));
  const child = spawn(process.execPath, [cli, "web", "--patch", overlay, "--port", "0", ...(values["no-open"] ? ["--no-open"] : [])], {
    windowsHide: true, stdio: "inherit", env: { ...process.env, DSH_HOME: path.join(root, "dsh-home"), DOXVELT_API_EXECUTABLE: executable },
  });
  const stop = () => child.kill();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  child.once("error", () => { console.error("Cannot start DSH. Supply --dsh with the DSH CLI JavaScript entry point."); process.exitCode = 1; });
  child.once("exit", code => { process.exitCode = code ?? 1; process.off("SIGINT", stop); process.off("SIGTERM", stop); });
}
