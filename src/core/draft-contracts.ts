import { createHash } from "node:crypto";
import { domainId } from "./domain-rules.ts";
import { DomainValidationError } from "./ports.ts";
import type {
  AcceptDraftReceipt,
  ActorTurnDraftArtifact,
  ActorTurnDraftFailure,
  ActorTurnDraftRecord,
  DraftRuntimeProvenance,
  DraftRouting,
  DraftRoutingInput,
  NormalizedRuntimeUsage,
  RuntimeStopReason,
} from "./types.ts";

export const MAX_RUNTIME_TEXT_CHARS = 1_000_000;
const MAX_IDENTIFIER_CHARS = 160;
const STOP_REASONS = [
  "stop",
  "length",
  "tool_use",
  "error",
  "aborted",
  "other",
] as const;
const COMPLETED_STOP_REASONS = [null, "stop", "length", "other"] as const;

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** New structured artifacts bind wording and delivery; legacy text digests stay unchanged. */
export function artifactDigest(text: string, proposedAudience?: string[]): string {
  return sha256(proposedAudience === undefined ? text : JSON.stringify({ text, proposedAudience }));
}

export function canonicalDraftContext(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalDraftContext);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          ![
            "sourceRoot",
            "path",
            "folder",
            "createdAt",
            "updatedAt",
            "promptPreview",
          ].includes(key),
      )
      .map(([key, item]) => [key, canonicalDraftContext(item)]),
  );
}

export function requiredSafeIdentifier(value: unknown, label: string): string {
  const normalized = boundedIdentifier(value);
  if (!normalized) throw invalid(`${label} is invalid or credential-shaped.`);
  return normalized;
}

export function boundedIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_IDENTIFIER_CHARS) return null;
  if (
    /^[a-z][a-z\d+.-]*:\/\//i.test(normalized) ||
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    /^[\\/]/.test(normalized)
  )
    return null;
  if (!/^@?[A-Za-z0-9][A-Za-z0-9._/+@-]*$/.test(normalized)) return null;
  if (
    normalized
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          credentialShapedSegment(part),
      )
  )
    return null;
  return normalized;
}

export function assertRuntimeText(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_RUNTIME_TEXT_CHARS
  )
    throw invalid(`${label} is empty or exceeds the runtime limit.`);
}

export function assertSha256(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw invalid(`${label} is not a SHA-256 digest.`);
}

export function assertSafeUsage(
  value: unknown,
  label = "Runtime usage",
): asserts value is NormalizedRuntimeUsage {
  const usage = object(value, label);
  exact(usage, ["inputTokens", "outputTokens", "totalTokens"], label);
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const)
    if (!safeNonnegative(usage[key])) throw invalid(`${label} is invalid.`);
  const inputTokens = usage.inputTokens as number;
  const outputTokens = usage.outputTokens as number;
  const totalTokens = usage.totalTokens as number;
  if (
    totalTokens !== inputTokens + outputTokens ||
    !Number.isSafeInteger(totalTokens)
  )
    throw invalid(`${label} total is invalid.`);
}

export function assertRuntimeStopReason(
  value: unknown,
  label = "Runtime stop reason",
): asserts value is RuntimeStopReason | null {
  if (
    value !== null &&
    (typeof value !== "string" ||
      !STOP_REASONS.includes(value as RuntimeStopReason))
  )
    throw invalid(`${label} is invalid.`);
}

