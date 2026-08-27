import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { generateDoxveltText } from "../ai/generate.ts";
import { closeBranchEpisode } from "../core/branch-episode.ts";
import {
  assertExpectedBranchHead,
  commitManualTurn,
  commitRuntimeEffects,
  editAcceptedMessage,
  forkBranch,
  inspectActorContext,
  LOCAL_OWNER_SCOPE,
  projectBranch,
  regenerateAcceptedResponse,
  stageWhisper,
  startBranchSimulation,
} from "../core/branch-kernel.ts";
import { compileWorkspace } from "../core/compiler.ts";
import { retractMemory, reviseMemory } from "../core/memory-operations.ts";
import { initWorkspace } from "../core/init.ts";
import { loadModelRecord } from "../core/models.ts";
import {
  exportSimulationPackage,
  importSimulationPackage,
} from "../store/portable.ts";
import {
  deleteWorkspaceSource,
  listWorkspaceSourceFiles,
  readSourceText,
  writeSourceText,
} from "../core/source.ts";
import {
  openBranchStore,
  type SqliteSimulationRepository,
} from "../store/branch-sqlite.ts";
import {
  BranchConflictError,
  CommandIdentityError,
  DomainNotFoundError,
  DomainValidationError,
} from "../core/ports.ts";

const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
export type LocalApiOptions = {
  dbPath?: string;
  allowedOrigins?: readonly string[];
};
export function createLocalApiServer(options: LocalApiOptions = {}) {
  return createServer(
    (request, response) =>
      void handleLocalApiRequest(request, response, options).catch((error) =>
        sendError(response, error),
      ),
  );
}

