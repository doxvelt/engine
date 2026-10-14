export type { NavigationState } from "../../application/simulation-collection.ts";
export type RuntimeStatus = { configured: boolean; provider: string | null; model: string | null };
export type SourceFile = { id: string; name: string; kind: string };

export async function stageSetupRequest<T>(apiBase: string, path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBase.replace(/\/$/, "")}${path}`, {
    method: body ? "POST" : "GET",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result as T;
}

/** Browser storage access itself can throw (denied profile / privacy mode). */
export async function enableBrowserRecovery(session: import("./stage-session.ts").StageSession, browser: Window): Promise<void> {
  try { await session.enableRecovery(browser.localStorage); }
  catch (error) { session.blockRecovery(String(error)); }
}
