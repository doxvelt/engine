import { createHash } from "node:crypto";
import { DomainValidationError } from "./ports.ts";
import type {
  AcceptDraftReceipt,
  ActorTurnDraftArtifact,
  ActorTurnDraftFailure,
  ActorTurnDraftRecord,
  DraftRuntimeProvenance,
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

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

export function assertGeneratedArtifact(
  value: unknown,
  terminal: "completed" | "failed" = "completed",
): asserts value is ActorTurnDraftArtifact {
  const artifact = object(value, "Generated artifact");
  exact(artifact, ["text", "digest", "provenance"], "Generated artifact");
  assertRuntimeText(artifact.text, "Generated artifact text");
  assertSha256(artifact.digest, "Generated artifact digest");
  if (sha256(artifact.text) !== artifact.digest)
    throw invalid("Generated artifact digest is invalid.");
  assertRuntimeProvenance(artifact.provenance, terminal);
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
    ],
    "Actor turn draft",
  );
  for (const key of [
    "id",
    "ownerScope",
    "simulationId",
    "generationCommandId",
    "branchId",
    "basisHeadCommitId",
    "contentRevisionId",
    "actorId",
  ])
    requiredSafeIdentifier(draft[key], `Draft ${key}`);
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
    ],
    "Accept draft receipt",
  );
  if (receipt.receiptVersion !== 1)
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
  assertGeneratedArtifact(receipt.generatedArtifact, "completed");
  const accepted = object(receipt.accepted, "Accept draft accepted text");
  if (accepted.textSource === "generated_verbatim")
    exact(accepted, ["textSource"], "Accept draft accepted text");
  else if (accepted.textSource === "acceptor_edited") {
    exact(accepted, ["textSource", "text"], "Accept draft accepted text");
    assertRuntimeText(accepted.text, "Accept draft edited text");
  } else throw invalid("Accept draft text source is invalid.");
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
    assertGeneratedArtifact(artifact);
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
  if (artifact !== null) assertGeneratedArtifact(artifact);
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
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  );
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
