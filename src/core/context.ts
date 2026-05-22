import type {
  ActorContext,
  AssetRecord,
  DiagnosticRecord,
  EntityRecord,
  SimulationRecord,
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
  turns = [],
  diagnostics = []
}: {
  simulation: SimulationRecord;
  actor: EntityRecord;
  worlds?: AssetRecord[];
  scenario: AssetRecord | null;
  formats?: AssetRecord[];
  beliefs?: SubjectiveBeliefRecord[];
  turns?: TranscriptTurn[];
  diagnostics?: DiagnosticRecord[];
}): ActorContext {
  const accessibleWorlds = worlds.map((world) => filterAssetForActor(world, actor));
  const accessibleScenario = scenario ? filterAssetForActor(scenario, actor) : null;

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
      beliefs: beliefs.filter((belief) => belief.holder === actor.id),
      transcript: turns
    },
    diagnostics,
    promptPreview: buildPromptPreview({
      actor,
      worlds: accessibleWorlds,
      scenario: accessibleScenario,
      formats,
      beliefs,
      turns
    })
  };
}

function buildPromptPreview({
  actor,
  worlds,
  scenario,
  formats,
  beliefs,
  turns
}: {
  actor: EntityRecord;
  worlds: AssetRecord[];
  scenario: AssetRecord | null;
  formats: AssetRecord[];
  beliefs: SubjectiveBeliefRecord[];
  turns: TranscriptTurn[];
}): string {
  const sections = [
    `# Actor\n${actor.name} (${actor.id}, ${actor.kind})`,
    renderAssets("World", worlds),
    scenario ? renderAsset("Scenario", scenario) : "# Scenario\nNo scenario selected.",
    renderAssets("Format", formats),
    renderBeliefs(beliefs.filter((belief) => belief.holder === actor.id)),
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

function renderBeliefs(beliefs: SubjectiveBeliefRecord[]): string {
  if (beliefs.length === 0) return "# Subjective Beliefs\nNone.";

  const lines = beliefs.map((belief) => {
    return `- [${formatStrength(belief.strength)}] ${belief.propositionText}`;
  });

  return `# Subjective Beliefs\n${lines.join("\n")}`;
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
