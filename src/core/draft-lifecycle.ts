import { parseAudienceProposal, prepareRouting, preservedArtifact, projectRoutingContext, routingInput } from "./candidate-routing.ts";
export { acceptActorTurnDraft } from "./draft-acceptance.ts";

import { createHash } from "node:crypto";
import {
  canonicalDraftContext,
  artifactDigest,
  decodeActorTurnDraftRecord,
  MAX_RUNTIME_TEXT_CHARS,
  requiredSafeIdentifier,
  validateRoutingInput,
} from "./draft-contracts.ts";
import type {
  ActorTurnRuntime,
  AgentRuntimeEvent,
  RunActorTurnRequest,
  RuntimeAdapterIdentity,
  RuntimeCompletion,
} from "../agent-runtime/contracts.ts";
import {
  canOwnTurn,
  domainId,
  normalizeAudience,
  stableStringify,
} from "./domain-rules.ts";
import { inspectActorContext } from "./branch-kernel.ts";
import {
  BranchConflictError,
  CommandIdentityError,
  DomainNotFoundError,
  DomainValidationError,
  type ActorTurnDraftRepository,
  type DiscardActorTurnDraftCommand,
  type GenerateActorTurnDraftCommand,
  type GenerateActorTurnDraftPayload,
  type SimulationRepository,
} from "./ports.ts";
import type {
  ActorTurnDraftArtifact,
  ActorTurnDraftFailure,
  ActorTurnDraftRecord,
  NormalizedRuntimeUsage,
  RuntimeStopReason,
  StageWhisperRecord,
} from "./types.ts";

const MAX_RUNTIME_EVENTS = 10_000;

export type GenerateActorTurnDraftOptions = {
  signal?: AbortSignal;
  /** Trusted repository identity whose frozen input must be repeated. */
  retryDraftId?: string;
};

type DraftLifecycleRepository = SimulationRepository & ActorTurnDraftRepository;

