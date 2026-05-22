export type EntityKind = "agent" | "affiliation" | "artifact" | "stateless";

export type YamlValue = string | boolean | null | string[];

export type FrontmatterData = Record<string, YamlValue>;

export type SourceFile = {
  id: string;
  path: string;
  name: string;
  data: FrontmatterData;
  body: string;
  text: string;
};

export type EntitySourceFile = SourceFile & {
  section: string;
};

export type EntitySource = {
  id: string;
  kind: EntityKind;
  name: string;
  visibility: string;
  folder: string;
  files: EntitySourceFile[];
};

export type WorldSource = {
  root: string;
  models: SourceFile[];
  worlds: SourceFile[];
  scenarios: SourceFile[];
  formats: SourceFile[];
  entities: EntitySource[];
  connections: SourceFile[];
};

export type SourceSpan = {
  file: string;
  line: number;
  quote: string;
};

export type AssetKind = "model" | "world" | "scenario" | "format" | "connection";

export type AssetRecord = {
  id: string;
  kind: AssetKind;
  name: string;
  path: string;
  metadata: FrontmatterData;
  body: string;
};

export type EntityRecord = {
  id: string;
  kind: EntityKind;
  name: string;
  visibility: string;
  folder: string;
  files: string[];
};

export type LineRecordContext =
  | { holder: string; section: string; connectionId?: never }
  | { connectionId: string; holder?: never; section?: never };

export type TaggedLineRecord = {
  tags: string[];
  mentions: string[];
  context: LineRecordContext;
  sourceSpan: SourceSpan;
};

export type MentionRecord = {
  id: string;
  sourceSpan: SourceSpan;
};

export type BeliefRecord = {
  holder: string;
  strength: number;
  propositionText: string;
  mentions: string[];
  sourceSpan: SourceSpan;
};

export type SurfaceRecord = {
  entity: string;
  channels: string[];
  text: string;
  sourceSpan: SourceSpan;
};

export type AccessLinkRecord = {
  member: string;
  container: string;
  mode: "member";
  sourceSpan: SourceSpan;
};

export type DiagnosticRecord = {
  severity: "warning" | "error";
  code: string;
  message: string;
  sourceSpans?: SourceSpan[];
};

export type CompiledWorld = {
  sourceRoot: string;
  models: AssetRecord[];
  worlds: AssetRecord[];
  scenarios: AssetRecord[];
  formats: AssetRecord[];
  entities: EntityRecord[];
  connections: AssetRecord[];
  mentions: MentionRecord[];
  taggedLines: TaggedLineRecord[];
  beliefs: BeliefRecord[];
  surfaces: SurfaceRecord[];
  accessLinks: AccessLinkRecord[];
  diagnostics: DiagnosticRecord[];
};

export type SimulationRecord = {
  id: string;
  sourceRoot: string;
  scenarioId: string | null;
  createdAt: string;
};

export type TranscriptTurn = {
  id: number | bigint;
  simulationId: string;
  actorId: string;
  text: string;
  audience: string[];
  episodeId: number | bigint | null;
  createdAt: string;
};

export type EpisodeRecord = {
  id: number | bigint;
  simulationId: string;
  label: string | null;
  closedAt: string;
};

export type EpisodeMemoryRecord = {
  id: number | bigint;
  episodeId: number | bigint;
  simulationId: string;
  actorId: string;
  text: string;
  sourceTurnIds: Array<number | bigint>;
  createdAt: string;
};

export type ExtractedBeliefRecord = {
  id: number | bigint;
  episodeId: number | bigint;
  memoryId: number | bigint;
  simulationId: string;
  holder: string;
  strength: number;
  propositionText: string;
  createdAt: string;
};

export type SubjectiveBeliefRecord = BeliefRecord | ExtractedBeliefRecord;

export type EpisodeClosure = {
  episode: EpisodeRecord;
  memories: EpisodeMemoryRecord[];
  extractedBeliefs: ExtractedBeliefRecord[];
};

export type ActorContext = {
  simulation: {
    id: string;
    scenarioId: string | null;
    sourceRoot: string;
  };
  actor: EntityRecord;
  assets: {
    worlds: AssetRecord[];
    scenario: AssetRecord | null;
    formats: AssetRecord[];
  };
  subjective: {
    beliefs: SubjectiveBeliefRecord[];
    transcript: TranscriptTurn[];
  };
  diagnostics: DiagnosticRecord[];
  promptPreview: string;
};
