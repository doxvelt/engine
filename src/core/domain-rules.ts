import { ACTOR_KNOWLEDGE_POLICY } from "./types.ts";
import { canOwnTurn } from "./turn-ownership.ts";
import { createHash } from "node:crypto";
import type {
  RecordedCommand,
  RecordedOutcome,
} from "./ports.ts";
import type {
  BranchRecord,
  EntityRecord,
  MessageVersionRecord,
  RuntimeEvent,
  StageWhisperRecord,
  SurfaceRecord,
} from "./types.ts";
import { DomainValidationError } from "./ports.ts";

export function domainId(kind: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 32);
  return `${kind}_${digest}`;
}

export function fingerprintCommand(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value))
    .digest("hex");
}

export function recordCommand<TKind extends RecordedCommand["kind"]>(
  kind: TKind,
  input: Record<string, unknown>,
): Extract<RecordedCommand, { kind: TKind }> {
  const command = structuredClone({ ...input, kind }) as Record<string, unknown>;
  if (["turn", "edit", "regenerate"].includes(kind)) {
    const payload = command.payload as Record<string, unknown>;
    if (Object.hasOwn(payload, "knowledgePolicy") &&
        (kind !== "turn" || payload.knowledgePolicy !== ACTOR_KNOWLEDGE_POLICY))
      throw new DomainValidationError("Unsupported manual knowledge policy.");
    delete payload.logicalMessageId;
    delete payload.operation;
    payload.text = (payload.text as string).trim();
    payload.audience = normalizeAudience(
      payload.actorId as string,
      payload.audience as string[],
    );
    normalizeEffectPayload(payload);
  } else if (kind === "effects") {
    normalizeEffectPayload(command.payload as Record<string, unknown>);
  } else if (kind === "closure") {
    const payload = command.payload as Record<string, unknown>;
    if (typeof payload.label === "string")
      payload.label = payload.label.trim() || null;
  } else if (kind === "whisper") {
    command.text = (command.text as string).trim();
  }
  return command as Extract<RecordedCommand, { kind: TKind }>;
}

function normalizeEffectPayload(payload: Record<string, unknown>): void {
  for (const field of ["audienceChanges", "accessChanges"])
    if (Array.isArray(payload[field]))
      payload[field] = (payload[field] as Array<Record<string, unknown>>).map(
        (change) => ({ ...change, reason: change.reason || null }),
      );
  if (typeof payload.stageWhisper === "string")
    payload.stageWhisper = payload.stageWhisper.trim() || null;
}

export function recordStartOutcome(
  outcome: Omit<Extract<RecordedOutcome, { kind: "start" }>, "kind">,
): Extract<RecordedOutcome, { kind: "start" }> {
  return { kind: "start", ...outcome };
}

export function recordCommitOutcome(
  outcome: Omit<Extract<RecordedOutcome, { kind: "commit" }>, "kind">,
): Extract<RecordedOutcome, { kind: "commit" }> {
  return { kind: "commit", ...outcome };
}

export function recordBranchOutcome(
  branch: BranchRecord,
): Extract<RecordedOutcome, { kind: "branch" }> {
  return { kind: "branch", branch };
}

export function recordWhisperOutcome(
  whisper: StageWhisperRecord,
): Extract<RecordedOutcome, { kind: "whisper" }> {
  return { kind: "whisper", whisper };
}

export function unwrapRecordedOutcome(outcome: RecordedOutcome): unknown {
  if (outcome.kind === "start") {
    const { kind: _, ...value } = outcome;
    return value;
  }
  if (outcome.kind === "commit")
    return { branch: outcome.branch, commit: outcome.commit };
  if (outcome.kind === "branch") return { branch: outcome.branch };
  return outcome.whisper;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  return value;
}

export { canOwnTurn } from "./turn-ownership.ts";

export function canHoldEpisodeMemory(entity: EntityRecord): boolean {
  return entity.kind === "agent";
}

