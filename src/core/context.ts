import { resolveCurrentBeliefs } from "./beliefs.ts";
import { resolveAccessPaths } from "./access-graph.ts";
import type {
  AccessLinkRecord,
  ActorContext,
  AssetRecord,
  DiagnosticRecord,
  EntityRecord,
  LongTermMemoryRecord,
  SimulationRecord,
  StageWhisperRecord,
  SubjectiveBeliefAccess,
  SubjectiveBeliefRecord,
  SurfaceRecord,
  TranscriptTurn,
} from "./types.ts";

export function assembleActorContext({
  simulation,
  actor,
  worlds = [],
  scenario,
  formats = [],
  beliefs = [],
  accessLinks = [],
  surfaces = [],
  longTermMemories = [],
  observedEntityIds = [],
  currentAudience = [actor.id, ...observedEntityIds],
  turns = [],
  stageWhispers = [],
  diagnostics = [],
}: {
  simulation: SimulationRecord;
  actor: EntityRecord;
  worlds?: AssetRecord[];
  scenario: AssetRecord | null;
  formats?: AssetRecord[];
  beliefs?: SubjectiveBeliefRecord[];
  accessLinks?: AccessLinkRecord[];
  surfaces?: SurfaceRecord[];
  longTermMemories?: LongTermMemoryRecord[];
  observedEntityIds?: string[];
  currentAudience?: string[];
  turns?: TranscriptTurn[];
  stageWhispers?: StageWhisperRecord[];
  diagnostics?: DiagnosticRecord[];
}): ActorContext {
  const accessibleWorlds = worlds.map((world) =>
    filterAssetForActor(world, actor),
  );
  const accessibleScenario = scenario
    ? filterAssetForActor(scenario, actor)
    : null;
  const beliefHistoryAccess = resolveBeliefAccess(
    actor.id,
    beliefs,
    accessLinks,
  );
  const beliefResolution = resolveCurrentBeliefs(beliefHistoryAccess);
  const projectedSurfaces = resolveProjectedSurfaces(
    actor.id,
    surfaces,
    observedEntityIds,
  );

  return {
    simulation: {
      id: simulation.id,
      scenarioId: simulation.scenarioId,
      sourceRoot: simulation.sourceRoot,
    },
    actor,
    assets: {
      worlds: accessibleWorlds,
      scenario: accessibleScenario,
      formats,
    },
    subjective: {
      beliefs: beliefResolution.current.map((access) => access.belief),
      beliefAccess: beliefResolution.current,
      beliefHistoryAccess,
      beliefResolution,
      longTermMemories,
      surfaces: projectedSurfaces,
      transcript: turns,
      stageWhispers,
      currentAudience,
    },
    diagnostics,
    promptPreview: buildPromptPreview({
      actor,
      worlds: accessibleWorlds,
      scenario: accessibleScenario,
      formats,
      beliefResolution,
      longTermMemories,
      surfaces: projectedSurfaces,
      currentAudience,
      turns,
      stageWhispers,
    }),
  };
}

function buildPromptPreview({
  actor,
  worlds,
  scenario,
  formats,
  beliefResolution,
  longTermMemories,
  surfaces,
  currentAudience,
  turns,
  stageWhispers,
}: {
  actor: EntityRecord;
  worlds: AssetRecord[];
  scenario: AssetRecord | null;
  formats: AssetRecord[];
  beliefResolution: ActorContext["subjective"]["beliefResolution"];
  longTermMemories: LongTermMemoryRecord[];
  surfaces: SurfaceRecord[];
  currentAudience: string[];
  turns: TranscriptTurn[];
  stageWhispers: StageWhisperRecord[];
}): string {
  const sections = [
    `# Actor\n${actor.name} (${actor.id}, ${actor.kind})`,
    renderAssets("World", worlds),
    scenario
      ? renderAsset("Scenario", scenario)
      : "# Scenario\nNo scenario selected.",
    renderAssets("Format", formats),
    renderBeliefs(beliefResolution),
    renderLongTermMemories(longTermMemories),
    renderSurfaces(surfaces),
    renderCurrentAudience(actor.id, currentAudience),
    renderStageWhispers(stageWhispers),
    renderTranscript(turns),
  ];

  return sections.filter(Boolean).join("\n\n");
}

function renderAssets(label: string, assets: AssetRecord[]): string {
  if (assets.length === 0) return `# ${label}\nNone.`;
  return assets.map((asset) => renderAsset(label, asset)).join("\n\n");
}

function renderAsset(label: string, asset: AssetRecord): string {
  return `# ${label}: ${asset.name}\n${asset.body || "(No body text.)"}`;
}

function filterAssetForActor(
  asset: AssetRecord,
  actor: EntityRecord,
): AssetRecord {
  return {
    ...asset,
    body: asset.body
      .split(/\r?\n/)
      .filter((line) => isLineVisibleToActor(line, actor))
      .join("\n"),
  };
}

function isLineVisibleToActor(line: string, actor: EntityRecord): boolean {
  if (!line.includes(":hidden")) return true;
  const holder = line.match(/@([a-zA-Z0-9_-]+)/)?.[1];
  return holder === actor.id;
}

