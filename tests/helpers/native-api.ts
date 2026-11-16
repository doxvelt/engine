import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { nativeApiExecutable } from "../../src/local-api/native-server.ts";

/** No JS domain callback is provided: any fallback is a test failure. */
export async function nativeRequest(target: string, body: Record<string, unknown> | undefined, database?: string, status = 200,
  callbacks: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>> = {}) {
  const child = spawn(nativeApiExecutable(), ["--stdio"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  const incoming = lines[Symbol.asyncIterator]();
  const timeout = setTimeout(() => child.kill(), 10_000); timeout.unref();
  try {
    child.stdin.write(JSON.stringify({ id: 1, method: "request", params: { method: body === undefined ? "GET" : "POST", target, database,
      headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body) } }) + "\n");
    for await (const line of { [Symbol.asyncIterator]: () => incoming }) {
      const reply = JSON.parse(line);
      if (reply.callId) {
        const callback = callbacks[reply.method];
        assert.ok(callback, `Unexpected JS callback: ${reply.method}; domain operations must run natively`);
        const result = await callback(reply.params);
        child.stdin.write(JSON.stringify({ callId: reply.callId, result }) + "\n");
        continue;
      }
      assert.equal(reply.result.status, status, JSON.stringify(reply));
      return reply.result.body;
    }
    throw new Error("Native API ended before replying.");
  } finally { clearTimeout(timeout); child.stdin.end(); await exit; lines.close(); }
}