export function resolveTurnActor(
  entities: EntityRecord[],
  actorId: string,
): EntityRecord | null {
  const entity = entities.find((item) => item.id === actorId);
  return entity && canOwnTurn(entity) ? entity : null;
}

export function normalizeAudience(actorId: string, audience: string[]): string[] {
  return [...new Set([actorId, ...audience])];
}

export type AudienceChange = {
  actorId: string;
  action: "add" | "remove" | "deactivate" | "reactivate";
  reason?: string | null;
};

export function buildAudienceEvents(
  changes: AudienceChange[] = [],
): RuntimeEvent[] {
  return changes.map((change) => ({
    type: "audience_changed",
    actorId: change.actorId,
    action: change.action,
    reason: change.reason || null,
  }));
}

export function buildAccessEvents(
  changes: Array<{
    action: "grant" | "revoke";
    member: string;
    container: string;
    reason?: string | null;
  }> = [],
): RuntimeEvent[] {
  return changes.map((change) => ({
    type: "access_changed",
    action: change.action,
    member: change.member,
    container: change.container,
    mode: "member",
    reason: change.reason || null,
  }));
}

export function buildManualMessage(input: {
  ownerScope: string;
  simulationId: string;
  commandId: string;
  actorId: string;
  text: string;
  audience: string[];
  logicalMessageId?: string | undefined;
  operation?: "turn" | "edit" | "regenerate" | undefined;
}): MessageVersionRecord {
  const text = input.text.trim();
  if (!text) throw new DomainValidationError("Turn text is empty.");
  return {
    id: domainId(
      "message_version",
      input.ownerScope,
      input.simulationId,
      input.commandId,
    ),
    logicalMessageId:
      input.logicalMessageId ||
      domainId("message", input.ownerScope, input.simulationId, input.commandId),
    actorId: input.actorId,
    text,
    audience: normalizeAudience(input.actorId, input.audience),
    provenance: { mode: "manual", operation: input.operation || "turn" },
  };
}

export function deriveFirstImpressionEvents(input: {
  audience: string[];
  surfaces: SurfaceRecord[];
  existing: Array<{ observerId: string; entityId: string }>;
}): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const observerId of input.audience)
    for (const entityId of input.audience) {
      if (
        observerId === entityId ||
        input.existing.some(
          (item) => item.observerId === observerId && item.entityId === entityId,
        )
      ) continue;
      const surface = input.surfaces.find((item) => item.entity === entityId);
      if (!surface) continue;
      events.push({
        type: "first_impression_formed",
        impression: {
          holder: observerId,
          observerId,
          entityId,
          strength: 1,
          propositionText:
            `@${observerId} forms a first impression that ${surface.text}`,
          surfaceSourceSpan: surface.sourceSpan,
        },
      });
    }
  return events;
}

export function buildStageWhisperEvents(input: {
  ownerScope: string;
  simulationId: string;
  commandId: string;
  actorId: string;
  selected: StageWhisperRecord[];
  inline?: string | null | undefined;
}): RuntimeEvent[] {
  const events: RuntimeEvent[] = input.selected.map((whisper) => ({
    type: "stage_whisper_consumed",
    whisperId: whisper.id,
    targetActorId: input.actorId,
    text: whisper.text,
  }));
  const inline = input.inline?.trim();
  if (inline)
    events.push({
      type: "stage_whisper_consumed",
      whisperId: domainId(
        "whisper",
        input.ownerScope,
        input.simulationId,
        input.commandId,
      ),
      targetActorId: input.actorId,
      text: inline,
    });
  return events;
}

export function buildRootOrigin(
  commandId: string,
  baseCommitId: string,
): BranchRecord["origin"] {
  return { kind: "root", commandId, baseCommitId };
}

export function buildBranchOrigin(input: {
  kind: "fork" | "edit" | "regenerate";
  commandId: string;
  sourceBranchId: string;
  sourceHeadCommitId: string;
  baseCommitId: string;
}): BranchRecord["origin"] {
  return { ...input };
}
