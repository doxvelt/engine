import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DoxveltGenerationError, generateDoxveltText } from "../ai/generate.ts";
import { resolveCurrentBeliefs } from "../core/beliefs.ts";
import { compileWorld } from "../core/compiler.ts";
import { resolveBeliefAccess } from "../core/context.ts";
import { advanceTurn, buildActorContext, startSimulation } from "../core/engine.ts";
import { closeEpisode } from "../core/episode.ts";
import { initWorld } from "../core/init.ts";
import { loadModelRecord } from "../core/models.ts";
import { exportSimulationPackage, importSimulationPackage } from "../core/portable.ts";
import type { EntityRecord } from "../core/types.ts";
import { openRuntimeStore, type RuntimeStore } from "../store/sqlite.ts";

const DEFAULT_DB_PATH = ".doxvelt/runtime.sqlite";
const MAX_BODY_BYTES = 1_000_000;

export type LocalApiOptions = {
  dbPath?: string;
};

export function createLocalApiServer(options: LocalApiOptions = {}) {
  return createServer((request, response) => {
    handleLocalApiRequest(request, response, options).catch((error) => {
      sendError(response, error);
    });
  });
}

export async function handleLocalApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: LocalApiOptions = {}
): Promise<void> {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "source" && parts[1] === "init") {
    const body = await readJsonBody(request);
    const worldPath = requireString(body, "worldPath");
    const template = optionalString(body, "template") || null;
    sendJson(response, 200, await initWorld(worldPath, { template }));
    return;
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "source" && parts[1] === "compile") {
    const body = await readJsonBody(request);
    const worldPath = requireString(body, "worldPath");
    sendJson(response, 200, await compileWorld(worldPath));
    return;
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "packages" && parts[1] === "export") {
    const body = await readJsonBody(request);
    const targetDir = requireString(body, "targetDir");
    const simulationId = optionalString(body, "simulationId") || "default";
    sendJson(
      response,
      200,
      await exportSimulationPackage({
        dbPath: options.dbPath || DEFAULT_DB_PATH,
        simulationId,
        targetDir
      })
    );
    return;
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "packages" && parts[1] === "import") {
    const body = await readJsonBody(request);
    const packageDir = requireString(body, "packageDir");
    const targetSourceDir = requireString(body, "targetSourceDir");
    const targetDbPath = optionalString(body, "targetDbPath") || options.dbPath || DEFAULT_DB_PATH;
    sendJson(
      response,
      200,
      await importSimulationPackage({
        packageDir,
        targetSourceDir,
        targetDbPath
      })
    );
    return;
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "simulations" && parts[1] === "start") {
    const body = await readJsonBody(request);
    const worldPath = requireString(body, "worldPath");
    const simulationId = optionalString(body, "simulationId") || "default";
    const scenarioId = optionalString(body, "scenarioId") || "default";

    await withStore(options, async (store) => {
      const result = await startSimulation({
        store,
        worldPath,
        simulationId,
        scenarioId
      });

      sendJson(response, 200, {
        simulationId: result.simulationId,
        scenarioId: result.scenarioId,
        actors: result.actors,
        diagnostics: result.compiled.diagnostics
      });
    });
    return;
  }

  if (parts.length >= 2 && parts[0] === "simulations") {
    const simulationId = parts[1];
    if (!simulationId) throw new HttpError(404, "Simulation id is missing.");

    if (method === "GET" && parts.length === 3 && parts[2] === "actors") {
      await withStore(options, async (store) => {
        ensureSimulation(store, simulationId);
        sendJson(response, 200, {
          simulationId,
          actors: store.listActors(simulationId)
        });
      });
      return;
    }

    if (method === "GET" && parts.length === 4 && parts[2] === "context") {
      const actorId = parts[3];
      if (!actorId) throw new HttpError(404, "Actor id is missing.");

      await withStore(options, async (store) => {
        ensureSimulation(store, simulationId);
        sendJson(response, 200, buildActorContext({ store, simulationId, actorId }));
      });
      return;
    }

    if (method === "GET" && parts.length === 3 && parts[2] === "transcript") {
      await withStore(options, async (store) => {
        ensureSimulation(store, simulationId);
        sendJson(response, 200, {
          simulationId,
          transcript: store.listTranscript(simulationId)
        });
      });
      return;
    }

    if (method === "GET" && parts.length === 3 && parts[2] === "audience") {
      await withStore(options, async (store) => {
        ensureSimulation(store, simulationId);
        sendJson(response, 200, {
          simulationId,
          audienceEvents: store.listAudienceEvents(simulationId),
          audienceMembers: store.listAudienceMembers(simulationId),
          activeAudience: store.listActiveAudienceIds(simulationId)
        });
      });
      return;
    }

    if (method === "POST" && parts.length === 3 && parts[2] === "audience") {
      const body = await readJsonBody(request);
      const actorId = requireString(body, "actorId");
      const action = requireAudienceAction(body, "action");

      await withStore(options, async (store) => {
        ensureSimulation(store, simulationId);
        const event = store.appendAudienceEvent({
          simulationId,
          actorId,
          action,
          reason: optionalString(body, "reason") || null,
          turnId: optionalNonNegativeInteger(body, "turnId"),
          episodeId: optionalNonNegativeInteger(body, "episodeId")
        });
        sendJson(response, 200, {
          simulationId,
          event,
          audienceMembers: store.listAudienceMembers(simulationId),
          activeAudience: store.listActiveAudienceIds(simulationId)
        });
      });
      return;
    }

    if (method === "GET" && parts.length === 3 && parts[2] === "access") {
      await withStore(options, async (store) => {
        ensureSimulation(store, simulationId);
        sendJson(response, 200, {
          simulationId,
          accessEvents: store.listRuntimeAccessEvents(simulationId),
          effectiveAccessLinks: store.listEffectiveAccessLinks(simulationId)
        });
      });
      return;
    }

    if (method === "POST" && parts.length === 3 && parts[2] === "access") {
      const body = await readJsonBody(request);
      const action = requireAccessAction(body, "action");
      const member = requireString(body, "member");
      const container = requireString(body, "container");

      await withStore(options, async (store) => {
        ensureSimulation(store, simulationId);
        const event = store.appendRuntimeAccessEvent({
          simulationId,
          action,
          member,
          container,
          reason: optionalString(body, "reason") || null,
          turnId: optionalNonNegativeInteger(body, "turnId"),
          episodeId: optionalNonNegativeInteger(body, "episodeId")
        });
        sendJson(response, 200, {
          simulationId,
          event,
          effectiveAccessLinks: store.listEffectiveAccessLinks(simulationId)
        });
      });
      return;
    }

    if (method === "GET" && parts.length === 3 && parts[2] === "whispers") {
      await withStore(options, async (store) => {
        ensureSimulation(store, simulationId);
        sendJson(response, 200, {
          simulationId,
          stageWhispers: store.listStageWhispers(simulationId)
        });
      });
      return;
    }

    if (method === "POST" && parts.length === 3 && parts[2] === "whispers") {
      const body = await readJsonBody(request);
      const targetActorId = requireString(body, "targetActorId");
      const text = requireString(body, "text");

      await withStore(options, async (store) => {
        ensureSimulation(store, simulationId);
        const whisper = store.createStageWhisper({ simulationId, targetActorId, text });
        sendJson(response, 200, {
          simulationId,
          whisper
        });
      });
      return;
    }

    if (method === "GET" && parts.length === 3 && parts[2] === "memories") {
      await withStore(options, async (store) => {
        ensureSimulation(store, simulationId);
        sendJson(response, 200, {
          simulationId,
          memories: store.listEpisodeMemories(simulationId),
          longTermMemories: store.listLongTermMemories(simulationId)
        });
      });
      return;
    }

    if (method === "GET" && parts.length === 3 && parts[2] === "beliefs") {
      const actorId = url.searchParams.get("actorId");

      await withStore(options, async (store) => {
        ensureSimulation(store, simulationId);
        if (!actorId) {
          sendJson(response, 200, {
            simulationId,
            beliefs: store.listBeliefHistory(simulationId)
          });
          return;
        }

        const actor = store.getCompiledRecord<EntityRecord>(simulationId, "entity", actorId);
        if (!actor) throw new HttpError(404, `Actor not found: ${actorId}`);

        const beliefAccess = resolveBeliefAccess(
          actorId,
          store.listBeliefHistory(simulationId),
          store.listEffectiveAccessLinks(simulationId)
        );
        const resolution = resolveCurrentBeliefs(beliefAccess);
        sendJson(response, 200, {
          simulationId,
          actorId,
          currentBeliefs: resolution.current,
          conflictingBeliefs: resolution.conflicting,
          supersededBeliefs: resolution.superseded,
          groups: resolution.groups
        });
      });
      return;
    }

    if (method === "POST" && parts.length === 3 && parts[2] === "turns") {
      const body = await readJsonBody(request);
      const actorId = requireString(body, "actorId");
      const manualText = optionalString(body, "manualText");
      const modelId = optionalString(body, "modelId");
      const whisperText = optionalString(body, "whisperText");
      const audience = optionalStringArray(body, "audience");

      await withStore(options, async (store) => {
        ensureSimulation(store, simulationId);
        const result = await advanceTurn({
          store,
          simulationId,
          actorId,
          ...(manualText === undefined ? {} : { manualText }),
          ...(whisperText === undefined ? {} : { whisperText }),
          ...(audience === undefined ? {} : { audience }),
          ...(modelId
            ? {
                generateText: async ({ context }) => {
                  const model = await loadModelRecord(context.simulation.sourceRoot, modelId);
                  if (!model) throw new HttpError(404, `Model not found: ${modelId}`);
                  const generation = await generateDoxveltText({
                    actorId,
                    purpose: "turn",
                    model,
                    prompt: context.promptPreview
                  });
                  return generation.text;
                }
              }
            : {})
        });

        sendJson(response, 200, result);
      });
      return;
    }

    if (method === "POST" && parts.length === 4 && parts[2] === "episodes" && parts[3] === "close") {
      const body = await readJsonBody(request);
      const label = optionalString(body, "label") || null;

      await withStore(options, async (store) => {
        ensureSimulation(store, simulationId);
        sendJson(response, 200, await closeEpisode({ store, simulationId, label }));
      });
      return;
    }
  }

  throw new HttpError(404, `No route for ${method} ${url.pathname}.`);
}