export function generateActorTurnDraft(
  repository: DraftLifecycleRepository,
  runtime: ActorTurnRuntime,
  command: GenerateActorTurnDraftCommand,
  options: GenerateActorTurnDraftOptions = {},
): Promise<{ draft: ActorTurnDraftRecord; replayed: boolean }> {
  const normalized = normalizeGenerationCommand(command);
  if (normalized.payload.routing) {
    const input = normalized.payload.routing;
    validateRoutingInput(input);
    if (stableStringify(normalized.payload.audience) !== stableStringify(normalizeAudience(normalized.payload.actorId, input.correctedAudience ?? input.initialAudience ?? [])))
      throw new DomainValidationError("Routing direction and audience disagree.");
  }
  const commandFingerprint = digest(stableStringify(normalized));
  const draftId = domainId(
    "actor_turn_draft",
    normalized.ownerScope,
    normalized.simulationId,
    normalized.commandId,
  );
  const existing = repository.getActorTurnDraft(
    normalized.ownerScope,
    normalized.simulationId,
    draftId,
  );
  if (existing)
    return Promise.resolve(
      repository.reserveActorTurnDraft({
        draft: existing,
        commandFingerprint,
      }),
    );
  const simulation = repository.getSimulation(
    normalized.ownerScope,
    normalized.simulationId,
  );
  if (!simulation)
    throw new DomainNotFoundError(
      `Simulation not found: ${normalized.simulationId}`,
    );
  const branch = repository.getBranch(
    normalized.ownerScope,
    normalized.simulationId,
    normalized.branchId,
  );
  if (!branch)
    throw new DomainNotFoundError(`Branch not found: ${normalized.branchId}`);
  if (branch.headCommitId !== normalized.expectedHead)
    throw new BranchConflictError(normalized.expectedHead, branch.headCommitId);
  const revision = repository.getContentRevision(
    normalized.ownerScope,
    simulation.contentRevisionId,
  );
  if (!revision) throw new DomainNotFoundError("Content revision not found.");
  const actor = revision.compiled.entities.find(
    (entity) => entity.id === normalized.payload.actorId,
  );
  if (!actor || !canOwnTurn(actor))
    throw new DomainNotFoundError(
      `Actor not found: ${normalized.payload.actorId}`,
    );
  for (const audienceActorId of normalized.payload.audience) {
    const audienceActor = revision.compiled.entities.find(
      (entity) => entity.id === audienceActorId,
    );
    if (!audienceActor || !canOwnTurn(audienceActor))
      throw new DomainNotFoundError(`Actor not found: ${audienceActorId}`);
  }
  const captured = options.retryDraftId ? repository.getActorTurnDraft(normalized.ownerScope, normalized.simulationId, options.retryDraftId) : null;
  if (options.retryDraftId) {
    if (!captured) throw new DomainNotFoundError("Retry source not found.");
    const capturedCommand = normalizeGenerationCommand({ ownerScope: captured.ownerScope, simulationId: captured.simulationId,
      branchId: captured.branchId, expectedHead: captured.basisHeadCommitId, commandId: normalized.commandId,
      payload: { actorId: captured.actorId, audience: captured.audience, stageWhisperIds: captured.stageWhispers.map(item => item.id),
        runtimeProfile: captured.runtimeProfile, promptPolicy: captured.promptPolicy, outputSchema: captured.outputSchema,
        skillDigests: captured.skillDigests, ...(captured.routing ? { routing: routingInput(captured.routing) } : {}) } });
    if (stableStringify(capturedCommand) !== stableStringify(normalized))
      throw new DomainValidationError("Retry must repeat captured input.");
  }
  const whispers = selectWhispers(repository, normalized);
  const context = normalized.payload.routing ? null : inspectActorContext(repository, {
    ownerScope: normalized.ownerScope,
    simulationId: normalized.simulationId,
    branchId: normalized.branchId,
    head: normalized.expectedHead,
    actorId: actor.id,
    audience: normalized.payload.audience,
    stageWhispers: whispers,
  });
  const routing = normalized.payload.routing ? prepareRouting(repository, normalized, []) : undefined;
  const routed = routing ? projectRoutingContext(repository, normalized, whispers,
    routing.preservedText === null && (!captured || (captured.context && typeof captured.context === "object" && "correctionSource" in captured.context)) ? routing.source : null) : null;
  if (routing && routed) routing.availableRecipientIds = routed.availableRecipientIds;
  const portableContext = routed ? routed.context : canonicalDraftContext(context);
  const prompt = routed ? routed.prompt : context!.promptPreview;
  if (captured && (digest(prompt) !== captured.promptHash || digest(stableStringify(portableContext)) !== captured.contextHash))
    throw new DomainValidationError("Retry context differs from captured input.");
  const createdAt = new Date().toISOString();
  const draft = decodeActorTurnDraftRecord({
    ...(routing ? { routing } : {}),
    id: draftId,
    ownerScope: normalized.ownerScope,
    simulationId: normalized.simulationId,
    generationCommandId: normalized.commandId,
    branchId: normalized.branchId,
    basisHeadCommitId: normalized.expectedHead,
    contentRevisionId: revision.id,
    actorId: actor.id,
    audience: normalized.payload.audience,
    stageWhispers: whispers.map(({ id, text }) => ({ id, text })),
    runtimeProfile: normalized.payload.runtimeProfile,
    promptPolicy: normalized.payload.promptPolicy,
    outputSchema: normalized.payload.outputSchema,
    skillDigests: normalized.payload.skillDigests,
    capabilityGrant: [],
    context: portableContext,
    contextHash: digest(stableStringify(portableContext)),
    prompt,
    promptHash: digest(prompt),
    status: "generating",
    artifact: null,
    failure: null,
    createdAt,
    updatedAt: createdAt,
  });
  const reserved = repository.reserveActorTurnDraft({
    draft,
    commandFingerprint,
  });
  if (reserved.replayed) return Promise.resolve(reserved);
  return runDraft(repository, runtime, reserved.draft, options).then(
    (completed) => ({ draft: completed, replayed: false }),
  );
}