export function resolveBeliefAccess(
  actorId: string,
  beliefs: SubjectiveBeliefRecord[],
  accessLinks: AccessLinkRecord[],
): SubjectiveBeliefAccess[] {
  const accessPaths = resolveAccessPaths(actorId, accessLinks);
  const directAccess: SubjectiveBeliefAccess[] = beliefs
    .filter((belief) => belief.holder === actorId)
    .map((belief) => ({
      belief,
      provenance: provenanceForDirectBelief(actorId, belief),
    }));

  const membershipAccess: SubjectiveBeliefAccess[] = beliefs
    .filter(
      (belief) => belief.holder !== actorId && accessPaths.has(belief.holder),
    )
    .map((belief) => ({
      belief,
      provenance: {
        mode: "accessed_through_membership",
        holder: actorId,
        sourceHolder: belief.holder,
        accessPath: accessPaths.get(belief.holder) || [actorId, belief.holder],
      },
    }));

  return [...directAccess, ...membershipAccess];
}

function provenanceForDirectBelief(
  actorId: string,
  belief: SubjectiveBeliefRecord,
): SubjectiveBeliefAccess["provenance"] {
  if ("sourceHolder" in belief && "accessPath" in belief) {
    return {
      mode: "retained_after_access_loss",
      holder: actorId,
      sourceHolder: belief.sourceHolder,
      accessPath: belief.accessPath,
    };
  }

  if ("observerId" in belief && "entityId" in belief) {
    return {
      mode: "observed",
      holder: actorId,
      sourceHolder: belief.entityId,
      accessPath: [actorId, belief.entityId],
    };
  }

  return {
    mode: "held",
    holder: actorId,
    sourceHolder: belief.holder,
    accessPath: [actorId],
  };
}

function resolveProjectedSurfaces(
  actorId: string,
  surfaces: SurfaceRecord[],
  observedEntityIds: string[],
): SurfaceRecord[] {
  const observed = new Set([actorId, ...observedEntityIds]);
  return surfaces.filter((surface) => observed.has(surface.entity));
}

function renderBeliefs(
  beliefResolution: ActorContext["subjective"]["beliefResolution"],
): string {
  if (beliefResolution.current.length === 0)
    return "# Current Subjective Beliefs\nNone.";

  const currentLines = beliefResolution.current.map(renderBeliefAccess);
  const conflictLines = beliefResolution.conflicting.map(renderBeliefAccess);

  const sections = [`# Current Subjective Beliefs\n${currentLines.join("\n")}`];
  if (conflictLines.length > 0) {
    sections.push(`# Conflicting Belief History\n${conflictLines.join("\n")}`);
  }

  return sections.join("\n\n");
}

function renderBeliefAccess(access: SubjectiveBeliefAccess): string {
  const source =
    access.provenance.mode === "accessed_through_membership"
      ? ` (held by @${access.provenance.sourceHolder}; accessed through ${renderAccessPath(access.provenance.accessPath)})`
      : access.provenance.mode === "observed"
        ? ` (first impression of @${access.provenance.sourceHolder})`
        : access.provenance.mode === "retained_after_access_loss"
          ? ` (retained after losing access to @${access.provenance.sourceHolder}; old path ${renderAccessPath(access.provenance.accessPath)})`
          : "";
  return `- [${formatStrength(access.belief.strength)}]${source} ${access.belief.propositionText}`;
}

function renderLongTermMemories(memories: LongTermMemoryRecord[]): string {
  if (memories.length === 0) return "# Long-Term Memories\nNone.";

  const lines = memories.map((memory) => `- ${memory.text}`);
  return `# Long-Term Memories\n${lines.join("\n")}`;
}

function renderSurfaces(surfaces: SurfaceRecord[]): string {
  if (surfaces.length === 0) return "# Projected Surfaces\nNone.";

  const lines = surfaces.map((surface) => {
    const channels =
      surface.channels.length > 0 ? ` [${surface.channels.join(",")}]` : "";
    return `- @${surface.entity}${channels}: ${surface.text}`;
  });

  return `# Projected Surfaces\n${lines.join("\n")}`;
}

function renderCurrentAudience(
  actorId: string,
  currentAudience: string[],
): string {
  const audience = [...new Set(currentAudience)];
  const listeners = audience.filter((id) => id !== actorId);
  if (listeners.length === 0) {
    return [
      "# Current Turn Audience",
      `Only @${actorId} is in the audience for this turn.`,
      "Write as if this is private self-directed speech, narration, notes, or internal reflection unless the stage whisper or scenario says otherwise.",
    ].join("\n");
  }

  return [
    "# Current Turn Audience",
    `@${actorId} is speaking where these entities can hear or observe this turn: ${listeners.map((id) => `@${id}`).join(", ")}.`,
  ].join("\n");
}

function renderAccessPath(accessPath: string[]): string {
  return accessPath.map((holder) => `@${holder}`).join(" -> ");
}

function renderStageWhispers(stageWhispers: StageWhisperRecord[]): string {
  if (stageWhispers.length === 0) return "# Private Stage Whispers\nNone.";

  const lines = stageWhispers.map((whisper) => `- ${whisper.text}`);
  return `# Private Stage Whispers\n${lines.join("\n")}`;
}

function renderTranscript(turns: TranscriptTurn[]): string {
  if (turns.length === 0)
    return "# Accessible Transcript\nNo accessible turns yet.";

  const lines = turns.map((turn) => {
    return `${turn.actorId}: ${turn.text}`;
  });

  return `# Accessible Transcript\n${lines.join("\n")}`;
}

function formatStrength(strength: number): string {
  if (strength > 0) return `+${strength}`;
  return String(strength);
}
