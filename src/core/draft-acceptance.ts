import { finalDraftAudience, prepareRouting, projectRoutingContext, routingInput } from "./candidate-routing.ts";
import {
  assertCompletedArtifact,
  assertRuntimeText,
  canonicalDraftContext,
  decodeActorTurnDraftRecord,
  sha256,
} from "./draft-contracts.ts";
import { inspectActorContext, projectBranch } from "./branch-kernel.ts";
import {
  buildStageWhisperEvents,
  canOwnTurn,
  domainId,
  fingerprintCommand,
  normalizeAudience,
  recordCommand,
  stableStringify,
  deriveFirstImpressionEvents,
} from "./domain-rules.ts";
import {
  BranchConflictError,
  DomainNotFoundError,
  DomainValidationError,
  type AcceptActorTurnDraftCommand,
  type ActorTurnDraftRepository,
  type RecordedCommand,
  type SimulationRepository,
} from "./ports.ts";
import type {
  AcceptDraftReceipt,
  ActorTurnDraftRecord,
  CommitRecord,
  MessageVersionRecord,
  RuntimeEvent,
  StageWhisperRecord,
} from "./types.ts";

type AcceptanceRepository = SimulationRepository & ActorTurnDraftRepository;

export function acceptActorTurnDraft(
  repository: AcceptanceRepository,
  request: AcceptActorTurnDraftCommand,
): {
  branch: import("./types.ts").BranchRecord;
  commit: CommitRecord;
  replayed: boolean;
} {
  // This must stay before every draft or branch lookup: imported history has no
  // operational draft rows, while its recorded command result remains canonical.
  const replay = repository.replayAcceptedActorTurnDraft(request);
  if (replay) return { ...replay, replayed: true };

  let validated: ReturnType<typeof validateReadyDraft>;
  try {
    const draft = repository.getActorTurnDraft(
      request.ownerScope,
      request.simulationId,
      request.draftId,
    );
    if (!draft)
      throw new DomainNotFoundError(`Draft not found: ${request.draftId}`);
    validated = validateReadyDraft(repository, request, draft);
  } catch (error) {
    // A concurrent acceptance may have committed since the initial lookup.
    // Only an authoritative, matching receipt can supersede a preflight error.
    const concurrentReplay = repository.replayAcceptedActorTurnDraft(request);
    if (concurrentReplay) return { ...concurrentReplay, replayed: true };
    throw error;
  }
  const receipt = receiptFor(validated.draft, validated.acceptedText);
  const recorded = recordCommand("accept_draft", {
    ownerScope: request.ownerScope,
    simulationId: request.simulationId,
    branchId: validated.draft.branchId,
    expectedHead: validated.draft.basisHeadCommitId,
    commandId: request.commandId,
    payload: receipt,
  });
  return repository.acceptActorTurnDraft({
    request,
    commandInput: recorded,
    commandFingerprint: fingerprintCommand(recorded),
    createdAt: new Date().toISOString(),
  });
}

export function acceptedTextFromReceipt(receipt: AcceptDraftReceipt): string {
  return receipt.accepted.textSource === "acceptor_edited"
    ? receipt.accepted.text
    : receipt.generatedArtifact.text;
}

export function receiptFor(
  draft: ActorTurnDraftRecord,
  acceptedText: string,
): AcceptDraftReceipt {
  const generatedArtifact = structuredClone(draft.artifact);
  if (!generatedArtifact)
    throw new DomainValidationError("Ready draft has no generated artifact.");
  return {
    receiptVersion: draft.routing ? 2 : 1,
    ...(draft.routing ? { routing: structuredClone(draft.routing) } : {}),
    draftId: draft.id,
    generationCommandId: draft.generationCommandId,
    contentRevisionId: draft.contentRevisionId,
    actorId: draft.actorId,
    audience: [...finalDraftAudience(draft)],
    stageWhispers: draft.stageWhispers.map((whisper) => ({ ...whisper })),
    runtimeProfile: { ...draft.runtimeProfile },
    promptPolicy: { ...draft.promptPolicy },
    outputSchema: { ...draft.outputSchema },
    skillDigests: [...draft.skillDigests],
    capabilityGrant: [],
    contextHash: draft.contextHash,
    promptHash: draft.promptHash,
    generatedArtifact,
    accepted:
      acceptedText === generatedArtifact.text
        ? { textSource: draft.routing?.preservedText != null ? "director_preserved" : "generated_verbatim" }
        : { textSource: "acceptor_edited", text: acceptedText },
  };
}