async function withStore<TValue>(
  options: LocalApiOptions,
  callback: (store: RuntimeStore) => Promise<TValue> | TValue
): Promise<TValue> {
  const store = await openRuntimeStore(options.dbPath || DEFAULT_DB_PATH).open();
  try {
    return await callback(store);
  } finally {
    store.close();
  }
}

function ensureSimulation(store: RuntimeStore, simulationId: string): void {
  if (!store.getSimulation(simulationId)) {
    throw new HttpError(404, `Simulation not found: ${simulationId}`);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Body must be a JSON object.");
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, `Invalid JSON request body: ${detail}`);
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value === "string" && value.length > 0) return value;
  throw new HttpError(400, `${key} must be a non-empty string.`);
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  throw new HttpError(400, `${key} must be a string.`);
}

function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new HttpError(400, `${key} must be an array of strings.`);
}

function optionalNonNegativeInteger(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (Number.isInteger(value) && typeof value === "number" && value >= 0) return value;
  throw new HttpError(400, `${key} must be a non-negative integer.`);
}

function requireAudienceAction(
  body: Record<string, unknown>,
  key: string
): "add" | "remove" | "deactivate" | "reactivate" {
  const value = requireString(body, key);
  if (value === "add" || value === "remove" || value === "deactivate" || value === "reactivate") return value;
  throw new HttpError(400, `${key} must be add, remove, deactivate, or reactivate.`);
}

function requireAccessAction(body: Record<string, unknown>, key: string): "grant" | "revoke" {
  const value = requireString(body, key);
  if (value === "grant" || value === "revoke") return value;
  throw new HttpError(400, `${key} must be grant or revoke.`);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, jsonReplacer, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof DoxveltGenerationError ? "generation_failed" : "request_failed";
  sendJson(response, status, { error: { code, message } });
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