export function discardActorTurnDraft(
  repository: DraftLifecycleRepository,
  command: DiscardActorTurnDraftCommand,
): { draft: ActorTurnDraftRecord; replayed: boolean } {
  if (!repository.getSimulation(command.ownerScope, command.simulationId))
    throw new DomainNotFoundError(
      `Simulation not found: ${command.simulationId}`,
    );
  if (
    !repository.getActorTurnDraft(
      command.ownerScope,
      command.simulationId,
      command.draftId,
    )
  )
    throw new DomainNotFoundError(`Draft not found: ${command.draftId}`);
  return repository.discardActorTurnDraft({
    ...command,
    commandFingerprint: digest(
      stableStringify({ ...command, kind: "discard_draft" }),
    ),
  });
}

async function runDraft(
  repository: DraftLifecycleRepository,
  runtime: ActorTurnRuntime,
  draft: ActorTurnDraftRecord,
  options: GenerateActorTurnDraftOptions,
): Promise<ActorTurnDraftRecord> {
  const adapterIdentity = captureRuntimeIdentity(runtime);
  try {
    if (draft.routing?.preservedText !== null && draft.routing?.preservedText !== undefined)
      return finishOrCurrent(repository, draft, preservedArtifact(draft));
    const outcome = await validateRuntimeStream(runtime, draft, options);
    if (outcome.status === "failed")
      return failOrCurrent(
        repository,
        draft,
        failureFor(
          adapterIdentity,
          draft,
          outcome.observation,
          "runtime_failure",
        ),
      );
    let proposal: { text: string; audience: string[] } | null = null;
    if (draft.routing) {
      try { proposal = parseAudienceProposal(outcome.completion.text, draft); }
      catch { throw new InvalidRuntimeStreamError(outcome.observation); }
    }
    const text = proposal?.text ?? outcome.completion.text;
    const artifact: ActorTurnDraftArtifact = {
      text,
      digest: artifactDigest(text, proposal?.audience),
      ...(proposal ? { proposedAudience: proposal.audience } : {}),
      provenance: completedProvenance(
        adapterIdentity,
        draft,
        outcome.observation,
      ),
    };
    return finishOrCurrent(repository, draft, artifact);
  } catch (error) {
    const observation =
      error instanceof RuntimeStreamError
        ? error.observation
        : emptyObservation();
    const code =
      error instanceof InvalidRuntimeStreamError
        ? "invalid_stream"
        : "runtime_failure";
    return failOrCurrent(
      repository,
      draft,
      failureFor(adapterIdentity, draft, observation, code),
    );
  }
}

type RuntimeObservation = {
  usage: Partial<NormalizedRuntimeUsage>;
  stopReason: RuntimeStopReason | null;
};

type RuntimeStreamOutcome =
  | {
      status: "completed";
      completion: RuntimeCompletion;
      observation: RuntimeObservation;
    }
  | { status: "failed"; observation: RuntimeObservation };

