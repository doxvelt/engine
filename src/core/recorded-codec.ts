import { DomainValidationError } from "./ports.ts";
import type { ContentRevisionRecord } from "./types.ts";
import type {
  RecordedCommand,
  RecordedOutcome,
} from "./ports.ts";

type RecordValue = Record<string, unknown>;

export function decodeRecordedCommand(value: unknown): RecordedCommand {
  const command = record(value, "recorded command");
  const kind = enumString(command.kind, "recorded command kind", [
    "start", "turn", "effects", "closure", "edit", "regenerate", "fork",
    "whisper",
  ] as const);
  if (kind === "start") decodeStartCommand(command);
  else if (kind === "turn") decodeTurnCommand(command, false);
  else if (kind === "edit" || kind === "regenerate")
    decodeTurnCommand(command, true);
  else if (kind === "effects") decodeEffectsCommand(command);
  else if (kind === "closure") decodeClosureCommand(command);
  else if (kind === "fork") decodeForkCommand(command);
  else decodeWhisperCommand(command);
  return command as RecordedCommand;
}

export function decodeRecordedOutcome(value: unknown): RecordedOutcome {
  const outcome = record(value, "recorded outcome");
  const kind = enumString(outcome.kind, "recorded outcome kind", [
    "start", "commit", "branch", "whisper",
  ] as const);
  if (kind === "start") {
    exact(outcome, ["kind", "simulation", "branch", "root"], ["contentRevision"]);
    decodeSimulation(outcome.simulation);
    decodeBranch(outcome.branch);
    decodeCommit(outcome.root);
    if (outcome.contentRevision !== undefined)
      decodeContentRevision(outcome.contentRevision);
  } else if (kind === "commit") {
    exact(outcome, ["kind", "branch", "commit"]);
    decodeBranch(outcome.branch);
    decodeCommit(outcome.commit);
  } else if (kind === "branch") {
    exact(outcome, ["kind", "branch"]);
    decodeBranch(outcome.branch);
  } else {
    exact(outcome, ["kind", "whisper"]);
    decodeWhisper(outcome.whisper);
  }
  return outcome as RecordedOutcome;
}

export function assertRecordedCommandOutcome(
  command: RecordedCommand,
  outcome: RecordedOutcome,
): void {
  const expected = command.kind === "start"
    ? "start"
    : command.kind === "fork"
      ? "branch"
      : command.kind === "whisper"
        ? "whisper"
        : "commit";
  if (outcome.kind !== expected)
    throw new DomainValidationError(
      "Persisted recorded command and outcome kinds do not match.",
    );
}

export function assertRecordedOutcomeIdentity(
  command: RecordedCommand,
  outcome: RecordedOutcome,
): void {
  assertRecordedCommandOutcome(command, outcome);
  const fail = (): never => {
    throw new DomainValidationError(
      "Persisted recorded outcome identity does not match its command.",
    );
  };
  if (outcome.kind === "start") {
    if (command.kind !== "start") fail();
    const startCommand = command as Extract<RecordedCommand, { kind: "start" }>;
    if (
      outcome.simulation.ownerScope !== startCommand.ownerScope ||
      outcome.simulation.id !== startCommand.simulationId ||
      outcome.branch.ownerScope !== startCommand.ownerScope ||
      outcome.branch.simulationId !== startCommand.simulationId ||
      outcome.branch.id !== startCommand.defaultBranchId ||
      outcome.root.ownerScope !== startCommand.ownerScope ||
      outcome.root.simulationId !== startCommand.simulationId ||
      outcome.root.id !== startCommand.rootCommitId ||
      outcome.root.commandId !== startCommand.commandId ||
      outcome.root.parentCommitId !== null ||
      outcome.contentRevision?.ownerScope !== undefined &&
        outcome.contentRevision.ownerScope !== startCommand.ownerScope
    ) fail();
    return;
  }
  if (outcome.kind === "commit") {
    if (!["turn", "effects", "closure", "edit", "regenerate"].includes(
      command.kind,
    )) fail();
    const commitCommand = command as Extract<
      RecordedCommand,
      { kind: "turn" | "effects" | "closure" | "edit" | "regenerate" }
    >;
    if (
      outcome.branch.ownerScope !== commitCommand.ownerScope ||
      outcome.branch.simulationId !== commitCommand.simulationId ||
      outcome.branch.id !== commitCommand.branchId ||
      outcome.commit.ownerScope !== commitCommand.ownerScope ||
      outcome.commit.simulationId !== commitCommand.simulationId ||
      outcome.commit.commandId !== commitCommand.commandId
    ) fail();
    return;
  }
  if (outcome.kind === "branch") {
    if (command.kind !== "fork") fail();
    const forkCommand = command as Extract<RecordedCommand, { kind: "fork" }>;
    if (
      outcome.branch.ownerScope !== forkCommand.ownerScope ||
      outcome.branch.simulationId !== forkCommand.simulationId ||
      outcome.branch.id !== forkCommand.branchId ||
      outcome.branch.origin.commandId !== forkCommand.commandId
    ) fail();
    return;
  }
  if (command.kind !== "whisper") fail();
  const whisperCommand = command as Extract<RecordedCommand, { kind: "whisper" }>;
  if (
    outcome.whisper.ownerScope !== whisperCommand.ownerScope ||
    outcome.whisper.simulationId !== whisperCommand.simulationId ||
    outcome.whisper.branchId !== whisperCommand.branchId ||
    outcome.whisper.commandId !== whisperCommand.commandId
  ) fail();
}

