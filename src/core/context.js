export function assembleActorContext({
  simulation,
  actor,
  worlds = [],
  scenario,
  formats = [],
  beliefs = [],
  turns = [],
  diagnostics = []
}) {
  return {
    simulation: {
      id: simulation.id,
      scenarioId: simulation.scenarioId,
      sourceRoot: simulation.sourceRoot
    },
    actor,
    assets: {
      worlds,
      scenario,
      formats
    },
    subjective: {
      beliefs: beliefs.filter((belief) => belief.holder === actor.id),
      transcript: turns
    },
    diagnostics,
    promptPreview: buildPromptPreview({ actor, worlds, scenario, formats, beliefs, turns })
  };
}

function buildPromptPreview({ actor, worlds, scenario, formats, beliefs, turns }) {
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

function renderAssets(label, assets) {
  if (assets.length === 0) return `# ${label}\nNone.`;
  return assets.map((asset) => renderAsset(label, asset)).join("\n\n");
}

function renderAsset(label, asset) {
  return `# ${label}: ${asset.name}\n${asset.body || "(No body text.)"}`;
}

function renderBeliefs(beliefs) {
  if (beliefs.length === 0) return "# Subjective Beliefs\nNone.";

  const lines = beliefs.map((belief) => {
    return `- [${formatStrength(belief.strength)}] ${belief.propositionText}`;
  });

  return `# Subjective Beliefs\n${lines.join("\n")}`;
}

function renderTranscript(turns) {
  if (turns.length === 0) return "# Accessible Transcript\nNo accessible turns yet.";

  const lines = turns.map((turn) => {
    return `${turn.actorId}: ${turn.text}`;
  });

  return `# Accessible Transcript\n${lines.join("\n")}`;
}

function formatStrength(strength) {
  if (strength > 0) return `+${strength}`;
  return String(strength);
}