export function validateReadyDraft(
  repository: AcceptanceRepository,
  request: AcceptActorTurnDraftCommand,
  draft: ActorTurnDraftRecord,
): {
  draft: ActorTurnDraftRecord;
  acceptedText: string;
  whispers: StageWhisperRecord[];
} {
  draft = decodeActorTurnDraftRecord(draft);
  if (
    draft.ownerScope !== request.ownerScope ||
    draft.simulationId !== request.simulationId ||
    draft.id !== request.draftId
  )
    throw new DomainValidationError(
      "Draft identity does not match acceptance request.",
    );
  if (draft.status !== "ready")
    throw new DomainValidationError(`Draft is not ready: ${draft.id}`);
  if (!draft.artifact || draft.failure)
    throw new DomainValidationError("Ready draft artifact state is invalid.");
  const artifact = draft.artifact;
  assertCompletedArtifact(artifact);
  const acceptedText =
    request.finalText === undefined ? artifact.text : request.finalText;
  assertRuntimeText(acceptedText, "Accepted text");
  if (!same(draft.runtimeProfile, artifact.provenance.runtimeProfile))
    throw new DomainValidationError(
      "Draft runtime profile provenance is invalid.",
    );
  if (!Array.isArray(draft.capabilityGrant) || draft.capabilityGrant.length)
    throw new DomainValidationError("Draft capability grant is invalid.");
  if (
    hasDuplicates(draft.audience) ||
    hasDuplicates(draft.skillDigests) ||
    hasDuplicates(draft.stageWhispers.map((item) => item.id))
  )
    throw new DomainValidationError(
      "Draft frozen arrays must not contain duplicates.",
    );
  if (!same(draft.audience, normalizeAudience(draft.actorId, draft.audience)))
    throw new DomainValidationError("Draft audience is not normalized.");

  const simulation = repository.getSimulation(
    request.ownerScope,
    request.simulationId,
  );
  if (!simulation)
    throw new DomainNotFoundError(
      `Simulation not found: ${request.simulationId}`,
    );
  if (simulation.contentRevisionId !== draft.contentRevisionId)
    throw new DomainValidationError(
      "Draft content revision does not match simulation.",
    );
  const branch = repository.getBranch(
    request.ownerScope,
    request.simulationId,
    draft.branchId,
  );
  if (!branch)
    throw new DomainNotFoundError(`Branch not found: ${draft.branchId}`);
  if (branch.headCommitId !== draft.basisHeadCommitId)
    throw new BranchConflictError(draft.basisHeadCommitId, branch.headCommitId);
  const revision = repository.getContentRevision(
    request.ownerScope,
    draft.contentRevisionId,
  );
  if (!revision) throw new DomainNotFoundError("Content revision not found.");
  const actor = revision.compiled.entities.find(
    (entity) => entity.id === draft.actorId,
  );
  if (!actor || !canOwnTurn(actor))
    throw new DomainNotFoundError(`Actor not found: ${draft.actorId}`);
  for (const audienceId of draft.audience) {
    const audienceActor = revision.compiled.entities.find(
      (entity) => entity.id === audienceId,
    );
    if (!audienceActor || !canOwnTurn(audienceActor))
      throw new DomainNotFoundError(`Actor not found: ${audienceId}`);
  }
  const pending = repository.listPendingStageWhispers(
    request.ownerScope,
    request.simulationId,
    draft.branchId,
    draft.basisHeadCommitId,
    draft.actorId,
  );
  const byId = new Map(pending.map((whisper) => [whisper.id, whisper]));
  const whispers = draft.stageWhispers.map((snapshot) => {
    const whisper = byId.get(snapshot.id);
    if (
      !whisper ||
      whisper.text !== snapshot.text ||
      whisper.ownerScope !== draft.ownerScope ||
      whisper.simulationId !== draft.simulationId ||
      whisper.branchId !== draft.branchId ||
      whisper.expectedHead !== draft.basisHeadCommitId ||
      whisper.targetActorId !== draft.actorId
    )
      throw new DomainValidationError(
        `Frozen stage whisper is invalid: ${snapshot.id}`,
      );
    return whisper;
  });
  const context = draft.routing ? null : inspectActorContext(repository, {
    ownerScope: draft.ownerScope,
    simulationId: draft.simulationId,
    branchId: draft.branchId,
    head: draft.basisHeadCommitId,
    actorId: draft.actorId,
    audience: draft.audience,
    stageWhispers: whispers,
  });
  // Saved candidates without correctionSource retain their original frozen
  // prompt/context interpretation, including pre-fix routed corrections.
  const routed = draft.routing ? projectRoutingContext(repository, {
    ownerScope: draft.ownerScope, simulationId: draft.simulationId, branchId: draft.branchId,
    expectedHead: draft.basisHeadCommitId, commandId: draft.generationCommandId,
    payload: { actorId: draft.actorId, audience: draft.audience, stageWhisperIds: draft.stageWhispers.map(item => item.id),
      runtimeProfile: draft.runtimeProfile, promptPolicy: draft.promptPolicy, outputSchema: draft.outputSchema,
      skillDigests: draft.skillDigests, routing: routingInput(draft.routing) },
  }, whispers, draft.context && typeof draft.context === "object" && "correctionSource" in draft.context
    ? draft.routing.source : null) : null;
  if (routed && !same(prepareRouting(repository, {
    ownerScope: draft.ownerScope, simulationId: draft.simulationId, branchId: draft.branchId,
    expectedHead: draft.basisHeadCommitId, commandId: draft.generationCommandId,
    payload: { actorId: draft.actorId, audience: draft.audience, stageWhisperIds: draft.stageWhispers.map(item => item.id),
      runtimeProfile: draft.runtimeProfile, promptPolicy: draft.promptPolicy, outputSchema: draft.outputSchema,
      skillDigests: draft.skillDigests, routing: routingInput(draft.routing!) },
  }, routed.availableRecipientIds), draft.routing))
    throw new DomainValidationError("Source candidate provenance changed.");
  if (routed && !same(routed.availableRecipientIds, draft.routing!.availableRecipientIds))
    throw new DomainValidationError("Available recipient projection changed.");
  const portableContext = routed ? routed.context : canonicalDraftContext(context);
  const prompt = routed ? routed.prompt : context!.promptPreview;
  if (
    sha256(stableStringify(portableContext)) !== draft.contextHash ||
    !same(portableContext, draft.context)
  )
    throw new DomainValidationError("Draft context hash is invalid.");
  if (
    sha256(prompt) !== draft.promptHash ||
    prompt !== draft.prompt
  )
    throw new DomainValidationError("Draft prompt hash is invalid.");
  return { draft, acceptedText, whispers };
}