function decodeStartCommand(command: RecordValue): void {
  const compiled = Object.hasOwn(command, "compiled");
  exact(
    command,
    compiled
      ? [
          "kind", "ownerScope", "simulationId", "scenarioId",
          "defaultBranchId", "rootCommitId", "commandId", "sourceRoot",
          "compiled",
        ]
      : [
          "kind", "ownerScope", "simulationId", "scenarioId",
          "contentRevisionId", "defaultBranchId", "rootCommitId", "commandId",
          "sourceRoot",
        ],
  );
  strings(command, [
    "ownerScope", "simulationId", "defaultBranchId", "rootCommitId",
    "commandId", "sourceRoot",
  ]);
  nullableString(command.scenarioId, "scenarioId");
  if (compiled) decodeCompiledWorkspace(command.compiled);
  else string(command.contentRevisionId, "contentRevisionId");
}

function decodeTurnCommand(command: RecordValue, sibling: boolean): void {
  exact(
    command,
    sibling
      ? [
          "kind", "ownerScope", "simulationId", "sourceBranchId",
          "sourceCommitId", "branchId", "expectedHead", "commandId", "payload",
        ]
      : [
          "kind", "ownerScope", "simulationId", "branchId", "expectedHead",
          "commandId", "payload",
        ],
    sibling ? ["branchName"] : [],
  );
  strings(command, [
    "ownerScope", "simulationId", "branchId", "expectedHead", "commandId",
  ]);
  if (sibling) strings(command, ["sourceBranchId", "sourceCommitId"]);
  if (command.branchName !== undefined) string(command.branchName, "branchName");
  decodeManualPayload(command.payload);
}

function decodeManualPayload(value: unknown): void {
  const payload = record(value, "manual turn payload");
  exact(payload, ["actorId", "text", "audience"], [
    "logicalMessageId", "operation", "audienceChanges", "accessChanges",
    "stageWhisper", "stageWhisperIds",
  ]);
  strings(payload, ["actorId", "text"]);
  stringArray(payload.audience, "audience");
  if (payload.logicalMessageId !== undefined)
    string(payload.logicalMessageId, "logicalMessageId");
  if (payload.operation !== undefined)
    enumString(payload.operation, "operation", ["turn", "edit", "regenerate"]);
  decodeEffects(payload);
  if (payload.stageWhisper !== undefined)
    nullableString(payload.stageWhisper, "stageWhisper");
  if (payload.stageWhisperIds !== undefined)
    stringArray(payload.stageWhisperIds, "stageWhisperIds");
}

function decodeEffectsCommand(command: RecordValue): void {
  exact(command, [
    "kind", "ownerScope", "simulationId", "branchId", "expectedHead",
    "commandId", "payload",
  ]);
  strings(command, [
    "ownerScope", "simulationId", "branchId", "expectedHead", "commandId",
  ]);
  const payload = record(command.payload, "runtime effects payload");
  exact(payload, [], ["audienceChanges", "accessChanges"]);
  decodeEffects(payload);
}