export async function handleLocalApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: LocalApiOptions = {},
): Promise<void> {
  const method = request.method || "GET";
  validateLocalBoundary(request, response, method, options);
  if (method === "OPTIONS") return end(response, 204);
  const url = new URL(request.url || "/", "http://localhost");
  if (url.searchParams.has("ownerScope"))
    throw new HttpError(
      400,
      "ownerScope is derived by the local API and must not be supplied.",
    );
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (method === "GET" && url.pathname === "/health")
    return send(response, 200, { ok: true });
  if (parts[0] === "source")
    return sourceRoute(method, parts, url, request, response);
  if (method === "POST" && parts[0] === "packages") {
    const body = await bodyOf(request);
    if (parts[1] === "export")
      return send(
        response,
        200,
        await exportSimulationPackage({
          dbPath: options.dbPath || ".doxvelt/runtime.sqlite",
          ownerScope: LOCAL_OWNER_SCOPE,
          simulationId: optional(body, "simulationId") || "default",
          targetDir: required(body, "targetDir"),
        }),
      );
    if (parts[1] === "import")
      return send(
        response,
        200,
        await importSimulationPackage({
          packageDir: required(body, "packageDir"),
          targetSourceDir: required(body, "targetSourceDir"),
          targetDbPath:
            optional(body, "targetDbPath") ||
            options.dbPath ||
            ".doxvelt/runtime.sqlite",
          expectedOwnerScope: LOCAL_OWNER_SCOPE,
        }),
      );
  }
  const store = await openBranchStore(
    options.dbPath || ".doxvelt/runtime.sqlite",
  ).open();
  try {
    if (
      method === "POST" &&
      parts[0] === "simulations" &&
      parts[1] === "start"
    ) {
      const body = await bodyOf(request);
      const started = await startBranchSimulation(store, {
        ownerScope: LOCAL_OWNER_SCOPE,
        simulationId: optional(body, "simulationId") || "default",
        workspacePath: requiredWorkspace(body),
        scenarioId: optional(body, "scenarioId") || "default",
        branchId: optional(body, "branchId") || "main",
        commandId: required(body, "commandId"),
      });
      return send(response, 200, {
        ...started,
        actors: started.compiled.entities.filter(
          (item) => item.kind !== "artifact",
        ),
        models: started.compiled.models,
        diagnostics: started.compiled.diagnostics,
      });
    }
    if (parts[0] !== "simulations" || !parts[1])
      throw new HttpError(404, `No route for ${method} ${url.pathname}.`);
    const simulationId = parts[1];
    const ownerScope = LOCAL_OWNER_SCOPE;
    const simulation = store.getSimulation(ownerScope, simulationId);
    if (!simulation)
      throw new HttpError(404, `Simulation not found: ${simulationId}`);
    if (method === "GET" && parts[2] === "actors")
      return send(response, 200, {
        simulationId,
        actors: content(
          store,
          ownerScope,
          simulationId,
        ).compiled.entities.filter((item) => item.kind !== "artifact"),
      });
    if (method === "POST" && parts[2] === "memories" && parts[3] === "revise") {
      const body = await bodyOf(request);
      return send(response, 200, reviseMemory(store, {
        ...envelope(body, ownerScope, simulationId),
        payload: {
          actorId: required(body, "actorId"),
          memoryId: required(body, "memoryId"),
          revisesOperationId: required(body, "revisesOperationId"),
          content: required(body, "content"),
        },
      }));
    }
    if (method === "POST" && parts[2] === "memories" && parts[3] === "retract") {
      const body = await bodyOf(request);
      return send(response, 200, retractMemory(store, {
        ...envelope(body, ownerScope, simulationId),
        payload: {
          actorId: required(body, "actorId"),
          memoryId: required(body, "memoryId"),
          retractsOperationId: required(body, "retractsOperationId"),
        },
      }));
    }
    if (method === "GET" && parts[2] === "context" && parts[3]) {
      const q = query(url, simulation);
      const head = projectBranch(store, q).branch.headCommitId;
      const whispers = store.listPendingStageWhispers(
        ownerScope,
        simulationId,
        q.branchId,
        head,
        parts[3],
      );
      return send(
        response,
        200,
        inspectActorContext(store, {
          ...q,
          actorId: parts[3],
          stageWhispers: whispers,
        }),
      );
    }
    if (
      method === "GET" &&
      [
        "transcript",
        "audience",
        "access",
        "beliefs",
        "memories",
        "branches",
      ].includes(parts[2] || "")
    )
      return sendProjection(
        response,
        parts[2]!,
        projectBranch(store, query(url, simulation)),
        store.exportSimulation(ownerScope, simulationId).branches,
      );
    if (method === "POST" && parts[2] === "turns") {
      const body = await bodyOf(request);
      const base = envelope(body, ownerScope, simulationId);
      if (optional(body, "modelId"))
        throw new HttpError(
          400,
          "Model output must be generated with turn-draft and accepted separately as manualText.",
        );
      const text = required(body, "manualText");
      const actorId = required(body, "actorId");
      const stageWhisperIds = requiredStrings(body, "stageWhisperIds");
      assertExpectedBranchHead(store, base);
      const q = {
        ownerScope,
        simulationId,
        branchId: base.branchId,
        head: base.expectedHead,
      };
      const audience =
        body.audience === undefined
          ? projectBranch(store, q)
              .audience.filter((item) => item.status === "active")
              .map((item) => item.actorId)
          : strings(body, "audience");
      const whispers = store.listPendingStageWhispers(
        ownerScope,
        simulationId,
        base.branchId,
        base.expectedHead,
        actorId,
      );
      const actorContext = inspectActorContext(store, {
        ...q,
        actorId,
        audience,
        stageWhispers: whispers.filter((whisper) =>
          stageWhisperIds.includes(String(whisper.id)),
        ),
      });
      const committed = commitManualTurn(store, {
        ...base,
        payload: {
          actorId,
          text,
          audience,
          stageWhisper: optional(body, "whisperText") || null,
          stageWhisperIds,
          audienceChanges: audienceChangeArray(body),
          accessChanges: accessChangeArray(body),
        },
      });
      return send(response, 200, {
        ...committed,
        turn: projectBranch(store, {
          ownerScope,
          simulationId,
          branchId: base.branchId,
        }).transcript.at(-1),
        context: actorContext,
      });
    }
    if (method === "POST" && parts[2] === "turn-draft") {
      const body = await bodyOf(request);
      const actorId = required(body, "actorId");
      const branchId = required(body, "branchId");
      const expectedHead = required(body, "expectedHead");
      assertExpectedBranchHead(store, {
        ownerScope,
        simulationId,
        branchId,
        expectedHead,
      });
      const pendingWhispers = store.listPendingStageWhispers(
        ownerScope,
        simulationId,
        branchId,
        expectedHead,
        actorId,
      );
      const audience =
        body.audience === undefined
          ? projectBranch(store, {
              ownerScope,
              simulationId,
              branchId,
              head: expectedHead,
            })
              .audience.filter((item) => item.status === "active")
              .map((item) => item.actorId)
          : strings(body, "audience");
      const context = inspectActorContext(store, {
        ownerScope,
        simulationId,
        branchId,
        head: expectedHead,
        actorId,
        audience,
        stageWhispers: [
          ...pendingWhispers,
          ...(optional(body, "whisperText")
            ? [
                {
                  id: "draft",
                  ownerScope,
                  simulationId,
                  branchId,
                  expectedHead,
                  commandId: "draft",
                  targetActorId: actorId,
                  text: optional(body, "whisperText")!,
                  createdAt: new Date().toISOString(),
                },
              ]
            : []),
        ],
      });
      const modelId = required(body, "modelId");
      const model = await loadModelRecord(simulation.sourceRoot, modelId);
      if (!model) throw new HttpError(404, `Model not found: ${modelId}`);
      const generated = await generateDoxveltText({
        actorId,
        purpose: "turn",
        model,
        prompt: context.promptPreview,
      });
      return send(response, 200, {
        simulationId,
        actorId,
        modelId,
        text: generated.text.trim(),
        audience: context.subjective.currentAudience,
        stageWhisperIds: pendingWhispers.map((whisper) => String(whisper.id)),
        context,
      });
    }
    if (method === "POST" && parts[2] === "audience") {
      const body = await bodyOf(request);
      return send(
        response,
        200,
        commitRuntimeEffects(store, {
          ...envelope(body, ownerScope, simulationId),
          payload: {
            audienceChanges: [
              {
                actorId: required(body, "actorId"),
                action: choice(body, "action", [
                  "add",
                  "remove",
                  "deactivate",
                  "reactivate",
                ]),
                reason: optional(body, "reason") || null,
              },
            ],
          },
        }),
      );
    }
    if (method === "POST" && parts[2] === "access") {
      const body = await bodyOf(request);
      return send(
        response,
        200,
        commitRuntimeEffects(store, {
          ...envelope(body, ownerScope, simulationId),
          payload: {
            accessChanges: [
              {
                action: choice(body, "action", ["grant", "revoke"]),
                member: required(body, "member"),
                container: required(body, "container"),
                reason: optional(body, "reason") || null,
              },
            ],
          },
        }),
      );
    }
    if (method === "POST" && parts[2] === "whispers") {
      const body = await bodyOf(request);
      return send(
        response,
        200,
        stageWhisper(store, {
          ...envelope(body, ownerScope, simulationId),
          targetActorId: required(body, "targetActorId"),
          text: required(body, "text"),
        }),
      );
    }
    if (method === "GET" && parts[2] === "whispers") {
      const branchId =
        url.searchParams.get("branchId") || simulation.defaultBranchId;
      const expectedHead = requiredSearch(url, "expectedHead");
      const actorId = requiredSearch(url, "actorId");
      return send(response, 200, {
        stageWhispers: store.listPendingStageWhispers(
          ownerScope,
          simulationId,
          branchId,
          expectedHead,
          actorId,
        ),
      });
    }
    if (method === "POST" && parts[2] === "edit") {
      const body = await bodyOf(request);
      const base = envelope(body, ownerScope, simulationId);
      return send(
        response,
        200,
        editAcceptedMessage(store, {
          ...base,
          sourceBranchId: base.branchId,
          sourceCommitId: required(body, "sourceCommitId"),
          branchId: required(body, "newBranchId"),
          payload: {
            actorId: required(body, "actorId"),
            text: required(body, "manualText"),
            audience: strings(body, "audience"),
          },
        }),
      );
    }
    if (method === "POST" && parts[2] === "regenerate") {
      const body = await bodyOf(request);
      const base = envelope(body, ownerScope, simulationId);
      return send(
        response,
        200,
        regenerateAcceptedResponse(store, {
          ...base,
          sourceBranchId: base.branchId,
          sourceCommitId: required(body, "sourceCommitId"),
          branchId: required(body, "newBranchId"),
          payload: {
            actorId: required(body, "actorId"),
            text: required(body, "manualText"),
            audience: strings(body, "audience"),
          },
        }),
      );
    }
    if (method === "POST" && parts[2] === "fork") {
      const body = await bodyOf(request);
      return send(
        response,
        200,
        forkBranch(store, {
          ownerScope,
          simulationId,
          sourceBranchId: required(body, "branchId"),
          expectedHead: required(body, "expectedHead"),
          atCommitId: required(body, "atCommitId"),
          branchId: required(body, "newBranchId"),
          commandId: required(body, "commandId"),
          name: optional(body, "name") || null,
        }),
      );
    }
    if (method === "POST" && parts[2] === "episodes" && parts[3] === "close") {
      const body = await bodyOf(request);
      const closed = await closeBranchEpisode(store, {
        ...envelope(body, ownerScope, simulationId),
        payload: { label: optional(body, "label") || null },
      });
      return send(response, 200, { ...closed.closure, commit: closed.commit });
    }
    throw new HttpError(404, `No route for ${method} ${url.pathname}.`);
  } finally {
    store.close();
  }
}