export function assertRuntimeProvenance(
  value: unknown,
  terminal: "completed" | "failed" | null = null,
): asserts value is DraftRuntimeProvenance {
  const provenance = object(value, "Runtime provenance");
  exact(
    provenance,
    [
      "adapter",
      "runtimeProfile",
      "providerId",
      "modelId",
      "usage",
      "stopReason",
      "terminalStatus",
    ],
    "Runtime provenance",
  );
  assertRef(provenance.adapter, "Runtime adapter");
  assertRef(provenance.runtimeProfile, "Runtime profile");
  nullableIdentifier(provenance.providerId, "Runtime provider ID");
  nullableIdentifier(provenance.modelId, "Runtime model ID");
  assertSafeUsage(provenance.usage);
  assertRuntimeStopReason(provenance.stopReason);
  if (
    provenance.terminalStatus !== "completed" &&
    provenance.terminalStatus !== "failed"
  )
    throw invalid("Runtime terminal status is invalid.");
  if (terminal && provenance.terminalStatus !== terminal)
    throw invalid("Runtime terminal status is inconsistent.");
}

export function assertCompletedArtifact(
  value: unknown,
): asserts value is ActorTurnDraftArtifact {
  const artifact = object(value, "Generated artifact");
  exact(artifact, ["text", "digest", "provenance", ...(Object.hasOwn(artifact, "proposedAudience") ? ["proposedAudience"] : [])], "Generated artifact");
  if (Object.hasOwn(artifact, "proposedAudience")) identityArray(artifact.proposedAudience, "Proposed audience");
  assertRuntimeText(artifact.text, "Generated artifact text");
  assertSha256(artifact.digest, "Generated artifact digest");
  if (artifactDigest(artifact.text, artifact.proposedAudience as string[] | undefined) !== artifact.digest)
    throw invalid("Generated artifact digest is invalid.");
  assertRuntimeProvenance(artifact.provenance, "completed");
  if (
    !COMPLETED_STOP_REASONS.includes(
      artifact.provenance.stopReason as (typeof COMPLETED_STOP_REASONS)[number],
    )
  )
    throw invalid("Generated artifact completion stop reason is invalid.");
}

export function decodeActorTurnDraftRecord(
  value: unknown,
): ActorTurnDraftRecord {
  const draft = object(value, "Actor turn draft");
  exact(
    draft,
    [
      "id",
      "ownerScope",
      "simulationId",
      "generationCommandId",
      "branchId",
      "basisHeadCommitId",
      "contentRevisionId",
      "actorId",
      "audience",
      "stageWhispers",
      "runtimeProfile",
      "promptPolicy",
      "outputSchema",
      "skillDigests",
      "capabilityGrant",
      "context",
      "contextHash",
      "prompt",
      "promptHash",
      "status",
      "artifact",
      "failure",
      "createdAt",
      "updatedAt",
      ...(Object.hasOwn(draft, "routing") ? ["routing"] : []),
    ],
    "Actor turn draft",
  );
  const id = requiredSafeIdentifier(draft.id, "Draft id");
  const ownerScope = requiredSafeIdentifier(draft.ownerScope, "Draft ownerScope");
  const simulationId = requiredSafeIdentifier(
    draft.simulationId,
    "Draft simulationId",
  );
  const generationCommandId = requiredSafeIdentifier(
    draft.generationCommandId,
    "Draft generationCommandId",
  );
  for (const key of [
    "branchId",
    "basisHeadCommitId",
    "contentRevisionId",
    "actorId",
  ])
    requiredSafeIdentifier(draft[key], "Draft " + key);
  if (
    id !==
    domainId("actor_turn_draft", ownerScope, simulationId, generationCommandId)
  )
    throw invalid("Draft ID is not bound to its generation identity.");
  stringArray(draft.audience, "Draft audience");
  stringArray(draft.skillDigests, "Draft skill digests");
  unique(draft.audience as string[], "Draft audience");
  unique(draft.skillDigests as string[], "Draft skill digests");
  for (const value of draft.audience as unknown[])
    requiredSafeIdentifier(value, "Draft audience ID");
  for (const value of draft.skillDigests as unknown[])
    requiredSafeIdentifier(value, "Draft skill digest");
  const whispers = array(draft.stageWhispers, "Draft stage whispers");
  const whisperIds: string[] = [];
  for (const value of whispers) {
    const whisper = object(value, "Draft stage whisper");
    exact(whisper, ["id", "text"], "Draft stage whisper");
    whisperIds.push(
      requiredSafeIdentifier(whisper.id, "Draft stage whisper ID"),
    );
    assertRuntimeText(whisper.text, "Draft stage whisper text");
  }
  unique(whisperIds, "Draft stage whispers");
  assertRef(draft.runtimeProfile, "Draft runtime profile");
  assertRef(draft.promptPolicy, "Draft prompt policy");
  const schema = object(draft.outputSchema, "Draft output schema");
  exact(schema, ["id", "digest"], "Draft output schema");
  requiredSafeIdentifier(schema.id, "Draft output schema ID");
  requiredSafeIdentifier(schema.digest, "Draft output schema digest");
  if (!Array.isArray(draft.capabilityGrant) || draft.capabilityGrant.length)
    throw invalid("Draft capability grant is invalid.");
  assertSha256(draft.contextHash, "Draft context hash");
  assertRuntimeText(draft.prompt, "Draft prompt");
  assertSha256(draft.promptHash, "Draft prompt hash");
  if (!validIso(draft.createdAt) || !validIso(draft.updatedAt))
    throw invalid("Draft timestamps are invalid.");
  const status = draft.status;
  if (
    !["generating", "ready", "failed", "discarded", "accepted"].includes(
      String(status),
    )
  )
    throw invalid("Draft status is invalid.");
  validateDraftState(
    status as ActorTurnDraftRecord["status"],
    draft.artifact,
    draft.failure,
  );
  validateRoutingBinding(draft as unknown as ActorTurnDraftRecord);
  return structuredClone(draft) as ActorTurnDraftRecord;
}