function decodeEffects(payload: RecordValue): void {
  if (payload.audienceChanges !== undefined) {
    const changes = array(payload.audienceChanges, "audienceChanges");
    for (const value of changes) {
      const change = record(value, "audience change");
      exact(change, ["actorId", "action", "reason"]);
      string(change.actorId, "actorId");
      enumString(change.action, "audience action", [
        "add", "remove", "deactivate", "reactivate",
      ]);
      nullableString(change.reason, "reason");
    }
  }
  if (payload.accessChanges !== undefined) {
    const changes = array(payload.accessChanges, "accessChanges");
    for (const value of changes) {
      const change = record(value, "access change");
      exact(change, ["action", "member", "container", "reason"]);
      enumString(change.action, "access action", ["grant", "revoke"]);
      strings(change, ["member", "container"]);
      nullableString(change.reason, "reason");
    }
  }
}

function decodeClosureCommand(command: RecordValue): void {
  exact(command, [
    "kind", "ownerScope", "simulationId", "branchId", "expectedHead",
    "commandId", "payload",
  ]);
  strings(command, [
    "ownerScope", "simulationId", "branchId", "expectedHead", "commandId",
  ]);
  const payload = record(command.payload, "closure payload");
  exact(payload, [], ["label"]);
  if (payload.label !== undefined) nullableString(payload.label, "label");
}

function decodeForkCommand(command: RecordValue): void {
  exact(command, [
    "kind", "ownerScope", "simulationId", "sourceBranchId", "expectedHead",
    "atCommitId", "branchId", "commandId",
  ], ["name"]);
  strings(command, [
    "ownerScope", "simulationId", "sourceBranchId", "expectedHead",
    "atCommitId", "branchId", "commandId",
  ]);
  if (command.name !== undefined) nullableString(command.name, "name");
}

function decodeWhisperCommand(command: RecordValue): void {
  exact(command, [
    "kind", "ownerScope", "simulationId", "branchId", "expectedHead",
    "commandId", "targetActorId", "text",
  ]);
  strings(command, [
    "ownerScope", "simulationId", "branchId", "expectedHead", "commandId",
    "targetActorId", "text",
  ]);
}

function decodeSimulation(value: unknown): void {
  const simulation = record(value, "simulation outcome");
  exact(simulation, [
    "id", "ownerScope", "contentRevisionId", "sourceRoot", "scenarioId",
    "defaultBranchId", "createdAt",
  ]);
  strings(simulation, [
    "id", "ownerScope", "contentRevisionId", "sourceRoot", "defaultBranchId",
    "createdAt",
  ]);
  nullableString(simulation.scenarioId, "scenarioId");
}

export function decodeContentRevisionRecord(
  value: unknown,
): ContentRevisionRecord {
  decodeContentRevision(value);
  return value as ContentRevisionRecord;
}

function decodeContentRevision(value: unknown): void {
  const revision = record(value, "content revision outcome");
  exact(revision, ["id", "ownerScope", "digest", "compiled", "createdAt"]);
  strings(revision, ["id", "ownerScope", "digest", "createdAt"]);
  decodeCompiledWorkspace(revision.compiled);
}

function decodeCompiledWorkspace(value: unknown): void {
  const compiled = record(value, "compiled workspace");
  const collectionKeys = [
    "models", "worlds", "scenarios", "formats", "entities", "connections",
    "mentions", "taggedLines", "beliefs", "surfaces", "accessLinks",
    "diagnostics",
  ];
  exact(compiled, ["sourceRoot", ...collectionKeys]);
  string(compiled.sourceRoot, "compiled source root");
  for (const key of ["models", "worlds", "scenarios", "formats", "connections"])
    for (const item of array(compiled[key], `compiled ${key}`)) decodeAsset(item);
  for (const item of array(compiled.entities, "compiled entities"))
    decodeEntity(item);
  for (const item of array(compiled.mentions, "compiled mentions"))
    decodeMention(item);
  for (const item of array(compiled.taggedLines, "compiled tagged lines"))
    decodeTaggedLine(item);
  for (const item of array(compiled.beliefs, "compiled beliefs"))
    decodeAuthoredBelief(item);
  for (const item of array(compiled.surfaces, "compiled surfaces"))
    decodeSurface(item);
  for (const item of array(compiled.accessLinks, "compiled access links"))
    decodeAccessLink(item);
  for (const item of array(compiled.diagnostics, "compiled diagnostics"))
    decodeDiagnostic(item);
}

