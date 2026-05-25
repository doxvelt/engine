import type {
  AccessLinkRecord,
  ActorContext,
  AssetRecord,
  DiagnosticRecord,
  EntityRecord,
  SimulationRecord,
  StageWhisperRecord,
  SubjectiveBeliefAccess,
  SubjectiveBeliefRecord,
  SurfaceRecord,
  TranscriptTurn
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
  observedEntityIds = [],
  turns = [],
  stageWhispers = [],
  diagnostics = []
}: {
  simulation: SimulationRecord;
  actor: EntityRecord;
  worlds?: AssetRecord[];
  scenario: AssetRecord | null;
  formats?: AssetRecord[];
  beliefs?: SubjectiveBeliefRecord[];
  accessLinks?: AccessLinkRecord[];
  surfaces?: SurfaceRecord[];
  observedEntityIds?: string[];
  turns?: TranscriptTurn[];
  stageWhispers?: StageWhisperRecord[];
  diagnostics?: DiagnosticRecord[];
}): ActorContext {
  const accessibleWorlds = worlds.map((world) => filterAssetForActor(world, actor));
  const accessibleScenario = scenario ? filterAssetForActor(scenario, actor) : null;
  const beliefAccess = resolveBeliefAccess(actor.id, beliefs, accessLinks);
  const projectedSurfaces = resolveProjectedSurfaces(actor.id, surfaces, observedEntityIds);

  return {
    simulation: {
      id: simulation.id,
      scenarioId: simulation.scenarioId,
      sourceRoot: simulation.sourceRoot
    },
    actor,
    assets: {
      worlds: accessibleWorlds,
      scenario: accessibleScenario,
      formats
    },
    subjective: {
      beliefs: beliefAccess.map((access) => access.belief),
      beliefAccess,
      surfaces: projectedSurfaces,
      transcript: turns,
      stageWhispers
    },
    diagnostics,
    promptPreview: buildPromptPreview({
      actor,
      worlds: accessibleWorlds,
      scenario: accessibleScenario,
      formats,
      beliefAccess,
      surfaces: projectedSurfaces,
      turns,
      stageWhispers
    })
  };
}

