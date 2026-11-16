import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type LocalApiOptions } from "./options.ts";
import { NativeModelHost } from "../agent-runtime/native-host.ts";
import { RuntimeSelectionError } from "../agent-runtime/selection.ts";
import { bundledExecutable } from "./bundled-executables.ts";

export type { LocalApiOptions } from "./options.ts";
type Reply = { status: number; body: unknown; headers: Record<string, string> };
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
export class NativeOperationError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status=status; this.code=code; }
}

export function createLocalApiServer(options: LocalApiOptions = {}) { return new NativeApiServer(options); }

export function nativeApiExecutable(): string {
  if (process.env.DOXVELT_API_EXECUTABLE) return process.env.DOXVELT_API_EXECUTABLE;
  const bundled = bundledExecutable("doxvelt-api");
  if (bundled) return bundled;
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const profile of ["debug", "release"]) {
    const filename = fileURLToPath(new URL(`../../api/target/${profile}/doxvelt-api${suffix}`, import.meta.url));
    if (existsSync(filename)) return filename;
  }
  throw new Error("Build the Rust API with cargo build --manifest-path api/Cargo.toml, or set DOXVELT_API_EXECUTABLE.");
}

/** Hosts application callbacks for Rust. This adapter creates no HTTP listener. */
export class NativeApiServer extends EventEmitter {
  private options: LocalApiOptions;
  private models: NativeModelHost;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private callbacks = new Map<string, AbortController>();
  private nextId = 0;
  private failure: Error | null = null;
  private addressInfo: AddressInfo | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private exited: Promise<void> = Promise.resolve();
  private inflight = new Set<Promise<void>>();
  listening = false;

