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
  turns?: TranscriptTurn[];
  stageWhispers?: StageWhisperRecord[];
  diagnostics?: DiagnosticRecord[];
}): ActorContext {
  const accessibleWorlds = worlds.map((world) => filterAssetForActor(world, actor));
  const accessibleScenario = scenario ? filterAssetForActor(scenario, actor) : null;
  const beliefAccess = resolveBeliefAccess(actor.id, beliefs, accessLinks);

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
  turns,
  stageWhispers
}: {
  actor: EntityRecord;
  worlds: AssetRecord[];
  scenario: AssetRecord | null;
  formats: AssetRecord[];
  beliefAccess: SubjectiveBeliefAccess[];
  turns: TranscriptTurn[];
  stageWhispers: StageWhisperRecord[];
}): string {
  const sections = [
    `# Actor\n${actor.name} (${actor.id}, ${actor.kind})`,
    renderAssets("World", worlds),
    scenario ? renderAsset("Scenario", scenario) : "# Scenario\nNo scenario selected.",
    renderAssets("Format", formats),
    renderBeliefs(beliefAccess),
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

function resolveBeliefAccess(
  actorId: string,
  beliefs: SubjectiveBeliefRecord[],
  accessLinks: AccessLinkRecord[]
): SubjectiveBeliefAccess[] {
  const accessPaths = resolveMembershipPaths(actorId, accessLinks);
  const directAccess: SubjectiveBeliefAccess[] = beliefs
    .filter((belief) => belief.holder === actorId)
    .map((belief) => ({
      belief,
      provenance: {
        mode: "held",
        holder: actorId,
        sourceHolder: belief.holder,
        accessPath: [actorId]
      }
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

function renderBeliefs(beliefAccess: SubjectiveBeliefAccess[]): string {
  if (beliefAccess.length === 0) return "# Subjective Beliefs\nNone.";

  const lines = beliefAccess.map((access) => {
    const source =
      access.provenance.mode === "accessed_through_membership"
        ? ` (held by @${access.provenance.sourceHolder}; accessed through ${renderAccessPath(access.provenance.accessPath)})`
        : "";
    return `- [${formatStrength(access.belief.strength)}]${source} ${access.belief.propositionText}`;
  });

  return `# Subjective Beliefs\n${lines.join("\n")}`;
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
