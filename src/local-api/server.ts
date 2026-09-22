import { ACTOR_KNOWLEDGE_POLICY } from "../core/types.ts";
import { ROUTING_POLICY, routingInput } from "../core/candidate-routing.ts";
import { navigationToken } from "../application/simulation-collection.ts";
import path from "node:path";
import { playLastCrossing } from "./example.ts";
import { stageDraft, type StageProjection } from "./stage-contracts.ts";
import { canOwnTurn } from "../core/turn-ownership.ts";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  acceptActorTurnDraft,
  discardActorTurnDraft,
  generateActorTurnDraft,
} from "../core/draft-lifecycle.ts";
import { closeBranchEpisode, requestEpisodeClosure, runEpisodeMemoryJob } from "../core/branch-episode.ts";
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
import type { ActorTurnRuntime } from "../agent-runtime/contracts.ts";
import {
  openBranchStore,
  type SqliteSimulationRepository,
} from "../store/branch-sqlite.ts";
import {
  BranchConflictError,
  CommandIdentityError,
  DomainNotFoundError,
  DomainValidationError,
  MemoryJobConflictError,
} from "../core/ports.ts";

const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
export type LocalApiOptions = {
  dbPath?: string;
  actorTurnRuntime?: ActorTurnRuntime;
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
  const rawRequestTarget = request.url || "/";
  rejectDotPathSegments(rawRequestTarget);
  const url = new URL(rawRequestTarget, "http://localhost");
  if (url.searchParams.has("ownerScope"))
    throw new HttpError(
      400,
      "ownerScope is derived by the local API and must not be supplied.",
    );
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (method === "GET" && url.pathname === "/health")
    return send(response, 200, { ok: true });
  if (method === "GET" && url.pathname === "/runtime")
    return send(response, 200, runtimeStatus(options.actorTurnRuntime));
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
    if (method === "POST" && url.pathname === "/examples/last-crossing/play") {
      const body = await bodyOf(request);
      if (Object.keys(body).length) throw new HttpError(400, "Example setup accepts an empty object; the app chooses the workspace and run.");
      return send(response, 200, await playLastCrossing(store, path.dirname(path.resolve(options.dbPath || ".doxvelt/runtime.sqlite"))));
    }
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
    if (method === "GET" && parts[0] === "simulations" && parts.length === 1)
      return send(response, 200, { simulations: store.listSimulations(LOCAL_OWNER_SCOPE) });
    if (parts[0] !== "simulations" || !parts[1])
      throw new HttpError(404, `No route for ${method} ${url.pathname}.`);
    const simulationId = parts[1];
    const ownerScope = LOCAL_OWNER_SCOPE;
    const simulation = store.getSimulation(ownerScope, simulationId);
    if (!simulation)
      throw new HttpError(404, `Simulation not found: ${simulationId}`);
    if (parts[2] === "navigation" && parts.length === 3) {
      if (method === "GET") {
        const branchId = required({ branchId: url.searchParams.get("branchId") }, "branchId");
        if (!store.getBranch(ownerScope, simulationId, branchId)) throw new DomainNotFoundError("Saved branch not found.");
        return send(response, 200, { version: store.getNavigationVersion(ownerScope) });
      }
      if (method === "POST") {
        const body = await bodyOf(request);
        if (Object.keys(body).some(key => !["branchId", "operationId", "expectedVersion"].includes(key)))
          throw new HttpError(400, "Unexpected navigation field.");
        const expectedVersion = body.expectedVersion;
        if (expectedVersion !== null) navigationToken(expectedVersion);
        return send(response, 200, store.recordSimulationOpened({ ownerScope, simulationId,
          branchId: required(body, "branchId"), operationId: required(body, "operationId"), expectedVersion }));
      }
    }
    if (method === "GET" && parts[2] === "stage" && parts.length === 3) {
      const projection = projectBranch(store, query(url, simulation));
      const revision = content(store, ownerScope, simulationId);
      const scenario = revision.compiled.scenarios.find(item => item.id === simulation.scenarioId);
      const result: StageProjection = {
        scenarioName: scenario?.name || simulation.scenarioId || "Stage",
        branch: projection.branch,
        transcript: projection.transcript,
        audience: projection.audience,
        actors: revision.compiled.entities.filter(canOwnTurn).map(actor => ({
          id: actor.id, kind: actor.kind,
          name: actor.visibility === "public" ? actor.name : actor.id,
        })),
      };
      return send(response, 200, result);
    }
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
      if (Object.hasOwn(body, "knowledgePolicy") && body.knowledgePolicy !== ACTOR_KNOWLEDGE_POLICY)
        throw new HttpError(400, "Unsupported manual knowledge policy.");
      const knowledge = body.knowledgePolicy === ACTOR_KNOWLEDGE_POLICY;
      const base = envelope(body, ownerScope, simulationId);
      if (optional(body, "modelId"))
        throw new HttpError(
          400,
          "Model output must be generated with turn-draft and accepted separately as manualText.",
        );
      const text = required(body, "manualText");
      const actorId = required(body, "actorId");
      const stageWhisperIds = requiredStrings(body, "stageWhisperIds");
      // A missing basis cannot be a replay. Preserve the command conflict response
      // before projection lookup; existing bases reach the kernel's replay check.
      if (!store.getCommit(ownerScope, simulationId, base.expectedHead))
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
      const actorContext = knowledge ? null : inspectActorContext(store, {
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
          ...(knowledge ? { knowledgePolicy: ACTOR_KNOWLEDGE_POLICY } : {}),
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
        }).transcript.find(turn => turn.commitId === committed.commit.id),
        ...(actorContext ? { context: actorContext } : {}),
      });
    }
    if (method === "POST" && parts[2] === "turn-draft") {
      throw new HttpError(
        410,
        "turn-draft is retired; generate a durable draft with POST /simulations/:simulationId/drafts.",
      );
    }
    if (method === "POST" && parts[2] === "drafts" && !parts[3]) {
      const body = await bodyOf(request);
      rejectRuntimeSelection(body);
      if (body.draftingPolicy !== undefined && body.draftingPolicy !== ROUTING_POLICY && body.draftingPolicy !== ACTOR_KNOWLEDGE_POLICY)
        throw new HttpError(400, "Unsupported drafting policy.");
      if (!options.actorTurnRuntime)
        throw new HttpError(503, "No local actor-turn runtime is configured.");
      const knowledge = body.draftingPolicy === ACTOR_KNOWLEDGE_POLICY;
      const routed = knowledge || body.draftingPolicy === ROUTING_POLICY;
      if (knowledge && typeof body.completeWhisper !== "string")
        throw new HttpError(400, "New actor knowledge policy requires completeWhisper.");
      const base = envelope(body, ownerScope, simulationId);
      const audience =
        routed
          ? (body.audience == null ? [] : strings(body, "audience"))
          : body.audience === undefined
          ? projectBranch(store, {
              ownerScope,
              simulationId,
              branchId: base.branchId,
              head: base.expectedHead,
            })
              .audience.filter((item) => item.status === "active")
              .map((item) => item.actorId)
          : strings(body, "audience");
      const result = await generateActorTurnDraft(store, options.actorTurnRuntime, {
        ...base,
        payload: {
          actorId: required(body, "actorId"),
          audience,
          stageWhisperIds: strings(body, "stageWhisperIds"),
          runtimeProfile: { id: "local-character", version: "v1" },
          promptPolicy: { id: knowledge ? ACTOR_KNOWLEDGE_POLICY : routed ? ROUTING_POLICY : "default", version: "v1" },
          outputSchema: routed ? { id: "audience-proposal", digest: "v1" } : { id: "screenplay", digest: "schema-v1" },
          ...(routed ? { routing: { version: knowledge ? 3 as const : 1 as const,
            ...(knowledge ? { completeWhisper: body.completeWhisper as string } : {}),
            initialAudience: body.audience == null ? null : audience, correction: "", correctedAudience: null,
            preservedText: null, sourceDraftId: null } } : {}),
          skillDigests: [],
        },
      });
      return send(response, 200, result.draft.routing ? { ...result, draft: stageDraft(result.draft) } : result);
    }
    if (method === "GET" && parts[2] === "drafts" && parts.length === 3) {
      const branchId = url.searchParams.get("branchId");
      if (!branchId) throw new HttpError(400, "branchId is required for draft discovery.");
      if (!store.getBranch(ownerScope, simulationId, branchId))
        throw new HttpError(404, `Branch not found: ${branchId}`);
      return send(response, 200, {
        drafts: store.listRecoverableActorTurnDrafts(ownerScope, simulationId, branchId).map(stageDraft),
      });
    }
    if (method === "POST" && parts[2] === "drafts" && parts[3] && parts[4] === "revise" && parts.length === 5) {
      const body = await bodyOf(request);
      if (Object.keys(body).some(key => !["commandId", "audience", "correction", "completeWhisper", "preservedText", "draftingPolicy"].includes(key)))
        throw new HttpError(400, "Unexpected revision field.");
      const original = store.getActorTurnDraft(ownerScope, simulationId, parts[3]);
      if (!original?.routing) throw new HttpError(400, "Revision requires a routed source draft.");
      if (Object.hasOwn(body, "draftingPolicy") && body.draftingPolicy !== ACTOR_KNOWLEDGE_POLICY)
        throw new HttpError(400, "Unsupported revision drafting policy.");
      const knowledge = body.draftingPolicy === ACTOR_KNOWLEDGE_POLICY || original.routing.version === 3;
      const complete = Object.hasOwn(body, "completeWhisper");
      if (knowledge && !complete)
        throw new HttpError(400, "Actor knowledge revisions require completeWhisper.");
      if (complete && (typeof body.completeWhisper !== "string" || Object.hasOwn(body, "correction")))
        throw new HttpError(400, "Supply a completeWhisper without an additive correction.");
      const audience = complete && body.audience === null ? null : requiredStrings(body, "audience");
      const correction = complete ? "" : body.correction;
      if (typeof correction !== "string") throw new HttpError(400, "correction must be text.");
      if (body.preservedText !== undefined && typeof body.preservedText !== "string")
        throw new HttpError(400, "preservedText must be text.");
      if (body.preservedText === undefined && !options.actorTurnRuntime)
        throw new HttpError(503, "No local actor-turn runtime is configured.");
      const result = await generateActorTurnDraft(store, options.actorTurnRuntime || directorOnlyRuntime, {
        ownerScope, simulationId, branchId: original.branchId, expectedHead: original.basisHeadCommitId,
        commandId: required(body, "commandId"), payload: {
          actorId: original.actorId, audience: audience ?? original.routing.initialAudience ?? [], stageWhisperIds: original.stageWhispers.map(item => item.id),
          runtimeProfile: original.runtimeProfile, promptPolicy: knowledge ? { id: ACTOR_KNOWLEDGE_POLICY, version: "v1" } : original.promptPolicy,
          outputSchema: original.outputSchema, skillDigests: original.skillDigests,
          routing: { version: knowledge ? 3 : complete ? 2 : 1, ...(complete ? { completeWhisper: body.completeWhisper as string } : {}), initialAudience: original.routing.initialAudience,
            correctedAudience: audience, correction, sourceDraftId: original.id,
            preservedText: typeof body.preservedText === "string" ? body.preservedText : null },
        },
      });
      return send(response, 200, { ...result, draft: stageDraft(result.draft) });
    }
    if (method === "POST" && parts[2] === "drafts" && parts[3] && parts[4] === "retry" && parts.length === 5) {
      const body = await bodyOf(request);
      if (Object.keys(body).some(key => key !== "commandId"))
        throw new HttpError(400, "Retry accepts only a commandId; routing is captured by the original draft.");
      const original = store.getActorTurnDraft(ownerScope, simulationId, parts[3]);
      if (!original) throw new HttpError(404, "Draft not found.");
      if (!options.actorTurnRuntime && original.routing?.preservedText == null) throw new HttpError(503, "No local actor-turn runtime is configured.");
      const result = await generateActorTurnDraft(store, options.actorTurnRuntime || directorOnlyRuntime, {
        ownerScope, simulationId, branchId: original.branchId,
        expectedHead: original.basisHeadCommitId, commandId: required(body, "commandId"),
        payload: {
          actorId: original.actorId, audience: original.audience,
          ...(original.routing ? { routing: routingInput(original.routing) } : {}),
          stageWhisperIds: original.stageWhispers.map(whisper => whisper.id),
          runtimeProfile: original.runtimeProfile, promptPolicy: original.promptPolicy,
          outputSchema: original.outputSchema, skillDigests: original.skillDigests,
        },
      }, { retryDraftId: original.id });
      return send(response, 200, result.draft.routing ? { ...result, draft: stageDraft(result.draft) } : result);
    }
    if (method === "GET" && parts[2] === "drafts" && parts[3] && !parts[4]) {
      const draft = store.getActorTurnDraft(ownerScope, simulationId, parts[3]);
      if (!draft) throw new HttpError(404, `Draft not found: ${parts[3]}`);
      return send(response, 200, draft.routing ? stageDraft(draft) : draft);
    }
    if (
      method === "POST" &&
      parts[2] === "drafts" &&
      parts[3] &&
      parts[4] === "accept" &&
      parts.length === 5
    ) {
      const body = await bodyOf(request);
      if (Object.keys(body).some(key => !["commandId", "finalText"].includes(key)))
        throw new HttpError(400, "Acceptance cannot change candidate routing.");
      return send(response, 200, acceptActorTurnDraft(store, {
        ownerScope,
        simulationId,
        draftId: parts[3],
        commandId: required(body, "commandId"),
        ...(body.finalText === undefined ? {} : { finalText: any(body, "finalText") }),
      }));
    }
    if (
      method === "POST" &&
      parts[2] === "drafts" &&
      parts[3] &&
      parts[4] === "discard" &&
      parts.length === 5
    ) {
      const body = await bodyOf(request);
      const result = discardActorTurnDraft(store, {
        ownerScope,
        simulationId,
        draftId: parts[3],
        commandId: required(body, "commandId"),
      });
      return send(response, 200, result.draft.routing ? { ...result, draft: stageDraft(result.draft) } : result);
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
    if (method === "POST" && parts[2] === "episodes" && parts[3] === "request-closure") {
      const body = await bodyOf(request);
      return send(response, 200, requestEpisodeClosure(store, {
        ...envelope(body, ownerScope, simulationId),
        payload: { label: optional(body, "label") || null },
      }));
    }
    if (
      method === "GET" && parts[2] === "memory-jobs" && parts[3] &&
      parts[4] === "transitions"
    )
      return send(response, 200, store.listMemoryJobTransitions(
        ownerScope, simulationId, parts[3],
      ));
    if (method === "GET" && parts[2] === "memory-jobs")
      return send(response, 200, store.listMemoryJobs(ownerScope, simulationId));
    if (method === "POST" && parts[2] === "memory-jobs" && parts[3]) {
      return send(response, 200, await runEpisodeMemoryJob(store, {
        ownerScope, simulationId, jobId: parts[3],
      }));
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
          error instanceof CommandIdentityError ||
          error instanceof MemoryJobConflictError
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
function rejectDotPathSegments(requestTarget: string): void {
  const rawPath = requestTarget.split("?", 1)[0] || "/";
  for (const segment of rawPath.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new HttpError(400, "Request path contains invalid encoding.");
    }
    if (decoded === "." || decoded === "..")
      throw new HttpError(404, "Request path contains a forbidden dot segment.");
  }
}

function rejectRuntimeSelection(body: Record<string, unknown>): void {
  for (const key of [
    "modelId",
    "baseUrl",
    "runtimeProfile",
    "promptPolicy",
    "outputSchema",
    "skills",
    "apiKey",
    "ownerScope",
  ]) {
    if (Object.hasOwn(body, key))
      throw new HttpError(400, `${key} is deployment-owned and must not be supplied.`);
  }
}

function runtimeStatus(runtime: ActorTurnRuntime | undefined) {
  const identity = runtime?.identity;
  return {
    configured: Boolean(runtime),
    runtimeProfile: { id: "local-character", version: "v1" },
    adapter: runtime
      ? {
          id: publicRuntimeIdentity(identity?.id),
          version: publicRuntimeIdentity(identity?.version),
        }
      : null,
    provider: runtime ? publicRuntimeIdentity(identity?.providerId) : null,
    model: runtime ? publicRuntimeIdentity(identity?.modelId) : null,
  };
}

function publicRuntimeIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 160 ||
    /^[a-z][a-z\d+.-]*:\/\//i.test(normalized) ||
    /(?:^|[/_=-])(?:sk|pk|rk|api[_-]?key|token|secret)(?:[/_=-]|$)/i.test(normalized)
  )
    return null;
  return normalized;
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

// No provider is invoked for an explicitly director-preserved replacement.
const directorOnlyRuntime: import("../agent-runtime/contracts.ts").ActorTurnRuntime = {
  identity: { id: "director-preserved", version: "v1" },
  async *runActorTurn() { throw new Error("Director preservation must not invoke a runtime."); },
};