export function decodeAcceptDraftReceipt(value: unknown): AcceptDraftReceipt {
  const receipt = object(value, "Accept draft receipt");
  exact(
    receipt,
    [
      "receiptVersion",
      "draftId",
      "generationCommandId",
      "contentRevisionId",
      "actorId",
      "audience",
      "stageWhispers",
      "runtimeProfile",
      "promptPolicy",
      "outputSchema",
      "skillDigests",
      "capabilityGrant",
      "contextHash",
      "promptHash",
      "generatedArtifact",
      "accepted",
      ...(Object.hasOwn(receipt, "routing") ? ["routing"] : []),
    ],
    "Accept draft receipt",
  );
  if ((receipt.receiptVersion !== 1 && receipt.receiptVersion !== 2) ||
      (receipt.receiptVersion === 2) !== Object.hasOwn(receipt, "routing"))
    throw invalid("Accept draft receipt version is invalid.");
  for (const key of [
    "draftId",
    "generationCommandId",
    "contentRevisionId",
    "actorId",
  ])
    requiredSafeIdentifier(receipt[key], `Accept draft ${key}`);
  stringArray(receipt.audience, "Accept draft audience");
  stringArray(receipt.skillDigests, "Accept draft skill digests");
  unique(receipt.audience as string[], "Accept draft audience");
  unique(receipt.skillDigests as string[], "Accept draft skill digests");
  for (const value of receipt.audience as unknown[])
    requiredSafeIdentifier(value, "Accept draft audience ID");
  for (const value of receipt.skillDigests as unknown[])
    requiredSafeIdentifier(value, "Accept draft skill digest");
  const whisperIds: string[] = [];
  for (const value of array(receipt.stageWhispers, "Accept draft whispers")) {
    const whisper = object(value, "Accept draft whisper");
    exact(whisper, ["id", "text"], "Accept draft whisper");
    whisperIds.push(
      requiredSafeIdentifier(whisper.id, "Accept draft whisper ID"),
    );
    assertRuntimeText(whisper.text, "Accept draft whisper text");
  }
  unique(whisperIds, "Accept draft whispers");
  assertRef(receipt.runtimeProfile, "Accept draft runtime profile");
  assertRef(receipt.promptPolicy, "Accept draft prompt policy");
  const schema = object(receipt.outputSchema, "Accept draft output schema");
  exact(schema, ["id", "digest"], "Accept draft output schema");
  requiredSafeIdentifier(schema.id, "Accept draft output schema ID");
  requiredSafeIdentifier(schema.digest, "Accept draft output schema digest");
  if (!Array.isArray(receipt.capabilityGrant) || receipt.capabilityGrant.length)
    throw invalid("Accept draft capability grant is invalid.");
  assertSha256(receipt.contextHash, "Accept draft context hash");
  assertSha256(receipt.promptHash, "Accept draft prompt hash");
  assertCompletedArtifact(receipt.generatedArtifact);
  const accepted = object(receipt.accepted, "Accept draft accepted text");
  if (accepted.textSource === "generated_verbatim" || accepted.textSource === "director_preserved")
    exact(accepted, ["textSource"], "Accept draft accepted text");
  else if (accepted.textSource === "acceptor_edited") {
    exact(accepted, ["textSource", "text"], "Accept draft accepted text");
    assertRuntimeText(accepted.text, "Accept draft edited text");
  } else throw invalid("Accept draft text source is invalid.");
  if (accepted.textSource !== "acceptor_edited" &&
      (accepted.textSource === "director_preserved") !== ((receipt.routing as DraftRouting | undefined)?.preservedText != null))
    throw invalid("Accepted text attribution contradicts derivation.");
  validateRoutingBinding({ ...receipt, id: receipt.draftId, artifact: receipt.generatedArtifact } as unknown as ActorTurnDraftRecord, true);
  return structuredClone(receipt) as AcceptDraftReceipt;
}

