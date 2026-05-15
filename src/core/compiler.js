import { readWorldSource } from "./source.js";

const MENTION_PATTERN = /@([a-zA-Z0-9_-]+)/g;
const TAG_PATTERN = /(^|\s):([a-zA-Z0-9_+@.-]+(?::[a-zA-Z0-9_+@.,-]+)?)/g;
const STRENGTHS = new Map([
  ["+3", 3],
  ["+1", 1],
  ["0", 0],
  ["-1", -1],
  ["-3", -3]
]);

export async function compileWorld(worldPath) {
  const source = await readWorldSource(worldPath);
  const records = {
    sourceRoot: source.root,
    models: source.models.map(toAssetRecord("model")),
    worlds: source.worlds.map(toAssetRecord("world")),
    scenarios: source.scenarios.map(toAssetRecord("scenario")),
    formats: source.formats.map(toAssetRecord("format")),
    entities: source.entities.map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      visibility: entity.visibility,
      folder: entity.folder,
      files: entity.files.map((file) => file.path)
    })),
    connections: source.connections.map(toAssetRecord("connection")),
    mentions: [],
    taggedLines: [],
    beliefs: [],
    surfaces: [],
    accessLinks: [],
    diagnostics: []
  };

  for (const entity of source.entities) {
    for (const file of entity.files) {
      collectLineRecords(records, file, { holder: entity.id, section: file.section });
    }
  }

  for (const connection of source.connections) {
    collectLineRecords(records, connection, { connectionId: connection.id });
  }

  validateRecords(records);
  return records;
}

function toAssetRecord(kind) {
  return (asset) => ({
    id: asset.id,
    kind,
    name: asset.data.name || asset.id,
    path: asset.path,
    metadata: asset.data,
    body: asset.body
  });
}

function collectLineRecords(records, file, context) {
  const lines = file.body.replace(/\r\n/g, "\n").split("\n");

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const text = line.trim();
    if (!text || text.startsWith("#")) return;

    const mentions = [...text.matchAll(MENTION_PATTERN)].map((match) => match[1]);
    const tags = [...text.matchAll(TAG_PATTERN)].map((match) => match[2]);
    if (mentions.length === 0 && tags.length === 0) return;

    const sourceSpan = {
      file: file.path,
      line: lineNumber,
      quote: text
    };

    for (const mention of mentions) {
      records.mentions.push({ id: mention, sourceSpan });
    }

    if (tags.length > 0) {
      records.taggedLines.push({
        tags,
        mentions,
        context,
        sourceSpan
      });
    }

    const strengthTag = tags.find((tag) => STRENGTHS.has(tag));
    if (strengthTag) {
      const holder = context.holder || mentions[0] || context.connectionId || "unknown";
      const belief = {
        holder,
        strength: STRENGTHS.get(strengthTag),
        propositionText: stripTags(text),
        mentions,
        sourceSpan
      };
      records.beliefs.push(belief);
    }

    const surfaceTag = tags.find((tag) => tag.startsWith("surface:"));
    if (surfaceTag) {
      records.surfaces.push({
        entity: mentions[0] || context.holder || "unknown",
        channels: surfaceTag.slice("surface:".length).split(",").filter(Boolean),
        text: stripTags(text),
        sourceSpan
      });
    }

    if (tags.includes("access:member")) {
      records.accessLinks.push({
        member: mentions[0] || context.holder || "unknown",
        container: mentions[1] || "unknown",
        mode: "member",
        sourceSpan
      });
    }
  });
}

function validateRecords(records) {
  const entityIds = new Set(records.entities.map((entity) => entity.id));
  const knownIds = new Set([
    ...entityIds,
    ...records.models.map((asset) => asset.id),
    ...records.worlds.map((asset) => asset.id),
    ...records.scenarios.map((asset) => asset.id),
    ...records.formats.map((asset) => asset.id)
  ]);

  const unresolved = new Map();
  for (const mention of records.mentions) {
    if (knownIds.has(mention.id)) continue;
    if (!unresolved.has(mention.id)) unresolved.set(mention.id, []);
    unresolved.get(mention.id).push(mention.sourceSpan);
  }

  for (const [id, spans] of unresolved.entries()) {
    records.diagnostics.push({
      severity: "warning",
      code: "unresolved_mention",
      message: `Mention @${id} does not match a known entity or asset id.`,
      sourceSpans: spans
    });
  }
}

function stripTags(text) {
  return text.replace(TAG_PATTERN, "").replace(/\s+/g, " ").trim();
}
