import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type ReverieSource = {
  foundation: string;
  messages: readonly { id: string; role: "user" | "assistant"; text: string }[];
};
export type ReflectionRequest = { system: string; input: unknown; maxTokens: number };
export type ReverieOptions = {
  executable: string;
  database: string;
  characterId: string;
  signal?: AbortSignal;
  readSource?: (episodeId: string, signal: AbortSignal) => Promise<ReverieSource>;
  reflect?: (request: ReflectionRequest, modelKey: string, signal: AbortSignal) => Promise<string>;
};

type StoredMemory = {
  gist: string;
  detail: string;
  feeling: string;
  sourceMessageIds: string[];
};
type Impression = { text: string; sourceEpisodeIds: string[] };
type ReverieMethods = {
  ping: { protocol: number; characterId: string };
  when: { id: string; start: number; now: number };
  memorize: { status: "current" | "published"; reflected: number };
  inspect: { episodes: { episode: { id: string }; contribution: {
    stateHash: string; memories: StoredMemory[]; impressions: Impression[];
  } | null }[] };
  retrieve: { text: string; memories: (StoredMemory & { episodeId: string })[]; impressions: Impression[] };
};
type ReveriePort = {
  request<K extends keyof ReverieMethods>(method: K, params?: Record<string, unknown>): Promise<ReverieMethods[K]>;
};
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

class ReverieError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A protocol-1 process serves one character for one Doxvelt operation. */
export async function withReverie<T>(options: ReverieOptions, run: (port: ReveriePort) => Promise<T>): Promise<T> {
  options.signal?.throwIfAborted();
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(path|systemroot|windir|temp|tmp|lang|lc_all|tz)$/i.test(name)));
  const child = spawn(options.executable, [
    "--stdio", "--character", options.characterId, "--database", options.database,
  ], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map<number, Pending>();
  const callbacks = new Map<string, AbortController>();
  let nextId = 0;
  let failure: unknown;
  let diagnostics = "";
  const exited = new Promise<void>(resolve => child.once("close", (code) => {
    stop(new ReverieError("PROCESS_EXITED", diagnostics.trim() || "Reverie stopped (" + code + ")."));
    resolve();
  }));
  child.stderr.on("data", data => { diagnostics = (diagnostics + String(data)).slice(-1000); });
  child.once("error", error => stop(error));
  child.stdin.on("error", error => stop(error));

  function stop(error: unknown) {
    failure ??= error;
    for (const call of pending.values()) call.reject(failure);
    pending.clear();
    for (const controller of callbacks.values()) controller.abort(failure);
  }

  const abort = () => {
    stop(options.signal!.reason);
    child.stdin.end();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  function send(message: unknown) {
    if (failure !== undefined || child.stdin.destroyed || child.stdin.writableEnded) throw failure ?? new Error("Reverie connection closed.");
    child.stdin.write(JSON.stringify(message) + "\n");
  }

  async function answer(id: string, method: unknown, params: unknown) {
    const controller = new AbortController();
    callbacks.set(id, controller);
    try {
      if (!record(params) || params.characterId !== options.characterId || typeof params.episodeId !== "string")
        throw new Error("Reverie requested an invalid source identity.");
      let result: unknown;
      if (method === "source.read" && options.readSource) {
        result = await options.readSource(params.episodeId, controller.signal);
      } else if (method === "model.reflect" && options.reflect && record(params.request) &&
          typeof params.request.system === "string" && typeof params.request.maxTokens === "number" &&
          typeof params.modelKey === "string") {
        result = await options.reflect({
          system: params.request.system, input: params.request.input, maxTokens: params.request.maxTokens,
        }, params.modelKey, controller.signal);
      } else throw new Error("This Reverie operation cannot service " + String(method) + ".");
      if (!controller.signal.aborted) send({ callId: id, result });
    } catch (error) {
      if (!controller.signal.aborted && failure === undefined)
        send({ callId: id, error: { code: "DOXVELT_CALLBACK_FAILED", message: error instanceof Error ? error.message : String(error) } });
    } finally {
      callbacks.delete(id);
    }
  }

  lines.on("line", (line: string) => {
    let message: unknown;
    try { message = JSON.parse(line); } catch { /* handled by the envelope check */ }
    if (!record(message)) {
      stop(new ReverieError("INVALID_RESPONSE", "Reverie returned an invalid response."));
      child.stdin.end();
    } else if (typeof message.cancelCall === "string") {
      callbacks.get(message.cancelCall)?.abort();
    } else if (typeof message.callId === "string") {
      void answer(message.callId, message.method, message.params).catch(stop);
    } else if (typeof message.id === "number") {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (record(message.error)) request.reject(new ReverieError(String(message.error.code), String(message.error.message)));
      else request.resolve(message.result);
    }
  });

  function request<K extends keyof ReverieMethods>(method: K, params = {}): Promise<ReverieMethods[K]> {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: value => resolve(value as ReverieMethods[K]), reject });
      try { send({ id, method, params }); } catch (error) { pending.delete(id); reject(error); }
    });
  }

  try {
    const hello = await request("ping");
    if (hello?.protocol !== 1 || hello.characterId !== options.characterId)
      throw new ReverieError("INCOMPATIBLE_PROTOCOL", "Doxvelt requires Reverie native protocol 1.");
    return await run({ request });
  } finally {
    options.signal?.removeEventListener("abort", abort);
    child.stdin.end();
    const watchdog = setTimeout(() => child.kill(), 3000);
    watchdog.unref();
    try { await exited; } finally { clearTimeout(watchdog); lines.close(); }
  }
}