function frozenRuntimeRequest(
  draft: ActorTurnDraftRecord,
): RunActorTurnRequest {
  return deepFreeze(
    structuredClone({
      draftId: draft.id,
      ownerScope: draft.ownerScope,
      simulationId: draft.simulationId,
      branchId: draft.branchId,
      basisHeadCommitId: draft.basisHeadCommitId,
      contentRevisionId: draft.contentRevisionId,
      actorId: draft.actorId,
      audience: draft.audience,
      context: draft.context,
      contextHash: draft.contextHash,
      prompt: draft.prompt,
      promptHash: draft.promptHash,
      runtimeProfile: draft.runtimeProfile,
      promptPolicy: draft.promptPolicy,
      outputSchema: draft.outputSchema,
      skillDigests: draft.skillDigests,
      capabilityGrant: [],
    } satisfies RunActorTurnRequest),
  );
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function validateRuntimeStream(
  runtime: ActorTurnRuntime,
  draft: ActorTurnDraftRecord,
  options: GenerateActorTurnDraftOptions,
): Promise<RuntimeStreamOutcome> {
  let terminal: RuntimeCompletion | "failed" | null = null;
  let deltas = "";
  let eventCount = 0;
  const observation = emptyObservation();
  const request = frozenRuntimeRequest(draft);
  let iterator: AsyncIterator<AgentRuntimeEvent> | null = null;
  try {
    if (options.signal?.aborted) {
      observation.stopReason = "aborted";
      throw new RuntimeFailureError(observation);
    }
    iterator = runtime
      .runActorTurn(request, options.signal)
      [Symbol.asyncIterator]();
    while (true) {
      const next = await nextRuntimeEvent(
        iterator,
        options.signal,
        observation,
      );
      if (next.done) break;
      const event = next.value;
      if (options.signal?.aborted) {
        observation.stopReason = "aborted";
        throw new RuntimeFailureError(observation);
      }
      eventCount++;
      if (eventCount > MAX_RUNTIME_EVENTS)
        throw new InvalidRuntimeStreamError(observation);
      if (!event || typeof event !== "object")
        throw new InvalidRuntimeStreamError(observation);
      if (terminal !== null) throw new InvalidRuntimeStreamError(observation);
      switch (event.type) {
        case "text_delta": {
          const text = event.text;
          if (
            typeof text !== "string" ||
            deltas.length + text.length > MAX_RUNTIME_TEXT_CHARS
          )
            throw new InvalidRuntimeStreamError(observation);
          deltas += text;
          break;
        }
        case "usage": {
          const usage = event.usage;
          mergeUsage(observation, usage);
          break;
        }
        case "completed": {
          const text = event.text;
          const usage = event.usage;
          const stopReason = event.stopReason;
          if (typeof text !== "string" || text.length > MAX_RUNTIME_TEXT_CHARS)
            throw new InvalidRuntimeStreamError(observation);
          mergeUsage(observation, usage);
          observeStopReason(observation, stopReason);
          terminal = { text };
          break;
        }
        case "failed": {
          const usage = event.usage;
          const stopReason = event.stopReason;
          mergeUsage(observation, usage);
          observeStopReason(observation, stopReason);
          terminal = "failed";
          break;
        }
        case "tool_requested":
        case "tool_completed":
          throw new InvalidRuntimeStreamError(observation);
        default:
          return assertNever(event);
      }
    }
  } catch (error) {
    if (error instanceof RuntimeStreamError) throw error;
    throw new RuntimeFailureError(observation);
  } finally {
    if (options.signal?.aborted && iterator) closeRuntimeIterator(iterator);
  }
  if (!terminal) throw new InvalidRuntimeStreamError(observation);
  try {
    normalizeUsage(observation.usage);
  } catch {
    throw new InvalidRuntimeStreamError(observation);
  }
  if (terminal === "failed") return { status: "failed", observation };
  if (
    observation.stopReason === "aborted" ||
    observation.stopReason === "error" ||
    observation.stopReason === "tool_use"
  )
    return { status: "failed", observation };
  if (!terminal.text) throw new InvalidRuntimeStreamError(observation);
  if (deltas && deltas !== terminal.text)
    throw new InvalidRuntimeStreamError(observation);
  return { status: "completed", completion: terminal, observation };
}

async function nextRuntimeEvent(
  iterator: AsyncIterator<AgentRuntimeEvent>,
  signal: AbortSignal | undefined,
  observation: RuntimeObservation,
): Promise<IteratorResult<AgentRuntimeEvent>> {
  if (!signal) return iterator.next();
  if (signal.aborted) {
    observation.stopReason = "aborted";
    throw new RuntimeFailureError(observation);
  }
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      observation.stopReason = "aborted";
      reject(new RuntimeFailureError(observation));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function closeRuntimeIterator(
  iterator: AsyncIterator<AgentRuntimeEvent>,
): void {
  try {
    const closing = iterator.return?.();
    if (closing) void Promise.resolve(closing).catch(() => undefined);
  } catch {
    // Cancellation outcome is already durable; adapter cleanup is best effort.
  }
}

function emptyObservation(): RuntimeObservation {
  return { usage: {}, stopReason: null };
}

function mergeUsage(
  observation: RuntimeObservation,
  update: Partial<NormalizedRuntimeUsage> | undefined,
): void {
  let candidate: Partial<NormalizedRuntimeUsage>;
  try {
    const snapshot = snapshotUsage(update);
    candidate = { ...observation.usage };
    for (const field of [
      "inputTokens",
      "outputTokens",
      "totalTokens",
    ] as const) {
      const next = snapshot?.[field];
      if (next === undefined) continue;
      const prior = candidate[field];
      if (prior !== undefined && prior !== next)
        throw new InvalidRuntimeStreamError(observation);
      candidate[field] = next;
    }
    validateUsageSnapshot(candidate);
  } catch (error) {
    if (error instanceof InvalidRuntimeStreamError)
      throw new InvalidRuntimeStreamError(observation);
    throw error;
  }
  observation.usage = candidate;
}

function snapshotUsage(
  value: unknown,
): Partial<NormalizedRuntimeUsage> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidRuntimeStreamError(emptyObservation());
  const source = value as Record<string, unknown>;
  const snapshot: Partial<NormalizedRuntimeUsage> = {};
  for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const raw = source[field];
    if (raw !== undefined) snapshot[field] = numericUsage(raw);
  }
  return snapshot;
}

