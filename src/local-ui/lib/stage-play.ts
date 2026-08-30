export type CommandAction = "start" | "whisper" | "generate" | "accept" | "discard";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type CommandLease = {
  body: string;
  commandId: string;
};

export type CommandLeaseStore = {
  for(action: CommandAction, body: JsonValue): string;
  succeed(action: CommandAction): void;
  reset(): void;
};

export function stableSerialize(value: unknown): string {
  return serialize(value, new Set<object>());
}

export function createCommandLease(idFactory: () => string): CommandLeaseStore {
  const leases = new Map<CommandAction, CommandLease>();
  return {
    for(action, body) {
      const serialized = stableSerialize(body);
      const current = leases.get(action);
      if (current?.body === serialized) return current.commandId;
      const commandId = idFactory();
      leases.set(action, { body: serialized, commandId });
      return commandId;
    },
    succeed(action) {
      leases.delete(action);
    },
    reset() {
      leases.clear();
    },
  };
}

export class CommandConvergenceError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("The mutation completed, but the resulting projection did not load.");
    this.cause = cause;
  }
}

export async function runLeasedMutation<T>(
  leases: CommandLeaseStore,
  action: CommandAction,
  body: JsonValue,
  mutate: (commandId: string) => Promise<T>,
  converge: (result: T) => Promise<void>,
): Promise<T> {
  const result = await mutate(leases.for(action, body));
  try {
    await converge(result);
  } catch (error) {
    throw new CommandConvergenceError(error);
  }
  leases.succeed(action);
  return result;
}

export type StageActor = { id: string; name?: string; kind: string };

export function playableActors<T extends StageActor>(actors: readonly T[]): T[] {
  return actors
    .filter((actor) => actor.kind === "agent")
    .toSorted((left, right) =>
      (left.name || left.id).localeCompare(right.name || right.id),
    );
}

export function acceptDraftBody(
  commandId: string,
  artifactText: string,
  editorText: string,
): { commandId: string; finalText?: string } {
  return editorText === artifactText
    ? { commandId }
    : { commandId, finalText: editorText };
}

type SafeProvenanceInput = {
  adapter?: { id?: string | null; version?: string | null } | null;
  providerId?: string | null;
  modelId?: string | null;
  usage?: { totalTokens?: number | null; [key: string]: unknown } | null;
  stopReason?: string | null;
};

export type CompactProvenance = {
  providerModel: string;
  adapter: string;
  usage: string;
  stopReason: string;
};

export type DraftReview =
  | { kind: "ready"; text: string; provenance: CompactProvenance }
  | { kind: "failed"; message: string; provenance: CompactProvenance }
  | { kind: "unavailable"; message: string };

export function classifyDraftReview(input: {
  status: string;
  artifact: { text?: unknown; provenance?: SafeProvenanceInput | null } | null;
  failure: { message?: unknown; provenance?: SafeProvenanceInput | null } | null;
}): DraftReview {
  if (input.status === "ready" && typeof input.artifact?.text === "string")
    return {
      kind: "ready",
      text: input.artifact.text,
      provenance: compactProvenance(input.artifact.provenance),
    };
  if (input.status === "failed")
    return {
      kind: "failed",
      message:
        typeof input.failure?.message === "string"
          ? input.failure.message
          : "The runtime did not produce a draft.",
      provenance: compactProvenance(input.failure?.provenance),
    };
  return { kind: "unavailable", message: "This draft is no longer available for review." };
}

export function isStaleDraftBasis(
  draft: { branchId: string; basisHeadCommitId: string },
  branch: { id: string; headCommitId: string },
): boolean {
  return draft.branchId !== branch.id || draft.basisHeadCommitId !== branch.headCommitId;
}

function compactProvenance(input: SafeProvenanceInput | null | undefined): CompactProvenance {
  const provider = safeLabel(input?.providerId);
  const model = safeLabel(input?.modelId);
  const adapter = safeLabel(input?.adapter?.id);
  const version = safeLabel(input?.adapter?.version);
  const total = input?.usage?.totalTokens;
  return {
    providerModel:
      provider && model ? `${provider} / ${model}` : "Provider / model unavailable",
    adapter: adapter && version ? `${adapter} v${version}` : "Adapter unavailable",
    usage: typeof total === "number" && Number.isFinite(total) ? `${total} tokens` : "Usage unavailable",
    stopReason: safeLabel(input?.stopReason) || "Not reported",
  };
}

function safeLabel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Stable serialization only accepts finite numbers.");
    return String(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Stable serialization rejects cyclic values.");
    ancestors.add(value);
    const result = `[${value.map((item) => serialize(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return result;
  }
  if (!value || typeof value !== "object") throw new TypeError("Stable serialization only accepts JSON values.");
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new TypeError("Stable serialization only accepts plain objects.");
  if (ancestors.has(value)) throw new TypeError("Stable serialization rejects cyclic values.");
  ancestors.add(value);
  const record = value as Record<string, unknown>;
  const result = `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`)
    .join(",")}}`;
  ancestors.delete(value);
  return result;
}