function validateDraftState(
  status: ActorTurnDraftRecord["status"],
  artifact: unknown,
  failure: unknown,
): void {
  if (status === "generating") {
    if (artifact !== null || failure !== null)
      throw invalid("Generating draft state is invalid.");
    return;
  }
  if (status === "ready" || status === "accepted") {
    assertCompletedArtifact(artifact);
    if (failure !== null)
      throw invalid("Ready draft failure state is invalid.");
    return;
  }
  if (status === "failed") {
    if (artifact !== null)
      throw invalid("Failed draft artifact state is invalid.");
    assertFailure(failure);
    return;
  }
  if (artifact !== null) assertCompletedArtifact(artifact);
  if (failure !== null) assertFailure(failure);
  if (artifact !== null && failure !== null)
    throw invalid("Discarded draft state is invalid.");
}
function assertFailure(value: unknown): asserts value is ActorTurnDraftFailure {
  const failure = object(value, "Draft failure");
  exact(failure, ["code", "message", "provenance"], "Draft failure");
  if (failure.code !== "runtime_failure" && failure.code !== "invalid_stream")
    throw invalid("Draft failure code is invalid.");
  assertRuntimeText(failure.message, "Draft failure message");
  assertRuntimeProvenance(failure.provenance, "failed");
}
function assertRef(value: unknown, label: string): void {
  const ref = object(value, label);
  exact(ref, ["id", "version"], label);
  requiredSafeIdentifier(ref.id, `${label} ID`);
  requiredSafeIdentifier(ref.version, `${label} version`);
}
function nullableIdentifier(value: unknown, label: string): void {
  if (value !== null) requiredSafeIdentifier(value, label);
}
function safeNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid(`${label} is invalid.`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalid(`${label} is invalid.`);
  return value;
}
function stringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw invalid(`${label} is invalid.`);
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw invalid(`${label} contains duplicates.`);
}
function exact(
  value: Record<string, unknown>,
  keys: string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    throw invalid(`${label} has unexpected fields.`);
}
function validIso(value: unknown): boolean {
  if (typeof value !== "string" || value.length !== 24) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
function credentialShapedSegment(value: string): boolean {
  return (
    /^(?:sk[_-](?:(?:proj|live)[_-])?|pk_|rk_|gh[pous]_|xox[baprs]-|AKIA|AIza|ya29\.)/i.test(
      value,
    ) || /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value)
  );
}
function invalid(message: string): DomainValidationError {
  return new DomainValidationError(message);
}

