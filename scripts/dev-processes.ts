import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

/** Allowlist prevents Bun dotenv values and runtime secrets reaching Nuxt. */
export function uiEnvironment(source: NodeJS.ProcessEnv, apiBase: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "TERM", "COLORTERM", "LANG", "LC_ALL", "CI", "NO_COLOR"]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  result.DOXVELT_API_BASE = apiBase;
  return result;
}

/** Children own dedicated process groups; no shell wrappers or unrelated PIDs. */
export async function supervise(children: ChildProcess[], graceMs = 1500, signal?: AbortSignal): Promise<number> {
  let stopping: Promise<number> | undefined;
  const exited = children.map(child => new Promise<number>(resolve => {
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  }));
  const killTree = async (child: ChildProcess, force: boolean) => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      await new Promise<void>(resolve => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore" });
        const timer = setTimeout(() => {
          killer.kill();
          child.kill(force ? "SIGKILL" : "SIGTERM");
          resolve();
        }, 1000);
        const done = () => { clearTimeout(timer); resolve(); };
        killer.once("error", () => { child.kill(force ? "SIGKILL" : "SIGTERM"); done(); });
        killer.once("exit", done);
      });
    } else {
      try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(force ? "SIGKILL" : "SIGTERM"); }
    }
  };
  const stop = (code: number) => stopping ??= (async () => {
    await Promise.all(children.map(child => killTree(child, false)));
    // Always wait the grace period: descendants may outlive their leader.
    await new Promise(resolve => setTimeout(resolve, graceMs));
    await Promise.all(children.map(child => killTree(child, true)));
    await Promise.all(exited);
    return code;
  })();
  let trigger!: (code: number) => void;
  const requested = new Promise<number>(resolve => { trigger = resolve; });
  const interrupt = () => trigger(130);
  const terminate = () => trigger(143);
  const abort = () => trigger(1);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await stop(await Promise.race([...exited, requested]));
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    signal?.removeEventListener("abort", abort);
  }
}

/** Nuxt can keep its loader alive after build errors; bound that startup failure. */
export async function watchStartup(urls: string[], signal: AbortSignal, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(urls);
  while (pending.size && !signal.aborted) {
    for (const url of pending) {
      try {
        const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
        await response.body?.cancel();
        if (response.ok) pending.delete(url);
      } catch { /* Wait for the actual API and Nuxt listeners. */ }
    }
    if (Date.now() >= deadline) throw new Error("Dev startup timed out. Check API/UI ports and Nuxt build errors.");
    if (pending.size) await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** Fail before Nuxt can silently choose a fallback port occupied by another app. */
export async function assertPortsAvailable(bindings: readonly { host: string; port: number }[]): Promise<void> {
  const probes = bindings.map(() => createServer());
  try {
    const results = await Promise.allSettled(probes.map((server, index) => new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bindings[index]!.port, bindings[index]!.host, resolve);
    })));
    if (results.some(result => result.status === "rejected"))
      throw new Error("Cannot bind the requested API/UI ports. Check --host, --port, --ui-port and whether another process is listening.");
  } finally {
    await Promise.all(probes.map(server => server.listening ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve()));
  }
}