function decodeAsset(value: unknown): void {
  const asset = record(value, "compiled asset");
  exact(asset, ["id", "kind", "name", "path", "metadata", "body"]);
  strings(asset, ["id", "name", "path", "body"]);
  enumString(asset.kind, "asset kind", [
    "model", "world", "scenario", "format", "connection",
  ] as const);
  decodeFrontmatter(asset.metadata);
}

function decodeFrontmatter(value: unknown): void {
  const metadata = record(value, "frontmatter metadata");
  for (const item of Object.values(metadata))
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "boolean" &&
      !(Array.isArray(item) && item.every((entry) => typeof entry === "string"))
    )
      throw new DomainValidationError("Persisted frontmatter value is invalid.");
}

function decodeEntity(value: unknown): void {
  const entity = record(value, "compiled entity");
  exact(entity, ["id", "kind", "name", "visibility", "folder", "files"], [
    "rawKind",
  ]);
  strings(entity, ["id", "name", "visibility", "folder"]);
  enumString(entity.kind, "entity kind", [
    "agent", "affiliation", "artifact", "stateless",
  ] as const);
  if (entity.rawKind !== undefined)
    decodeFrontmatter({ rawKind: entity.rawKind });
  stringArray(entity.files, "entity files");
}

function decodeMention(value: unknown): void {
  const mention = record(value, "compiled mention");
  exact(mention, ["id", "sourceSpan"]);
  string(mention.id, "mention ID");
  decodeSourceSpan(mention.sourceSpan);
}

function decodeTaggedLine(value: unknown): void {
  const line = record(value, "compiled tagged line");
  exact(line, ["tags", "mentions", "context", "sourceSpan"]);
  stringArray(line.tags, "tagged-line tags");
  stringArray(line.mentions, "tagged-line mentions");
  const context = record(line.context, "tagged-line context");
  if (Object.hasOwn(context, "connectionId")) {
    exact(context, ["connectionId"]);
    string(context.connectionId, "connection ID");
  } else {
    exact(context, ["holder", "section"]);
    strings(context, ["holder", "section"]);
  }
  decodeSourceSpan(line.sourceSpan);
}

function decodeAuthoredBelief(value: unknown): void {
  const belief = record(value, "compiled belief");
  exact(belief, ["holder", "strength", "propositionText", "mentions", "sourceSpan"]);
  strings(belief, ["holder", "propositionText"]);
  number(belief.strength, "belief strength");
  stringArray(belief.mentions, "belief mentions");
  decodeSourceSpan(belief.sourceSpan);
}

function decodeSurface(value: unknown): void {
  const surface = record(value, "compiled surface");
  exact(surface, ["entity", "channels", "text", "sourceSpan"]);
  strings(surface, ["entity", "text"]);
  stringArray(surface.channels, "surface channels");
  decodeSourceSpan(surface.sourceSpan);
}

function decodeAccessLink(value: unknown): void {
  const link = record(value, "compiled access link");
  exact(link, ["member", "container", "mode", "sourceSpan"]);
  strings(link, ["member", "container"]);
  enumString(link.mode, "access mode", ["member"]);
  decodeSourceSpan(link.sourceSpan);
}

function decodeDiagnostic(value: unknown): void {
  const diagnostic = record(value, "compiled diagnostic");
  exact(diagnostic, ["severity", "code", "message"], ["sourceSpans"]);
  enumString(diagnostic.severity, "diagnostic severity", ["warning", "error"]);
  strings(diagnostic, ["code", "message"]);
  if (diagnostic.sourceSpans !== undefined)
    for (const span of array(diagnostic.sourceSpans, "diagnostic source spans"))
      decodeSourceSpan(span);
}

function decodeBranch(value: unknown): void {
  const branch = record(value, "branch outcome");
  exact(branch, [
    "id", "ownerScope", "simulationId", "name", "headCommitId", "origin",
    "createdAt",
  ]);
  strings(branch, [
    "id", "ownerScope", "simulationId", "headCommitId", "createdAt",
  ]);
  nullableString(branch.name, "branch name");
  const origin = record(branch.origin, "branch origin");
  const kind = enumString(origin.kind, "branch origin kind", [
    "root", "fork", "edit", "regenerate",
  ] as const);
  if (kind === "root") {
    exact(origin, ["kind", "commandId", "baseCommitId"]);
    strings(origin, ["commandId", "baseCommitId"]);
  } else {
    exact(origin, [
      "kind", "commandId", "sourceBranchId", "sourceHeadCommitId",
      "baseCommitId",
    ]);
    strings(origin, [
      "commandId", "sourceBranchId", "sourceHeadCommitId", "baseCommitId",
    ]);
  }
}