export function validateRoutingInput(value: unknown): asserts value is DraftRoutingInput {
  const input = object(value, "Routing input");
  exact(input, ["version", "initialAudience", "correction", "correctedAudience", "preservedText", "sourceDraftId", ...(input.version === 2 ? ["completeWhisper"] : [])], "Routing input");
  if (input.version !== 1 && input.version !== 2) throw invalid("Unsupported routing version.");
  if (input.version === 2 && (typeof input.completeWhisper !== "string" || input.completeWhisper.length > MAX_RUNTIME_TEXT_CHARS || input.correction !== ""))
    throw invalid("Complete whisper required without additive correction.");
  for (const key of ["initialAudience", "correctedAudience"])
    if (input[key] !== null) identityArray(input[key], key);
  if (typeof input.correction !== "string" || input.correction.length > MAX_RUNTIME_TEXT_CHARS)
    throw invalid("Invalid director correction.");
  if (input.sourceDraftId !== null) requiredSafeIdentifier(input.sourceDraftId, "Source draft");
  if (input.preservedText !== null) assertRuntimeText(input.preservedText, "Preserved text");
  if (input.sourceDraftId === null && (input.correctedAudience !== null || input.preservedText !== null || input.correction !== ""))
    throw invalid("Corrections require a source candidate.");
  if (input.sourceDraftId !== null && input.correctedAudience === null && (input.version === 1 || input.preservedText !== null))
    throw invalid("Correction requires explicit recipients.");
}