async function sourceRoute(
  method: string,
  parts: string[],
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (method === "GET" && parts.length === 1)
    return send(
      response,
      200,
      await listWorkspaceSourceFiles(requiredSearch(url, "workspacePath")),
    );
  if (method === "GET" && parts[1] === "file")
    return send(
      response,
      200,
      await readSourceText(
        requiredSearch(url, "workspacePath"),
        requiredSearch(url, "path"),
      ),
    );
  const body = await bodyOf(request);
  if (method === "POST" && parts[1] === "file")
    return send(
      response,
      200,
      await writeSourceText(
        requiredWorkspace(body),
        required(body, "path"),
        any(body, "text"),
      ),
    );
  if (method === "POST" && parts[1] === "compile")
    return send(response, 200, await compileWorkspace(requiredWorkspace(body)));
  if (method === "POST" && parts[1] === "init")
    return send(
      response,
      200,
      await initWorkspace(requiredWorkspace(body), {
        template: optional(body, "template") || null,
      }),
    );
  if (method === "POST" && parts[1] === "delete")
    return send(
      response,
      200,
      await deleteWorkspaceSource(requiredWorkspace(body)),
    );
  throw new HttpError(404, "Unknown source route.");
}
function sendProjection(
  response: ServerResponse,
  kind: string,
  p: ReturnType<typeof projectBranch>,
  branches: unknown[],
) {
  if (kind === "transcript")
    return send(response, 200, { branch: p.branch, transcript: p.transcript });
  if (kind === "audience")
    return send(response, 200, {
      branch: p.branch,
      audienceMembers: p.audience,
      activeAudience: p.audience
        .filter((item) => item.status === "active")
        .map((item) => item.actorId),
    });
  if (kind === "access")
    return send(response, 200, {
      branch: p.branch,
      effectiveAccessLinks: p.accessLinks,
    });
  if (kind === "beliefs")
    return send(response, 200, { branch: p.branch, beliefs: p.beliefs });
  if (kind === "memories")
    return send(response, 200, {
      branch: p.branch,
      memories: p.episodeMemories,
      longTermMemories: p.longTermMemories,
      operations: p.memoryOperations,
      perceptions: p.perceptions,
    });
  return send(response, 200, { branch: p.branch, branches });
}
function query(
  url: URL,
  simulation: NonNullable<
    ReturnType<SqliteSimulationRepository["getSimulation"]>
  >,
) {
  const head = url.searchParams.get("head");
  return {
    ownerScope: simulation.ownerScope,
    simulationId: simulation.id,
    branchId: url.searchParams.get("branchId") || simulation.defaultBranchId,
    ...(head ? { head } : {}),
  };
}
function envelope(
  body: Record<string, unknown>,
  ownerScope: string,
  simulationId: string,
) {
  return {
    ...envelopeBase(body, ownerScope, simulationId),
    branchId: required(body, "branchId"),
  };
}
function envelopeBase(
  body: Record<string, unknown>,
  ownerScope: string,
  simulationId: string,
) {
  return {
    ownerScope,
    simulationId,
    expectedHead: required(body, "expectedHead"),
    commandId: required(body, "commandId"),
  };
}
function content(
  store: SqliteSimulationRepository,
  owner: string,
  simulation: string,
) {
  const sim = store.getSimulation(owner, simulation)!;
  const revision = store.getContentRevision(owner, sim.contentRevisionId);
  if (!revision) throw new Error("Pinned content revision missing.");
  return revision;
}
async function bodyOf(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const item = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += item.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Body too large.");
    chunks.push(item);
  }
  if (!chunks.length) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Body must be an object.");
    const body = parsed as Record<string, unknown>;
    if (Object.hasOwn(body, "ownerScope"))
      throw new HttpError(
        400,
        "ownerScope is derived by the local API and must not be supplied.",
      );
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
function required(body: Record<string, unknown>, key: string) {
  const item = body[key];
  if (typeof item !== "string" || !item)
    throw new HttpError(400, `${key} must be a non-empty string.`);
  return item;
}
function any(body: Record<string, unknown>, key: string) {
  const item = body[key];
  if (typeof item !== "string")
    throw new HttpError(400, `${key} must be a string.`);
  return item;
}
function optional(body: Record<string, unknown>, key: string) {
  const item = body[key];
  if (item === undefined || item === null) return undefined;
  if (typeof item !== "string")
    throw new HttpError(400, `${key} must be a string.`);
  return item;
}
function requiredWorkspace(body: Record<string, unknown>) {
  const item = body.workspacePath ?? body.worldPath;
  if (typeof item !== "string" || !item)
    throw new HttpError(400, "workspacePath is required.");
  return item;
}
function strings(body: Record<string, unknown>, key: string) {
  const item = body[key];
  if (item === undefined) return [];
  if (!Array.isArray(item) || !item.every((value) => typeof value === "string"))
    throw new HttpError(400, `${key} must be strings.`);
  return item as string[];
}
function requiredStrings(body: Record<string, unknown>, key: string) {
  if (!Object.hasOwn(body, key))
    throw new HttpError(400, `${key} is required.`);
  return strings(body, key);
}
function audienceChangeArray(body: Record<string, unknown>) {
  const values = records(body, "audienceChanges");
  return values.map((item) => ({
    actorId: required(item, "actorId"),
    action: choice(item, "action", [
      "add",
      "remove",
      "deactivate",
      "reactivate",
    ]),
    reason: optional(item, "reason") || null,
  }));
}
function accessChangeArray(body: Record<string, unknown>) {
  const values = records(body, "accessChanges");
  return values.map((item) => ({
    action: choice(item, "action", ["grant", "revoke"]),
    member: required(item, "member"),
    container: required(item, "container"),
    reason: optional(item, "reason") || null,
  }));
}
function records(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const item = body[key];
  if (item === undefined) return [];
  if (
    !Array.isArray(item) ||
    !item.every(
      (value) => value && typeof value === "object" && !Array.isArray(value),
    )
  )
    throw new HttpError(400, `${key} must be an array of objects.`);
  return item as Record<string, unknown>[];
}
function choice<const T extends string>(
  body: Record<string, unknown>,
  key: string,
  choices: readonly T[],
) {
  const item = required(body, key);
  if (!choices.includes(item as T))
    throw new HttpError(400, `${key} is invalid.`);
  return item as T;
}
function requiredSearch(url: URL, key: string) {
  const item = url.searchParams.get(key);
  if (!item) throw new HttpError(400, `${key} is required.`);
  return item;
}
function send(response: ServerResponse, status: number, item: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(item, null, 2));
}
function sendError(response: ServerResponse, error: unknown) {
  const status =
    error instanceof HttpError
      ? error.status
      : error instanceof BranchConflictError ||
          error instanceof CommandIdentityError
        ? 409
        : error instanceof DomainNotFoundError
          ? 404
          : error instanceof DomainValidationError
            ? 400
            : 500;
  send(response, status, {
    error: error instanceof Error ? error.message : String(error),
  });
}
function validateLocalBoundary(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  options: LocalApiOptions,
): void {
  response.setHeader("vary", "Origin");
  const origin = request.headers.origin;
  const allowedOrigins = new Set(
    options.allowedOrigins || DEFAULT_ALLOWED_ORIGINS,
  );
  if (origin) {
    if (!allowedOrigins.has(origin))
      throw new HttpError(403, `Origin is not allowed: ${origin}`);
    response.setHeader("access-control-allow-origin", origin);
  }
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  if (method !== "OPTIONS" && isJsonMutation(method)) {
    const contentType = request.headers["content-type"]
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json")
      throw new HttpError(
        415,
        "State-changing requests require Content-Type: application/json.",
      );
  }
}
function isJsonMutation(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method);
}
function end(response: ServerResponse, status: number) {
  response.writeHead(status);
  response.end();
}
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
