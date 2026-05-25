import { readWorldSource } from "./source.ts";
import type {
  AccessLinkRecord,
  AssetKind,
  AssetRecord,
  BeliefRecord,
  CompiledWorld,
  LineRecordContext,
  SourceFile
} from "./types.ts";

const MENTION_PATTERN = /@([a-zA-Z0-9_-]+)/g;
const TAG_PATTERN = /(^|\s):([a-zA-Z0-9_+@.-]+(?::[a-zA-Z0-9_+@.,-]+)?)/g;
const STRENGTHS = new Map([
  ["+3", 3],
  ["+1", 1],
  ["0", 0],
  ["-1", -1],
  ["-3", -3]
]);

export async function compileWorld(worldPath: string): Promise<CompiledWorld> {
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

function toAssetRecord(kind: AssetKind): (asset: SourceFile) => AssetRecord {
  return (asset: SourceFile): AssetRecord => ({
    id: asset.id,
    kind,
    name: stringValue(asset.data.name) || asset.id,
    path: asset.path,
    metadata: asset.data,
    body: asset.body
  });
}

function collectLineRecords(records: CompiledWorld, file: SourceFile, context: LineRecordContext): void {
  const lines = file.body.replace(/\r\n/g, "\n").split("\n");

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const text = line.trim();
    if (!text || text.startsWith("#")) return;

    const mentions = [...text.matchAll(MENTION_PATTERN)]
      .map((match) => match[1])
      .filter(isString);
    const tags = [...text.matchAll(TAG_PATTERN)]
      .map((match) => match[2])
      .filter(isString);
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
      const belief: BeliefRecord = {
        holder,
        strength: STRENGTHS.get(strengthTag) ?? 0,
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
      records.accessLinks.push(resolveAccessLink({ file, context, text, mentions, sourceSpan }));
    }
  });
}

function validateRecords(records: CompiledWorld): void {
  validateModelRecords(records);

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

  validateMembershipLoops(records);
}

function validateModelRecords(records: CompiledWorld): void {
  for (const model of records.models) {
    const provider = stringValue(model.metadata.provider);
    const modelName = stringValue(model.metadata.model);
    const sourceSpan = assetSourceSpan(model);

    if (!provider) {
      records.diagnostics.push({
        severity: "error",
        code: "model_missing_provider",
        message: `Model ${model.id} is missing string provider metadata.`,
        sourceSpans: [sourceSpan]
      });
    }

    if (!modelName) {
      records.diagnostics.push({
        severity: "error",
        code: "model_missing_model",
        message: `Model ${model.id} is missing string model metadata.`,
        sourceSpans: [sourceSpan]
      });
    }

    if (provider === "openai-compatible") {
      const baseUrl = stringValue(model.metadata.base_url);
      if (!baseUrl) {
        records.diagnostics.push({
          severity: "error",
          code: "model_missing_base_url",
          message: `OpenAI-compatible model ${model.id} is missing string base_url metadata.`,
          sourceSpans: [sourceSpan]
        });
      } else if (!isHttpUrl(baseUrl)) {
        records.diagnostics.push({
          severity: "error",
          code: "model_invalid_base_url",
          message: `OpenAI-compatible model ${model.id} has invalid base_url metadata: ${baseUrl}.`,
          sourceSpans: [sourceSpan]
        });
      }
    }
  }
}

function assetSourceSpan(asset: AssetRecord): AccessLinkRecord["sourceSpan"] {
  return {
    file: asset.path,
    line: 1,
    quote: asset.body || asset.path
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validateMembershipLoops(records: CompiledWorld): void {
  const linksByMember = new Map<string, AccessLinkRecord[]>();

  for (const link of records.accessLinks) {
    linksByMember.set(link.member, [...(linksByMember.get(link.member) || []), link]);

    if (link.member === link.container) {
      records.diagnostics.push({
        severity: "error",
        code: "membership_self_loop",
        message: `Membership access link cannot make @${link.member} a member of itself.`,
        sourceSpans: [link.sourceSpan]
      });
    }
  }

  const reported = new Set<string>();
  for (const link of records.accessLinks) {
    walkMembershipAccess({
      records,
      linksByMember,
      reported,
      path: [link.member],
      pathLinks: [],
      link
    });
  }
}

function walkMembershipAccess({
  records,
  linksByMember,
  reported,
  path,
  pathLinks,
  link
}: {
  records: CompiledWorld;
  linksByMember: Map<string, AccessLinkRecord[]>;
  reported: Set<string>;
  path: string[];
  pathLinks: AccessLinkRecord[];
  link: AccessLinkRecord;
}): void {
  const nextPath = [...path, link.container];
  const nextLinks = [...pathLinks, link];
  const repeatedAt = path.indexOf(link.container);

  if (repeatedAt !== -1) {
    const cyclePath = nextPath.slice(repeatedAt);
    const cycleLinks = nextLinks.slice(repeatedAt);
    const key = canonicalCycleKey(cyclePath);
    if (reported.has(key)) return;
    reported.add(key);

    records.diagnostics.push({
      severity: "error",
      code: cycleLinks.length === 1 ? "membership_self_loop" : "membership_cycle",
      message: `Membership access cycle is invalid: ${cyclePath.map((entity) => `@${entity}`).join(" -> ")}.`,
      sourceSpans: cycleLinks.map((cycleLink) => cycleLink.sourceSpan)
    });
    return;
  }

  for (const nextLink of linksByMember.get(link.container) || []) {
    walkMembershipAccess({
      records,
      linksByMember,
      reported,
      path: nextPath,
      pathLinks: nextLinks,
      link: nextLink
    });
  }
}

function canonicalCycleKey(cyclePath: string[]): string {
  const cycle = cyclePath.at(0) === cyclePath.at(-1) ? cyclePath.slice(0, -1) : cyclePath;
  if (cycle.length === 0) return "";

  const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)].join("->"));
  return rotations.sort()[0] || cycle.join("->");
}

function stripTags(text: string): string {
  return text.replace(TAG_PATTERN, "").replace(/\s+/g, " ").trim();
}

function resolveAccessLink({
  file,
  context,
  text,
  mentions,
  sourceSpan
}: {
  file: SourceFile;
  context: LineRecordContext;
  text: string;
  mentions: string[];
  sourceSpan: AccessLinkRecord["sourceSpan"];
}): AccessLinkRecord {
  const member = mentionBeforeAccess(text) || context.holder || mentions[0] || "unknown";
  const container = mentionAfterAccessTo(text) || connectionPeer(file, member) || mentions.find((mention) => mention !== member) || "unknown";

  return {
    member,
    container,
    mode: "member",
    sourceSpan
  };
}

function mentionBeforeAccess(text: string): string | undefined {
  const accessIndex = text.toLowerCase().indexOf("access");
  if (accessIndex === -1) return undefined;

  return [...text.slice(0, accessIndex).matchAll(MENTION_PATTERN)].at(-1)?.[1];
}

function mentionAfterAccessTo(text: string): string | undefined {
  return /access\s+to\b[\s\S]*?@([a-zA-Z0-9_-]+)/i.exec(text)?.[1];
}

function connectionPeer(file: SourceFile, member: string): string | undefined {
  const entities = file.data.entities;
  if (!Array.isArray(entities)) return undefined;

  return entities.find((entity) => entity !== member);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