function decodeCommit(value: unknown): void {
  const commit = record(value, "commit outcome");
  exact(commit, [
    "id", "ownerScope", "simulationId", "parentCommitId", "kind", "commandId",
    "events", "createdAt",
  ]);
  strings(commit, ["id", "ownerScope", "simulationId", "commandId", "createdAt"]);
  nullableString(commit.parentCommitId, "parentCommitId");
  enumString(commit.kind, "commit kind", [
    "root", "turn", "effects", "episode_closure",
  ]);
  for (const event of array(commit.events, "commit events")) {
    decodeRuntimeEvent(event);
  }
}

function decodeRuntimeEvent(value: unknown): void {
  const event = record(value, "runtime event");
  const type = enumString(event.type, "runtime event type", [
    "message_accepted", "audience_changed", "access_changed",
    "first_impression_formed", "stage_whisper_consumed", "episode_closed",
  ] as const);
  if (type === "message_accepted") {
    exact(event, ["type", "message"]);
    decodeMessage(event.message);
  } else if (type === "audience_changed") {
    exact(event, ["type", "actorId", "action", "reason"]);
    string(event.actorId, "audience actor");
    enumString(event.action, "audience action", [
      "add", "remove", "deactivate", "reactivate",
    ]);
    nullableString(event.reason, "audience reason");
  } else if (type === "access_changed") {
    exact(event, ["type", "action", "member", "container", "mode", "reason"]);
    strings(event, ["member", "container"]);
    enumString(event.action, "access action", ["grant", "revoke"]);
    enumString(event.mode, "access mode", ["member"]);
    nullableString(event.reason, "access reason");
  } else if (type === "first_impression_formed") {
    exact(event, ["type", "impression"]);
    decodeImpression(event.impression, false);
  } else if (type === "stage_whisper_consumed") {
    exact(event, ["type", "whisperId", "targetActorId", "text"]);
    strings(event, ["whisperId", "targetActorId", "text"]);
  } else {
    exact(event, ["type", "closure"]);
    decodeClosure(event.closure);
  }
}

function decodeMessage(value: unknown): void {
  const message = record(value, "message");
  exact(message, [
    "id", "logicalMessageId", "actorId", "text", "audience", "provenance",
  ]);
  strings(message, ["id", "logicalMessageId", "actorId", "text"]);
  stringArray(message.audience, "message audience");
  const provenance = record(message.provenance, "message provenance");
  exact(provenance, ["mode", "operation"]);
  enumString(provenance.mode, "message mode", ["manual"]);
  enumString(provenance.operation, "message operation", [
    "turn", "edit", "regenerate",
  ]);
}

function decodeClosure(value: unknown): void {
  const closure = record(value, "episode closure");
  exact(closure, [
    "episode", "memories", "longTermMemories", "extractedBeliefs",
    "retainedBeliefs",
  ]);
  const episode = record(closure.episode, "episode");
  exact(episode, ["id", "simulationId", "commitId", "label", "closedAt"]);
  strings(episode, ["id", "simulationId", "commitId", "closedAt"]);
  nullableString(episode.label, "episode label");
  for (const item of array(closure.memories, "episode memories"))
    decodeEpisodeMemory(item);
  for (const item of array(closure.longTermMemories, "long-term memories"))
    decodeLongMemory(item);
  for (const item of array(closure.extractedBeliefs, "extracted beliefs"))
    decodeExtractedBelief(item);
  for (const item of array(closure.retainedBeliefs, "retained beliefs"))
    decodeRetainedBelief(item);
}

function decodeEpisodeMemory(value: unknown): void {
  const memory = record(value, "episode memory");
  exact(memory, [
    "id", "episodeId", "simulationId", "actorId", "text", "sourceTurnIds",
    "createdAt",
  ]);
  strings(memory, [
    "id", "episodeId", "simulationId", "actorId", "text", "createdAt",
  ]);
  stringArray(memory.sourceTurnIds, "source turn IDs");
}