function validateUsageSnapshot(usage: Partial<NormalizedRuntimeUsage>): void {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined)
    return;
  const sum = safeTokenSum(usage.inputTokens, usage.outputTokens);
  if (usage.totalTokens !== undefined && usage.totalTokens !== sum)
    throw new InvalidRuntimeStreamError(emptyObservation());
}

function observeStopReason(
  observation: RuntimeObservation,
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  const allowed: readonly RuntimeStopReason[] = [
    "stop",
    "length",
    "tool_use",
    "error",
    "aborted",
    "other",
  ];
  if (
    typeof value !== "string" ||
    !allowed.includes(value as RuntimeStopReason)
  )
    throw new InvalidRuntimeStreamError(observation);
  observation.stopReason = value as RuntimeStopReason;
}

type CapturedRuntimeIdentity = {
  adapter: RuntimeAdapterIdentity;
  providerId: string | null;
  modelId: string | null;
};

function captureRuntimeIdentity(
  runtime: ActorTurnRuntime,
): CapturedRuntimeIdentity {
  try {
    const identity = runtime.identity;
    const id = identity?.id;
    const version = identity?.version;
    const providerId = identity?.providerId;
    const modelId = identity?.modelId;
    return {
      adapter: {
        id: boundedIdentifier(id) || "unknown",
        version: boundedIdentifier(version) || "unknown",
      },
      providerId: boundedIdentifier(providerId),
      modelId: boundedIdentifier(modelId),
    };
  } catch {
    return {
      adapter: { id: "unknown", version: "unknown" },
      providerId: null,
      modelId: null,
    };
  }
}

function completedProvenance(
  adapterIdentity: CapturedRuntimeIdentity,
  draft: ActorTurnDraftRecord,
  observation: RuntimeObservation,
) {
  return {
    ...provenanceBase(adapterIdentity, draft, observation),
    terminalStatus: "completed" as const,
  };
}