function buildPromptPreview({
  actor,
  worlds,
  scenario,
  formats,
  beliefAccess,
  surfaces,
  turns,
  stageWhispers
}: {
  actor: EntityRecord;
  worlds: AssetRecord[];
  scenario: AssetRecord | null;
  formats: AssetRecord[];
  beliefAccess: SubjectiveBeliefAccess[];
  surfaces: SurfaceRecord[];
  turns: TranscriptTurn[];
  stageWhispers: StageWhisperRecord[];
}): string {
  const sections = [
    `# Actor\n${actor.name} (${actor.id}, ${actor.kind})`,
    renderAssets("World", worlds),
    scenario ? renderAsset("Scenario", scenario) : "# Scenario\nNo scenario selected.",
    renderAssets("Format", formats),
    renderBeliefs(beliefAccess),
    renderSurfaces(surfaces),
    renderStageWhispers(stageWhispers),
    renderTranscript(turns)
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

function filterAssetForActor(asset: AssetRecord, actor: EntityRecord): AssetRecord {
  return {
    ...asset,
    body: asset.body
      .split(/\r?\n/)
      .filter((line) => isLineVisibleToActor(line, actor))
      .join("\n")
  };
}

function isLineVisibleToActor(line: string, actor: EntityRecord): boolean {
  if (!line.includes(":hidden")) return true;
  return line.includes(`@${actor.id}`);
}

export function resolveBeliefAccess(
  actorId: string,
  beliefs: SubjectiveBeliefRecord[],
  accessLinks: AccessLinkRecord[]
): SubjectiveBeliefAccess[] {
  const accessPaths = resolveMembershipPaths(actorId, accessLinks);
  const directAccess: SubjectiveBeliefAccess[] = beliefs
    .filter((belief) => belief.holder === actorId)
    .map((belief) => ({
      belief,
      provenance: provenanceForDirectBelief(actorId, belief)
    }));

  const membershipAccess: SubjectiveBeliefAccess[] = beliefs
    .filter((belief) => belief.holder !== actorId && accessPaths.has(belief.holder))
    .map((belief) => ({
      belief,
      provenance: {
        mode: "accessed_through_membership",
        holder: actorId,
        sourceHolder: belief.holder,
        accessPath: accessPaths.get(belief.holder) || [actorId, belief.holder]
      }
    }));

  return [...directAccess, ...membershipAccess];
}

function provenanceForDirectBelief(
  actorId: string,
  belief: SubjectiveBeliefRecord
): SubjectiveBeliefAccess["provenance"] {
  if ("sourceHolder" in belief && "accessPath" in belief) {
    return {
      mode: "retained_after_access_loss",
      holder: actorId,
      sourceHolder: belief.sourceHolder,
      accessPath: belief.accessPath
    };
  }

  if ("observerId" in belief && "entityId" in belief) {
    return {
      mode: "observed",
      holder: actorId,
      sourceHolder: belief.entityId,
      accessPath: [actorId, belief.entityId]
    };
  }

  return {
    mode: "held",
    holder: actorId,
    sourceHolder: belief.holder,
    accessPath: [actorId]
  };
}

function resolveMembershipPaths(actorId: string, accessLinks: AccessLinkRecord[]): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  const queue = [{ holder: actorId, path: [actorId] }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    for (const link of accessLinks) {
      if (link.mode !== "member" || link.member !== current.holder) continue;
      if (paths.has(link.container) || link.container === actorId) continue;

      const path = [...current.path, link.container];
      paths.set(link.container, path);
      queue.push({ holder: link.container, path });
    }
  }

  return paths;
}

function resolveProjectedSurfaces(
  actorId: string,
  surfaces: SurfaceRecord[],
  observedEntityIds: string[]
): SurfaceRecord[] {
  const observed = new Set([actorId, ...observedEntityIds]);
  return surfaces.filter((surface) => observed.has(surface.entity));
}

function renderBeliefs(beliefAccess: SubjectiveBeliefAccess[]): string {
  if (beliefAccess.length === 0) return "# Subjective Beliefs\nNone.";

  const lines = beliefAccess.map((access) => {
    const source =
      access.provenance.mode === "accessed_through_membership"
        ? ` (held by @${access.provenance.sourceHolder}; accessed through ${renderAccessPath(access.provenance.accessPath)})`
        : access.provenance.mode === "observed"
          ? ` (first impression of @${access.provenance.sourceHolder})`
          : access.provenance.mode === "retained_after_access_loss"
            ? ` (retained after losing access to @${access.provenance.sourceHolder}; old path ${renderAccessPath(access.provenance.accessPath)})`
        : "";
    return `- [${formatStrength(access.belief.strength)}]${source} ${access.belief.propositionText}`;
  });

  return `# Subjective Beliefs\n${lines.join("\n")}`;
}

function renderSurfaces(surfaces: SurfaceRecord[]): string {
  if (surfaces.length === 0) return "# Projected Surfaces\nNone.";

  const lines = surfaces.map((surface) => {
    const channels = surface.channels.length > 0 ? ` [${surface.channels.join(",")}]` : "";
    return `- @${surface.entity}${channels}: ${surface.text}`;
  });

  return `# Projected Surfaces\n${lines.join("\n")}`;
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
  if (turns.length === 0) return "# Accessible Transcript\nNo accessible turns yet.";

  const lines = turns.map((turn) => {
    return `${turn.actorId}: ${turn.text}`;
  });

  return `# Accessible Transcript\n${lines.join("\n")}`;
}

function formatStrength(strength: number): string {
  if (strength > 0) return `+${strength}`;
  return String(strength);
}