function decodeLongMemory(value: unknown): void {
  const memory = record(value, "long-term memory");
  exact(memory, [
    "id", "episodeId", "episodeMemoryId", "simulationId", "actorId", "text",
    "createdAt",
  ]);
  strings(memory, [
    "id", "episodeId", "episodeMemoryId", "simulationId", "actorId", "text",
    "createdAt",
  ]);
}

function decodeExtractedBelief(value: unknown): void {
  const belief = record(value, "extracted belief");
  exact(belief, [
    "id", "episodeId", "memoryId", "simulationId", "holder", "strength",
    "propositionText", "createdAt",
  ]);
  strings(belief, [
    "id", "episodeId", "memoryId", "simulationId", "holder",
    "propositionText", "createdAt",
  ]);
  number(belief.strength, "belief strength");
}

function decodeRetainedBelief(value: unknown): void {
  const belief = record(value, "retained belief");
  exact(belief, [
    "id", "episodeId", "simulationId", "holder", "strength",
    "propositionText", "sourceHolder", "accessPath", "sourceBelief",
    "runtimeAccessEventId", "createdAt",
  ]);
  strings(belief, [
    "id", "episodeId", "simulationId", "holder", "propositionText",
    "sourceHolder", "runtimeAccessEventId", "createdAt",
  ]);
  number(belief.strength, "retained belief strength");
  stringArray(belief.accessPath, "retained belief access path");
  decodeSourceBelief(belief.sourceBelief);
}

function decodeSourceBelief(value: unknown): void {
  const belief = record(value, "source belief");
  if (Object.hasOwn(belief, "memoryId")) decodeExtractedBelief(belief);
  else if (Object.hasOwn(belief, "observerId")) decodeImpression(belief, true);
  else {
    exact(belief, [
      "holder", "strength", "propositionText", "mentions", "sourceSpan",
    ]);
    strings(belief, ["holder", "propositionText"]);
    number(belief.strength, "authored belief strength");
    stringArray(belief.mentions, "belief mentions");
    decodeSourceSpan(belief.sourceSpan);
  }
}

function decodeImpression(value: unknown, complete: boolean): void {
  const impression = record(value, "first impression");
  const keys = [
    "holder", "observerId", "entityId", "strength", "propositionText",
    "surfaceSourceSpan",
  ];
  if (complete) keys.push("id", "simulationId", "createdAt");
  exact(impression, keys);
  const stringKeys = [
    "holder", "observerId", "entityId", "propositionText",
  ];
  if (complete) stringKeys.push("id", "simulationId", "createdAt");
  strings(impression, stringKeys);
  number(impression.strength, "impression strength");
  decodeSourceSpan(impression.surfaceSourceSpan);
}

function decodeSourceSpan(value: unknown): void {
  const span = record(value, "source span");
  exact(span, ["file", "line", "quote"]);
  strings(span, ["file", "quote"]);
  number(span.line, "source span line");
}

function decodeWhisper(value: unknown): void {
  const whisper = record(value, "whisper outcome");
  exact(whisper, [
    "id", "simulationId", "ownerScope", "branchId", "expectedHead",
    "commandId", "targetActorId", "text", "createdAt",
  ]);
  strings(whisper, [
    "id", "simulationId", "ownerScope", "branchId", "expectedHead",
    "commandId", "targetActorId", "text", "createdAt",
  ]);
}

function exact(value: RecordValue, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    throw new DomainValidationError("Persisted recorded data has invalid keys.");
}

function strings(value: RecordValue, keys: string[]): void {
  for (const key of keys) string(value[key], key);
}

function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string")
    throw new DomainValidationError(`Persisted ${label} must be a string.`);
}

function nullableString(value: unknown, label: string): void {
  if (value !== null) string(value, label);
}

function number(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new DomainValidationError(`Persisted ${label} must be finite.`);
}

function stringArray(value: unknown, label: string): void {
  for (const item of array(value, label)) string(item, label);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value))
    throw new DomainValidationError(`Persisted ${label} must be an array.`);
  return value;
}

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DomainValidationError(`Persisted ${label} must be an object.`);
  return value as RecordValue;
}

function enumString<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] {
  string(value, label);
  if (!allowed.includes(value))
    throw new DomainValidationError(`Persisted ${label} is invalid.`);
  return value as T[number];
}