export function buildAcceptedCommit(
  repository: AcceptanceRepository,
  draft: ActorTurnDraftRecord,
  receipt: AcceptDraftReceipt,
  commandId: string,
  createdAt: string,
): CommitRecord {
  const text = acceptedTextFromReceipt(receipt);
  const message: MessageVersionRecord = {
    id: domainId(
      "message_version",
      draft.ownerScope,
      draft.simulationId,
      commandId,
    ),
    logicalMessageId: domainId(
      "message",
      draft.ownerScope,
      draft.simulationId,
      commandId,
    ),
    actorId: draft.actorId,
    text,
    audience: [...finalDraftAudience(draft)],
    provenance: {
      mode: "generated",
      operation: "turn",
      sourceArtifactDigest: receipt.generatedArtifact.digest,
      finalTextSource: receipt.accepted.textSource,
    },
  };
  const projection = projectBranch(repository, {
    ownerScope: draft.ownerScope,
    simulationId: draft.simulationId,
    branchId: draft.branchId,
    head: draft.basisHeadCommitId,
  });
  const revision = repository.getContentRevision(
    draft.ownerScope,
    draft.contentRevisionId,
  )!;
  const events: RuntimeEvent[] = [{ type: "message_accepted", message }];
  if (draft.routing?.version !== 3 && draft.routing?.version !== 4) events.push(
    ...deriveFirstImpressionEvents({
      audience: finalDraftAudience(draft),
      surfaces: revision.compiled.surfaces,
      existing: projection.firstImpressions,
    }),
  );
  events.push(
    ...buildStageWhisperEvents({
      ownerScope: draft.ownerScope,
      simulationId: draft.simulationId,
      commandId,
      actorId: draft.actorId,
      selected: receipt.stageWhispers.map((snapshot) => ({
        ...snapshot,
        ownerScope: draft.ownerScope,
        simulationId: draft.simulationId,
        branchId: draft.branchId,
        expectedHead: draft.basisHeadCommitId,
        commandId: "",
        targetActorId: draft.actorId,
        createdAt: "",
      })),
    }),
  );
  return {
    id: domainId("commit", draft.ownerScope, draft.simulationId, commandId),
    ownerScope: draft.ownerScope,
    simulationId: draft.simulationId,
    parentCommitId: draft.basisHeadCommitId,
    kind: "turn",
    commandId,
    events,
    createdAt,
  };
}

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}
function same(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}