function failureFor(
  adapterIdentity: CapturedRuntimeIdentity,
  draft: ActorTurnDraftRecord,
  observation: RuntimeObservation,
  code: ActorTurnDraftFailure["code"],
): ActorTurnDraftFailure {
  return {
    code,
    message:
      code === "invalid_stream"
        ? "Runtime output was invalid."
        : "Runtime generation failed.",
    provenance: {
      ...provenanceBase(adapterIdentity, draft, observation),
      terminalStatus: "failed",
    },
  };
}

function provenanceBase(
  adapterIdentity: CapturedRuntimeIdentity,
  draft: ActorTurnDraftRecord,
  observation: RuntimeObservation,
) {
  return {
    adapter: adapterIdentity.adapter,
    runtimeProfile: {
      id: boundedIdentifier(draft.runtimeProfile.id) || "unknown",
      version: boundedIdentifier(draft.runtimeProfile.version) || "unknown",
    },
    providerId: adapterIdentity.providerId,
    modelId: adapterIdentity.modelId,
    usage: failureSafeUsage(observation.usage),
    stopReason: observation.stopReason,
  };
}

function failureSafeUsage(
  usage: Partial<NormalizedRuntimeUsage>,
): NormalizedRuntimeUsage {
  try {
    const inputTokens = numericUsage(usage.inputTokens);
    const outputTokens = numericUsage(usage.outputTokens);
    return {
      inputTokens,
      outputTokens,
      totalTokens: safeTokenSum(inputTokens, outputTokens),
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
}

function finishOrCurrent(
  repository: DraftLifecycleRepository,
  draft: ActorTurnDraftRecord,
  artifact: ActorTurnDraftArtifact,
): ActorTurnDraftRecord {
  const current = repository.getActorTurnDraft(
    draft.ownerScope,
    draft.simulationId,
    draft.id,
  );
  if (!current) throw new DomainNotFoundError(`Draft not found: ${draft.id}`);
  if (current.status !== "generating") return current;
  return repository.completeActorTurnDraft(
    draft.ownerScope,
    draft.simulationId,
    draft.id,
    artifact,
  );
}

function failOrCurrent(
  repository: DraftLifecycleRepository,
  draft: ActorTurnDraftRecord,
  failure: ActorTurnDraftFailure,
): ActorTurnDraftRecord {
  const current = repository.getActorTurnDraft(
    draft.ownerScope,
    draft.simulationId,
    draft.id,
  );
  if (!current) throw new DomainNotFoundError(`Draft not found: ${draft.id}`);
  if (current.status !== "generating") return current;
  return repository.failActorTurnDraft(
    draft.ownerScope,
    draft.simulationId,
    draft.id,
    failure,
  );
}

function normalizeGenerationCommand(
  command: GenerateActorTurnDraftCommand,
): GenerateActorTurnDraftCommand {
  const payload: GenerateActorTurnDraftPayload = {
    ...structuredClone(command.payload),
    actorId: command.payload.actorId.trim(),
    audience: normalizeAudience(
      command.payload.actorId.trim(),
      command.payload.audience,
    ),
    stageWhisperIds: [...command.payload.stageWhisperIds],
    runtimeProfile: {
      id: requiredSafeIdentifier(
        command.payload.runtimeProfile.id,
        "runtime profile ID",
      ),
      version: requiredSafeIdentifier(
        command.payload.runtimeProfile.version,
        "runtime profile version",
      ),
    },
    promptPolicy: {
      id: requiredSafeIdentifier(
        command.payload.promptPolicy.id,
        "prompt policy ID",
      ),
      version: requiredSafeIdentifier(
        command.payload.promptPolicy.version,
        "prompt policy version",
      ),
    },
    outputSchema: {
      id: requiredSafeIdentifier(
        command.payload.outputSchema.id,
        "output schema ID",
      ),
      digest: requiredSafeIdentifier(
        command.payload.outputSchema.digest,
        "output schema digest",
      ),
    },
    skillDigests: command.payload.skillDigests.map((value) =>
      requiredSafeIdentifier(value, "skill digest"),
    ),
  };
  if (
    !Array.isArray(payload.stageWhisperIds) ||
    !payload.stageWhisperIds.every(
      (id) => typeof id === "string" && id.length > 0,
    )
  )
    throw new DomainValidationError(
      "stageWhisperIds must contain non-empty strings.",
    );
  if (new Set(payload.stageWhisperIds).size !== payload.stageWhisperIds.length)
    throw new DomainValidationError(
      "stageWhisperIds must not contain duplicates.",
    );
  if (
    !Array.isArray(payload.skillDigests) ||
    !payload.skillDigests.every(
      (digest) => typeof digest === "string" && digest.length > 0,
    )
  )
    throw new DomainValidationError(
      "skillDigests must contain non-empty strings.",
    );
  if (new Set(payload.skillDigests).size !== payload.skillDigests.length)
    throw new DomainValidationError(
      "skillDigests must not contain duplicates.",
    );
  for (const value of [
    payload.actorId,
    payload.runtimeProfile.id,
    payload.runtimeProfile.version,
    payload.promptPolicy.id,
    payload.promptPolicy.version,
    payload.outputSchema.id,
    payload.outputSchema.digest,
  ])
    if (!value)
      throw new DomainValidationError("Draft generation input is incomplete.");
  return { ...structuredClone(command), payload };
}

function selectWhispers(
  repository: DraftLifecycleRepository,
  command: GenerateActorTurnDraftCommand,
): StageWhisperRecord[] {
  const pending = repository.listPendingStageWhispers(
    command.ownerScope,
    command.simulationId,
    command.branchId,
    command.expectedHead,
    command.payload.actorId,
  );
  const byId = new Map(pending.map((whisper) => [whisper.id, whisper]));
  return command.payload.stageWhisperIds.map((id) => {
    const whisper = byId.get(id);
    if (!whisper)
      throw new DomainValidationError(`Stage whisper not found: ${id}`);
    return whisper;
  });
}

function normalizeUsage(
  usage: Partial<NormalizedRuntimeUsage>,
): NormalizedRuntimeUsage {
  const inputTokens = numericUsage(usage.inputTokens);
  const outputTokens = numericUsage(usage.outputTokens);
  const sum = safeTokenSum(inputTokens, outputTokens);
  const totalTokens =
    usage.totalTokens === undefined ? sum : numericUsage(usage.totalTokens);
  if (totalTokens !== sum)
    throw new InvalidRuntimeStreamError(emptyObservation());
  return { inputTokens, outputTokens, totalTokens };
}

function safeTokenSum(inputTokens: number, outputTokens: number): number {
  const total = inputTokens + outputTokens;
  if (!Number.isSafeInteger(total))
    throw new InvalidRuntimeStreamError(emptyObservation());
  return total;
}

function numericUsage(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || value < 0 || !Number.isSafeInteger(value))
    throw new InvalidRuntimeStreamError(emptyObservation());
  return value;
}

function boundedIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) return null;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(normalized)) return null;
  if (/^[A-Za-z]:[\\/]/.test(normalized) || /^[\\/]/.test(normalized))
    return null;
  if (!/^@?[A-Za-z0-9][A-Za-z0-9._/+@-]*$/.test(normalized)) return null;
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        credentialShapedSegment(segment),
    )
  )
    return null;
  return normalized;
}

function credentialShapedSegment(value: string): boolean {
  return (
    /^(?:sk[_-](?:(?:proj|live)[_-])?|pk_|rk_|gh[pous]_|xox[baprs]-|AKIA|AIza|ya29\.)/i.test(
      value,
    ) || /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value)
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class RuntimeStreamError extends Error {
  readonly observation: RuntimeObservation;
  constructor(observation: RuntimeObservation) {
    super();
    this.observation = observation;
  }
}
class InvalidRuntimeStreamError extends RuntimeStreamError {}
class RuntimeFailureError extends RuntimeStreamError {}

function assertNever(value: never): never {
  throw new InvalidRuntimeStreamError(emptyObservation());
}