  constructor(options: LocalApiOptions) {
    super(); this.options = options; this.models = new NativeModelHost(options);
    // Contract-test seam: the exact native request path also serves real HTTP.
    this.on("request", (request: IncomingMessage, response: ServerResponse) => {
      const task = this.inject(request, response);
      this.inflight.add(task);
      void task.finally(() => this.inflight.delete(task));
    });
  }
  private start(): void {
    if (this.child || this.closed) return;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      /^(path|systemroot|windir|temp|tmp|lang|lc_all|tz)$/i.test(name)));
    const child = spawn(nativeApiExecutable(), ["--stdio"], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let diagnostics = "";
    child.stderr.on("data", data => { diagnostics = (diagnostics + String(data)).slice(-2000); });
    child.once("error", error => this.fail(error));
    child.stdin.on("error", error => this.fail(error));
    this.exited = new Promise(resolve => child.once("close", code => {
      if (!this.closed) this.fail(new Error(diagnostics.trim() || `Native API stopped (${code}).`));
      resolve();
    }));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.once("close", () => lines.close());
    lines.on("line", line => {
      let message: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid envelope.");
        message = value as Record<string, unknown>;
      }
      catch { this.fail(new Error("Native API returned an invalid protocol envelope.")); child.kill(); return; }
      if (typeof message.cancelCall === "string") this.callbacks.get(message.cancelCall)?.abort();
      else if (typeof message.callId === "string") void this.answer(message.callId, message.method, message.params);
      else if (typeof message.id === "number") {
        const request = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) request?.reject(new Error((message.error as { message: string }).message));
        else request?.resolve(message.result);
      }
      else if (message.error) {
        this.fail(new Error("Native API rejected a protocol envelope."));
        child.kill();
      }
    });
  }
  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    for (const callback of this.callbacks.values()) callback.abort(error);
    this.models.close();
  }
  private send(message: unknown): void {
    if (this.failure || !this.child || this.child.stdin.destroyed || this.child.stdin.writableEnded) throw this.failure ?? new Error("Native API is closed.");
    const serialized = JSON.stringify(message, (key: string, value: unknown) => {
      if (!key.isWellFormed() || (typeof value === "string" && !value.isWellFormed()))
        throw new Error("Native API input must contain well-formed Unicode text.");
      return value;
    });
    this.child.stdin.write(serialized + "\n");
  }
  private async answer(id: string, method: unknown, params: unknown): Promise<void> {
    const controller = new AbortController(); this.callbacks.set(id, controller);
    try {
      if (!params || typeof params !== "object") throw new Error("Unknown native callback.");
      let result = typeof method === "string" && method.startsWith("model.")
        ? await this.models.call(method, params as Record<string, unknown>, controller.signal)
        : method === "host.features"
          ? { sceneHeadingsDatabase: this.options.sceneHeadings?.nativeDatabase ?? null, episodeMemory: this.options.episodeMemory?.nativeConfiguration ?? null }
        : method === "memory.reflect" && this.options.episodeMemory && (params as Record<string, unknown>).modelKey === this.options.episodeMemory.nativeConfiguration.modelKey
          ? await this.options.episodeMemory.reflectForNative((params as { request: import("../memory/reverie.ts").ReflectionRequest }).request, controller.signal)
        : method === "cli.generate" && this.options.cliGeneration
          ? await this.options.cliGeneration(params as Record<string,unknown>,controller.signal)
        : (() => { throw new Error("Unknown native callback."); })();
      if (method === "model.describe") result = { ...(result as Record<string, unknown>), memoryEnabled: Boolean(this.options.episodeMemory) };
      if (method === "model.status") result = { ...(result as Record<string, unknown>), diagnostic: this.options.runtimeDiagnostic?.() ?? null };
      if (!this.failure && !this.closed) this.send({ callId: id, result });
    } catch (error) {
      if (!controller.signal.aborted && !this.failure) {
        const model = typeof method === "string" && (method.startsWith("model.") || method === "memory.reflect" || method === "cli.generate");
        try { this.send({ callId: id, error: { status: error instanceof RuntimeSelectionError ? 409 : 503,
          message: model && !(error instanceof RuntimeSelectionError) ? "Model service failed." : error instanceof Error ? error.message : "Application callback failed." } }); }
        catch { /* Process failure already rejects callers. */ }
      }
    } finally { this.callbacks.delete(id); }
  }
  private async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new Error("Native API is closed.");
    this.start();
    if (this.failure) throw this.failure;
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      try { this.send({ id, method, params: { ...params, ...(this.options.dbPath ? { database: this.options.dbPath } : {}), ...(this.options.allowedOrigins ? { allowedOrigins: this.options.allowedOrigins } : {}) } }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  listen(port = 0, host = "127.0.0.1", callback?: () => void): this {
    void this.request<{ protocol: number }>("ping").then(hello => {
      if (hello.protocol !== 1) throw new Error("Doxvelt requires native API protocol 1.");
      return this.request<AddressInfo>("listen", { port, host });
    }).then(address => {
      this.addressInfo = address; this.listening = true; this.emit("listening"); callback?.();
    }).catch(error => this.emit("error", error));
    return this;
  }
  async workspace<T>(directory: string, action: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
    return this.operation<T>("workspace",{directory,action,body},signal);
  }
  async cli(arguments_:string[],signal?:AbortSignal):Promise<unknown>{return this.operation("cli",{arguments:arguments_},signal);}
  async episode<T>(action: string, query: unknown, fields: Record<string,unknown> = {}, signal?: AbortSignal): Promise<T> {
    return this.operation<T>("episode",{action,query,...fields},signal);
  }
  private async operation<T>(method: string, params: Record<string,unknown>, signal?:AbortSignal):Promise<T> {
    signal?.throwIfAborted();
    const abort=()=>{void this.request("abort").catch(()=>{});};
    signal?.addEventListener("abort",abort,{once:true});
    try {
      const reply=await this.request<Reply>(method,params);
      signal?.throwIfAborted();
      if(reply.status!==200){const error=reply.body as {error?:string;code?:string};throw new NativeOperationError(reply.status,error.code??"workspace-operation-failed",error.error??"Workspace operation failed.");}
      return reply.body as T;
    } finally {signal?.removeEventListener("abort",abort);}
  }
  address(): AddressInfo | null { return this.addressInfo; }
  private async inject(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(bytes); size += bytes.length; if (size > 1_000_000) break;
      }
      const headers = Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const result = await this.request<Reply>("request", { method: request.method || "GET", target: request.url || "/", headers, body: Buffer.concat(chunks).toString("utf8") });
      for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
      response.writeHead(result.status, { "content-type": "application/json; charset=utf-8" });
      response.end(result.status === 204 ? undefined : JSON.stringify(result.body));
    } catch (error) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Native API unavailable." }));
    }
  }
  closeIdleConnections(): void { /* Rust owns HTTP connection lifetimes. */ }
  closeAllConnections(): void {
    if (this.child && !this.closed) void this.request("abort").catch(() => {});
  }
  close(callback?: (error?: Error) => void): this {
    this.closing ??= (async () => {
      await Promise.allSettled([...this.inflight]);
      if (this.child && !this.failure) await this.request("close");
      this.closed = true; this.listening = false; this.addressInfo = null; this.child?.stdin.end();
      const watchdog = setTimeout(() => this.child?.kill(), 3000); watchdog.unref();
      try { await this.exited; } finally { clearTimeout(watchdog); this.models.close(); }
      this.emit("close");
    })();
    void this.closing.then(() => callback?.(), error => callback?.(error));
    return this;
  }
}