export function validateRoutingBinding(draft: ActorTurnDraftRecord, receipt = false): void {
  if (!draft.routing) {
    if (draft.promptPolicy.id === "audience-proposal-v1" || draft.outputSchema.id === "audience-proposal")
      throw invalid("Routing policy requires routing ancestry.");
    if (draft.artifact?.proposedAudience !== undefined)
      throw invalid("Audience proposal requires routing policy.");
    return;
  }
  const routing = object(draft.routing, "Routing");
  exact(routing, ["version", "initialAudience", "correction", "correctedAudience", "preservedText", "sourceDraftId",
    "availableRecipientIds", "originalDraftId", "originalGenerationCommandId", "source", ...(routing.version === 2 ? ["completeWhisper"] : [])], "Routing");
  const { version, initialAudience, correction, correctedAudience, preservedText, sourceDraftId } = routing;
  validateRoutingInput({ version, initialAudience, correction, correctedAudience, preservedText, sourceDraftId,
    ...(version === 2 ? { completeWhisper: routing.completeWhisper } : {}) });
  identityArray(routing.availableRecipientIds, "Available recipients");
  requiredSafeIdentifier(routing.originalDraftId, "Original draft ID");
  requiredSafeIdentifier(routing.originalGenerationCommandId, "Original generation ID");
  const typed = routing as unknown as DraftRouting;
  if (!receipt && typed.originalDraftId !== domainId("actor_turn_draft", draft.ownerScope, draft.simulationId, typed.originalGenerationCommandId))
    throw invalid("Original routing identity mismatch.");
  if (!receipt && JSON.stringify(draft.audience) !== JSON.stringify([...new Set([draft.actorId,
      ...(typed.correctedAudience ?? typed.initialAudience ?? [])])]))
    throw invalid("Draft direction audience mismatch.");
  if (!typed.availableRecipientIds.includes(draft.actorId)) throw invalid("Actor missing from available identities.");
  for (const id of typed.version === 2 ? (typed.correctedAudience ?? typed.initialAudience ?? []) : [...(typed.initialAudience || []), ...(typed.correctedAudience || [])])
    if (!typed.availableRecipientIds.includes(id)) throw invalid("Directed identity is unavailable.");
  if (draft.promptPolicy.id !== "audience-proposal-v1" || draft.promptPolicy.version !== "v1" ||
      draft.outputSchema.id !== "audience-proposal" || draft.outputSchema.digest !== "v1")
    throw invalid("Routing policy/schema mismatch.");
  if (typed.sourceDraftId === null) {
    if (typed.source !== null || typed.originalDraftId !== draft.id || typed.originalGenerationCommandId !== draft.generationCommandId)
      throw invalid("Original candidate identity mismatch.");
  } else {
    if (typed.originalDraftId === draft.id || typed.originalGenerationCommandId === draft.generationCommandId)
      throw invalid("Sourced candidate cannot be its own original routing ancestor.");
    const source = object(typed.source, "Routing source");
    exact(source, ["draftId", "generationCommandId", "actorId", "branchId", "basisHeadCommitId", "contentRevisionId",
      "audience", "artifact", "contextHash", "promptHash"], "Routing source");
    for (const key of ["draftId", "generationCommandId", "actorId", "branchId", "basisHeadCommitId", "contentRevisionId"])
      requiredSafeIdentifier(source[key], `Source ${key}`);
    identityArray(source.audience, "Source audience");
    if (source.audience[0] !== draft.actorId) throw invalid("Source audience must include its actor first.");
    assertCompletedArtifact(source.artifact);
    assertSha256(source.contextHash, "Source context hash");
    assertSha256(source.promptHash, "Source prompt hash");
    if (!receipt && source.draftId !== domainId("actor_turn_draft", draft.ownerScope, draft.simulationId, String(source.generationCommandId)))
      throw invalid("Source generation identity mismatch.");
    if (source.draftId !== typed.sourceDraftId || source.draftId === draft.id || source.generationCommandId === draft.generationCommandId ||
        (source.draftId === typed.originalDraftId) !== (source.generationCommandId === typed.originalGenerationCommandId) || source.actorId !== draft.actorId ||
        source.contentRevisionId !== draft.contentRevisionId || (!receipt &&
          (source.branchId !== draft.branchId || source.basisHeadCommitId !== draft.basisHeadCommitId)))
      throw invalid("Routing source basis mismatch.");
    if (JSON.stringify((source.artifact as ActorTurnDraftArtifact).proposedAudience) !== JSON.stringify(source.audience))
      throw invalid("Source artifact audience mismatch.");
  }
  if (draft.artifact) {
    const proposed = draft.artifact.proposedAudience;
    if (!proposed || proposed[0] !== draft.actorId || proposed.some(id => !typed.availableRecipientIds.includes(id)))
      throw invalid("Invalid proposed recipient binding.");
    if (typed.correctedAudience && !sameIdentities(proposed, [draft.actorId, ...typed.correctedAudience]))
      throw invalid("Artifact contradicts director recipients.");
    if (receipt && JSON.stringify(proposed) !== JSON.stringify(draft.audience))
      throw invalid("Receipt audience differs from proposal.");
    if (typed.preservedText !== null) {
      const p = draft.artifact.provenance;
      if (draft.artifact.text !== typed.preservedText || p.adapter.id !== "director-preserved" || p.adapter.version !== "v1" ||
          p.providerId !== null || p.modelId !== null || p.usage.totalTokens !== 0 || p.stopReason !== "stop")
        throw invalid("Invalid director-preserved artifact provenance.");
    } else if (draft.artifact.provenance.adapter.id === "director-preserved")
      throw invalid("Preserved provenance requires explicit director wording.");
  }
}

function identityArray(value: unknown, label: string): asserts value is string[] {
  stringArray(value, label);
  unique(value, label);
  for (const id of value) if (requiredSafeIdentifier(id, label) !== id) throw invalid(`${label} is not normalized.`);
}
function sameIdentities(left: string[], right: string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}
