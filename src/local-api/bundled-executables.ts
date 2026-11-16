import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Release bundles place their native dependencies beside the bundled host module. */
export function bundledExecutable(name: "doxvelt-api" | "reverie/reverie-engine"): string | undefined {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const filename = fileURLToPath(new URL(`./native/${process.platform}-${process.arch}/${name}${suffix}`, import.meta.url));
  return existsSync(filename) ? filename : undefined;
}
