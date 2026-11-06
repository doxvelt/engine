import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectBranch } from "../core/branch-kernel.ts";
import { canHoldEpisodeMemory } from "../core/domain-rules.ts";
import { DomainNotFoundError, DomainValidationError, type SimulationRepository } from "../core/ports.ts";
import type { ProjectionQuery } from "../core/types.ts";
import { withReverie, type ReflectionRequest, type ReverieSource } from "./reverie.ts";

type Source = { characterId: string; name: string; observation: ReverieSource };
type Scene = {
  slot: string; label: string; date: string | null; revision: string;
  episodeId: string | null; sources: Source[];
};
type CharacterMemory = {
  characterId: string; file: string;
  memories: { gist: string; detail: string; feeling: string; sourceMessageIds: string[] }[];
  impressions: { text: string; sourceEpisodeIds: string[] }[];
};
type Publication = {
  id: string; slot: string; revision: string; date: string; label: string;
  dependencies: string[]; characters: CharacterMemory[];
};
export type EpisodeMemoryOptions = {
  directory: string;
  executable: string;
  modelKey: string;
  reflect: (request: ReflectionRequest, signal: AbortSignal) => Promise<string>;
};

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireDate(value: string) {
  const instant = new Date(value);
  if (!/^\d{4}-\d\d-\d\d$/.test(value) || !Number.isFinite(+instant) || instant.toISOString().slice(0, 10) !== value)
    throw new DomainValidationError("Enter a fictional date as YYYY-MM-DD.");
}

function publicMemory(version: Publication | undefined) {
  return version?.characters.map(({ characterId, memories, impressions }) => ({ characterId, memories, impressions })) ?? [];
}

/** Doxvelt owns publication visibility. A native database is immutable after publication. */
export class EpisodeMemory {
  private readonly options: EpisodeMemoryOptions;
  private readonly db: DatabaseSync;

