import { constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, linkSync, rmSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { normalizeLocalOpenAICompatibleBaseUrl, type LocalOpenAICompatibleRuntimeConfig } from "../agent-runtime/local-openai-compatible.ts";

const valueFlags = new Set(["--host", "--port", "--db", "--origin", "--runtime-config", "--runtime-base-url", "--runtime-model", "--runtime-context-window", "--runtime-max-tokens", "--ui-port"]);
class PublicationError extends Error {}
const unsupportedLinks = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);
const fields = new Set(["baseUrl", "modelId", "contextWindow", "maxTokens", "apiKey"]);

/** Deployment configuration only. Never pass this result into content or persistence. */
export function resolveStartup(args: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    if (!valueFlags.has(flag)) throw new Error("Unknown startup option. See docs/LOCAL_REFERENCE.md for supported flags.");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a nonempty value.`);
    if (flags.has(flag) && flag !== "--origin") throw new Error(`${flag} may be supplied only once.`);
    flags.set(flag, [...(flags.get(flag) ?? []), value]);
  }
  const get = (flag: string) => flags.get(flag)?.[0];
  const configPath = path.resolve(cwd, get("--runtime-config") ?? ".doxvelt/inference.json");
  const file = readConfig(configPath, flags.has("--runtime-config"));
  const merged: Record<string, unknown> = { ...file };
  for (const [flag, field] of [["--runtime-base-url", "baseUrl"], ["--runtime-model", "modelId"], ["--runtime-context-window", "contextWindow"], ["--runtime-max-tokens", "maxTokens"]] as const) {
    const value = get(flag);
    if (value !== undefined) merged[field] = field === "contextWindow" || field === "maxTokens" ? integer(value, `Runtime ${field}`, 1_000_000) : value;
  }
  if (Object.hasOwn(env, "DOXVELT_RUNTIME_API_KEY")) merged.apiKey = env.DOXVELT_RUNTIME_API_KEY;
  if (typeof merged.apiKey !== "undefined" && (typeof merged.apiKey !== "string" || /[\r\n\x00]/.test(merged.apiKey))) throw new Error("Runtime apiKey must be a string without line breaks or NUL.");
  const runtime = validateProfile(merged);
  const host = get("--host") ?? "127.0.0.1";
  if (!isIP(host) && !/^(?:localhost|[a-zA-Z0-9.-]+)$/.test(host)) throw new Error("Invalid API host.");
  const port = integer(get("--port") ?? "8787", "--port", 65535);
  const uiPort = integer(get("--ui-port") ?? "3000", "--ui-port", 65535);
  if (port === uiPort) throw new Error("API and UI ports must differ.");
  return { configPath, host, port, uiPort, dbPath: get("--db") ?? ".doxvelt/runtime.sqlite", allowedOrigins: (flags.get("--origin") ?? []).flatMap(value => value.split(",")).map(value => value.trim()).filter(Boolean), runtime };
}

function validateProfile(value: Record<string, unknown>): LocalOpenAICompatibleRuntimeConfig | undefined {
  for (const key of ["contextWindow", "maxTokens"] as const) if (value[key] !== undefined) integer(value[key], key, 1_000_000);
  if ((value.maxTokens as number ?? 1024) > (value.contextWindow as number ?? 16384)) throw new Error("Runtime maxTokens must not exceed contextWindow.");
  if ((value.baseUrl === undefined || value.baseUrl === "") && (value.modelId === undefined || value.modelId === "")) return undefined;
  if (typeof value.baseUrl !== "string" || !value.baseUrl || typeof value.modelId !== "string" || !value.modelId.trim()) throw new Error("Runtime baseUrl and modelId are required together. Edit the runtime configuration.");
  normalizeLocalOpenAICompatibleBaseUrl(value.baseUrl);
  if (value.modelId.length > 1024 || /[\x00-\x1f\x7f]/.test(value.modelId)) throw new Error("Runtime modelId must be nonempty text without control characters (up to 1024 characters).");
  return value as LocalOpenAICompatibleRuntimeConfig;
}

function integer(value: unknown, label: string, max: number): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > max) throw new Error(`${label} must be an integer from 1 to ${max}.`);
  return number;
}

function readConfig(file: string, explicit: boolean): Record<string, unknown> {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") {
      // A dangling symlink must remain an error, even where opening it gives ENOENT.
      try {
        lstatSync(file);
        throw new Error("Runtime configuration must be a readable regular file.");
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      try { setupInference(path.dirname(path.dirname(file))); }
      catch (creationError) {
        if (creationError instanceof PublicationError) {
          const code = (creationError.cause as NodeJS.ErrnoException).code;
          if (code === "EEXIST") return readConfig(file, true);
          if (code && unsupportedLinks.has(code)) {
            console.warn("Automatic configuration could not be created; manual play remains available. To configure AI manually, privately create the full skeleton described in docs/LOCAL_REFERENCE.md, then restart.");
            return {};
          }
        }
        throw creationError;
      }
      return readConfig(file, true);
    }
    throw new Error("Cannot read runtime configuration. Check the file exists and is a readable regular file.");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error("Runtime configuration must be a regular JSON file smaller than 64 KiB.");
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw new Error("Runtime configuration permissions must be owner-only. Run chmod 600 on the configuration file.");
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(fd, "utf8")); }
    catch { throw new Error("Invalid runtime configuration JSON. Edit the file; values are intentionally omitted."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Runtime configuration must be a JSON object.");
    const result = parsed as Record<string, unknown>;
    if (Object.keys(result).some(key => !fields.has(key))) throw new Error("Unknown runtime configuration field. Use baseUrl, modelId, contextWindow, maxTokens, apiKey only.");
    for (const key of ["baseUrl", "modelId", "apiKey"]) if (Object.hasOwn(result, key) && typeof result[key] !== "string") throw new Error("Runtime text fields must be strings.");
    // Validate present file independently: CLI overrides must not hide mistakes.
    for (const key of ["contextWindow", "maxTokens"]) if (Object.hasOwn(result, key) && (typeof result[key] !== "number" || !Number.isInteger(result[key]) || (result[key] as number) < 1 || (result[key] as number) > 1_000_000)) throw new Error("Runtime sizing fields must be integer JSON numbers from 1 to 1000000.");
    if (typeof result.apiKey === "string" && /[\r\n\x00]/.test(result.apiKey)) throw new Error("Runtime apiKey must not contain line breaks or NUL.");
    validateProfile(result);
    return result;
  } finally { closeSync(fd); }
}

/** Publish a complete private file exclusively, so concurrent readers never see a partial skeleton. */
export function setupInference(cwd = process.cwd()): void {
  const dir = path.join(cwd, ".doxvelt");
  let temporary: string | undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    temporary = mkdtempSync(path.join(dir, ".inference-"));
    const file = path.join(temporary, "inference.json");
    writeFileSync(file, JSON.stringify({ baseUrl: "", modelId: "", contextWindow: 16384, maxTokens: 1024, apiKey: "" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    try { linkSync(file, path.join(dir, "inference.json")); }
    catch (cause) {
      const message = (cause as NodeJS.ErrnoException).code === "EEXIST"
        ? "Cannot publish runtime configuration: it already exists. Existing content was preserved."
        : "Cannot publish runtime configuration. Existing content was preserved.";
      throw new PublicationError(message, { cause });
    }
  } catch (cause) {
    if (cause instanceof PublicationError) throw cause;
    throw new Error("Cannot create runtime configuration. Existing content was preserved.", { cause });
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