  constructor(options: EpisodeMemoryOptions) {
    this.options = options;
    mkdirSync(options.directory, { recursive: true });
    this.db = new DatabaseSync(path.join(options.directory, "catalog.sqlite"));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS fictional_dates (
        story TEXT NOT NULL, slot TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY (story, slot)
      );
      CREATE TABLE IF NOT EXISTS memory_versions (
        id TEXT PRIMARY KEY, story TEXT NOT NULL, slot TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_versions_story ON memory_versions(story);
    `);
  }

  close() {
    this.db.close();
  }

  private story(query: ProjectionQuery) {
    return fingerprint([query.ownerScope, query.simulationId]);
  }

  private scenes(repository: SimulationRepository, query: ProjectionQuery): Scene[] {
    const projection = projectBranch(repository, query);
    const simulation = repository.getSimulation(query.ownerScope, query.simulationId)!;
    const actors = repository.getContentRevision(query.ownerScope, simulation.contentRevisionId)!.compiled.entities;
    const byId = new Map(actors.map(actor => [actor.id, actor]));
    const story = this.story(query);
    const dateRows = this.db.prepare("SELECT slot, date FROM fictional_dates WHERE story = ?").all(story);
    const dates = new Map(dateRows.map(row => [String(row.slot), String(row.date)]));
    const episodes = projection.episodeClosures.map(closure => closure.episode);
    const perceptions = new Map<string, Set<string>>();
    for (const entry of projection.perceptions) {
      let messages = perceptions.get(entry.actorId);
      if (!messages) perceptions.set(entry.actorId, messages = new Set());
      messages.add(entry.sourceMessageVersionId);
    }
    return [...episodes, null].map((episode, index) => {
      const episodeId = episode?.id ?? null;
      const slot = episodes[index - 1]?.id ?? "first";
      const date = dates.get(slot) ?? null;
      const turns = projection.transcript.filter(turn => turn.episodeId === episodeId);
      const label = episode?.label ?? "Episode " + (index + 1);
      const sources = actors.filter(canHoldEpisodeMemory).flatMap(actor => {
        const seen = perceptions.get(actor.id);
        const messages = turns.filter(turn => seen?.has(turn.messageVersionId ?? turn.id)).map(turn => ({
          id: turn.messageVersionId ?? turn.id,
          role: turn.actorId === actor.id ? "assistant" as const : "user" as const,
          text: JSON.stringify({
            speaker: byId.get(turn.actorId)?.name ?? turn.actorId,
            recipients: turn.audience.filter(id => id !== turn.actorId).map(id => byId.get(id)?.name ?? id),
            performance: turn.text,
          }),
        }));
        return messages.length ? [{ characterId: actor.id, name: actor.name,
          observation: { foundation: "The remembering character is " + actor.name + ".", messages } }] : [];
      });
      return { slot, episodeId, label, date, sources,
        revision: fingerprint([slot, date, simulation.contentRevisionId, turns.map(turn => turn.bodyRevisionId ?? turn.messageVersionId ?? turn.id)]) };
    });
  }

  private publications(query: ProjectionQuery) {
    const rows = this.db.prepare("SELECT data FROM memory_versions WHERE story = ? ORDER BY rowid DESC").all(this.story(query));
    return rows.map(row => JSON.parse(String(row.data)) as Publication);
  }

  private resolve(scenes: Scene[], publications: Publication[]) {
    const eligible = new Set<string>();
    const selected = new Map<string, Publication>();
    const dated = scenes.filter(scene => scene.date !== null).sort((a, b) => a.date!.localeCompare(b.date!));
    for (const scene of dated) {
      const found = publications.find(version => version.revision === scene.revision &&
        version.dependencies.every(id => eligible.has(id)));
      if (found) {
        selected.set(scene.slot, found);
        eligible.add(found.id);
      }
    }
    return selected;
  }

  inspect(repository: SimulationRepository, query: ProjectionQuery) {
    const scenes = this.scenes(repository, query);
    const publications = this.publications(query);
    const selected = this.resolve(scenes, publications);
    return scenes.map(({ slot, episodeId, label, date, revision, sources }) => {
      const version = selected.get(slot);
      return { slot, episodeId, label, date, revision, canMemorize: sources.length > 0,
        status: version ? "current" : publications.some(item => item.slot === slot) ? "drifted" : "unmemorized",
        memories: publicMemory(version),
      };
    });
  }

  setDate(repository: SimulationRepository, query: ProjectionQuery, slot: string, date: string) {
    requireDate(date);
    const scenes = this.scenes(repository, query);
    if (!scenes.some(scene => scene.slot === slot)) throw new DomainNotFoundError("Episode is unavailable on this story path.");
    if (scenes.some(scene => scene.slot !== slot && scene.date === date))
      throw new DomainValidationError("Each episode on this story path needs a different fictional date.");
    this.db.prepare(`INSERT INTO fictional_dates VALUES (?, ?, ?)
      ON CONFLICT(story, slot) DO UPDATE SET date=excluded.date`).run(this.story(query), slot, date);
    return this.inspect(repository, query);
  }

  async memorize(repository: SimulationRepository, query: ProjectionQuery, slot: string, signal?: AbortSignal) {
    const scenes = this.scenes(repository, query);
    const scene = scenes.find(item => item.slot === slot);
    if (!scene) throw new DomainNotFoundError("Episode is unavailable on this story path.");
    if (!scene.date) throw new DomainValidationError("Set the fictional date before memorizing this episode.");
    if (!scene.sources.length) throw new DomainValidationError("Play at least one turn before memorizing.");
    const publications = this.publications(query);
    const actors = new Set(scene.sources.map(source => source.characterId));
    const prior = this.earlier(scenes, publications, scene).filter(version =>
      version.characters.some(character => actors.has(character.characterId) && (character.memories.length || character.impressions.length)));
    const dependencies = prior.map(version => version.id);
    const id = fingerprint([this.story(query), scene.revision, dependencies]);
    const existing = publications.find(version => version.id === id);
    if (existing) return { status: "current", memories: publicMemory(existing) };

    const version: Publication = { id, slot, revision: scene.revision, date: scene.date, label: scene.label, dependencies, characters: [] };
    const files: string[] = [];
    let published = false;
    try {
      for (const source of scene.sources) {
        signal?.throwIfAborted();
        const file = randomUUID() + ".sqlite";
        files.push(file);
        const observation = source.observation;
        const character = await withReverie({
          executable: this.options.executable, database: path.join(this.options.directory, file), characterId: source.characterId,
          ...(signal ? { signal } : {}),
          async readSource(episodeId) {
            if (episodeId !== scene.revision) throw new Error("Unexpected episode source identity.");
            return observation;
          },
          reflect: (request, _key, abort) => this.options.reflect(namedReflection(request, source, prior), abort),
        }, async engine => {
          await engine.request("when", { episodeId: scene.revision, position: scene.date, label: scene.label });
          await engine.request("memorize", { episodeId: scene.revision, modelKey: this.options.modelKey });
          const result = await engine.request("inspect", { episodeId: scene.revision });
          const contribution = result.episodes.find(item => item.episode.id === scene.revision)?.contribution;
          if (!contribution) throw new Error("Reverie did not publish a contribution.");
          return { file, characterId: source.characterId, memories: contribution.memories, impressions: contribution.impressions };
        });
        version.characters.push(character);
      }
      signal?.throwIfAborted();
      const result = this.db.prepare("INSERT OR IGNORE INTO memory_versions VALUES (?, ?, ?, ?)")
        .run(id, this.story(query), slot, JSON.stringify(version));
      published = result.changes === 1;
      if (published) return { status: "published", memories: publicMemory(version) };
      return { status: "current", memories: publicMemory(this.publications(query).find(item => item.id === id)) };
    } finally {
      if (!published) await Promise.all(files.flatMap(file => ["", "-wal", "-shm"].map(suffix =>
        rm(path.join(this.options.directory, file + suffix), { force: true }))));
    }
  }

  private earlier(scenes: Scene[], publications: Publication[], active: Scene) {
    if (!active.date) return [];
    const earlier = scenes.filter(scene => scene.date !== null && scene.date < active.date!);
    return [...this.resolve(earlier, publications).values()];
  }

  async recall(repository: SimulationRepository, query: ProjectionQuery, actorId: string, cue: string, signal?: AbortSignal) {
    const scenes = this.scenes(repository, query);
    const active = scenes.at(-1)!;
    if (!active.date) return [];
    const date = active.date;
    const recent = active.sources.find(source => source.characterId === actorId)?.observation.messages.slice(-4) ?? [];
    const search = [...recent.map(message => message.text), cue].join("\n").trim().slice(-12_000);
    const prior = this.earlier(scenes, this.publications(query), active);
    const recalls = [];
    for (const version of prior) {
      const character = version.characters.find(item => item.characterId === actorId);
      if (!character) continue;
      const result = await withReverie({
        executable: this.options.executable, database: path.join(this.options.directory, character.file),
        characterId: actorId, ...(signal ? { signal } : {}),
      }, engine => engine.request("retrieve", { at: date, ...(search ? { cue: search } : {}) }));
      if (result.text) recalls.push({ publicationId: version.id, label: version.label, text: result.text });
    }
    return recalls;
  }
}

function namedReflection(request: ReflectionRequest, source: Source, prior: Publication[]): ReflectionRequest {
  const previous = prior.flatMap(version => {
    const character = version.characters.find(item => item.characterId === source.characterId);
    return character ? [{ episode: version.label, date: version.date,
      recollections: character.memories.map(({ gist, feeling }) => ({ gist, feeling })),
      impressions: character.impressions.map(({ text }) => text) }] : [];
  });
  const system = request.system.split("\n");
  system.splice(0, 3,
    "Form subjective long-term memories for the named remembering character. Write in first person and refer to other characters by name.",
    "Each played message contains a JSON record of the speaker, recipients, and performance. Use those named roles for attribution. Host user and assistant labels distinguish other characters and self. The human may play any character.",
    "Earlier memories are background for interpretation. Source message and episode aliases belong to the current episode. Cite current evidence for each new memory or impression.");
  return { ...request, system: system.join("\n"), input: { nativeEpisode: request.input, earlierSubjectiveMemory: previous } };
}
