import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AccessLinkRecord,
  AssetRecord,
  BeliefRecord,
  CompiledWorld,
  EntityRecord,
  EpisodeMemoryRecord,
  EpisodeRecord,
  ExtractedBeliefRecord,
  SimulationRecord,
  TranscriptTurn
} from "../core/types.ts";

export function openRuntimeStore(dbPath = ".doxvelt/runtime.sqlite") {
  const resolved = path.resolve(dbPath);
  return new RuntimeStore(resolved);
}

export class RuntimeStore {
  dbPath: string;
  db: DatabaseSync | null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async open(): Promise<this> {
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS simulations (
        id TEXT PRIMARY KEY,
        source_root TEXT NOT NULL,
        scenario_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS compiled_records (
        simulation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (simulation_id, kind, id)
      );

      CREATE TABLE IF NOT EXISTS transcript_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        simulation_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        text TEXT NOT NULL,
        audience_json TEXT NOT NULL,
        episode_id INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        simulation_id TEXT NOT NULL,
        label TEXT,
        closed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS episode_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL,
        simulation_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        text TEXT NOT NULL,
        source_turn_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS extracted_beliefs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL,
        memory_id INTEGER NOT NULL,
        simulation_id TEXT NOT NULL,
        holder TEXT NOT NULL,
        strength INTEGER NOT NULL,
        proposition_text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("transcript_turns", "episode_id", "INTEGER");
    return this;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  saveSimulation({
    id,
    sourceRoot,
    scenarioId,
    compiled
  }: {
    id: string;
    sourceRoot: string;
    scenarioId: string | null;
    compiled: CompiledWorld;
  }): void {
    const createdAt = new Date().toISOString();
    this.requireDb()
      .prepare(`
        INSERT INTO simulations (id, source_root, scenario_id, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_root = excluded.source_root,
          scenario_id = excluded.scenario_id
      `)
      .run(id, sourceRoot, scenarioId || null, createdAt);

    this.requireDb().prepare("DELETE FROM compiled_records WHERE simulation_id = ?").run(id);

    const insert = this.requireDb().prepare(`
      INSERT INTO compiled_records (simulation_id, kind, id, json)
      VALUES (?, ?, ?, ?)
    `);

    for (const entity of compiled.entities) {
      insert.run(id, "entity", entity.id, JSON.stringify(entity));
    }

    for (const world of compiled.worlds) {
      insert.run(id, "world", world.id, JSON.stringify(world));
    }

    for (const scenario of compiled.scenarios) {
      insert.run(id, "scenario", scenario.id, JSON.stringify(scenario));
    }

    for (const format of compiled.formats) {
      insert.run(id, "format", format.id, JSON.stringify(format));
    }

    for (const connection of compiled.connections) {
      insert.run(id, "connection", connection.id, JSON.stringify(connection));
    }

    for (const belief of compiled.beliefs) {
      insert.run(id, "belief", `${belief.holder}:${belief.sourceSpan.file}:${belief.sourceSpan.line}`, JSON.stringify(belief));
    }

    for (const accessLink of compiled.accessLinks) {
      insert.run(
        id,
        "access_link",
        `${accessLink.member}:${accessLink.container}:${accessLink.sourceSpan.file}:${accessLink.sourceSpan.line}`,
        JSON.stringify(accessLink)
      );
    }
  }

  listActors(simulationId = "default"): EntityRecord[] {
    const rows = this.requireDb()
      .prepare(`
        SELECT json FROM compiled_records
        WHERE simulation_id = ? AND kind = 'entity'
        ORDER BY id
      `)
      .all(simulationId);

    return rows
      .map((row) => JSON.parse(row.json as string) as EntityRecord)
      .filter((entity) => entity.kind !== "artifact");
  }

  getSimulation(simulationId = "default"): SimulationRecord | null {
    const row = this.requireDb()
      .prepare(`
        SELECT id, source_root, scenario_id, created_at
        FROM simulations
        WHERE id = ?
      `)
      .get(simulationId);

    if (!row) return null;

    return {
      id: row.id as string,
      sourceRoot: row.source_root as string,
      scenarioId: row.scenario_id as string | null,
      createdAt: row.created_at as string
    };
  }

  getCompiledRecord<TRecord extends AssetRecord | EntityRecord | BeliefRecord | AccessLinkRecord>(
    simulationId: string,
    kind: string,
    id: string
  ): TRecord | null {
    const row = this.requireDb()
      .prepare(`
        SELECT json FROM compiled_records
        WHERE simulation_id = ? AND kind = ? AND id = ?
      `)
      .get(simulationId, kind, id);

    return row ? (JSON.parse(row.json as string) as TRecord) : null;
  }

  listCompiledRecords<TRecord extends AssetRecord | EntityRecord | BeliefRecord | AccessLinkRecord>(
    simulationId: string,
    kind: string
  ): TRecord[] {
    const rows = this.requireDb()
      .prepare(`
        SELECT json FROM compiled_records
        WHERE simulation_id = ? AND kind = ?
        ORDER BY id
      `)
      .all(simulationId, kind);

    return rows.map((row) => JSON.parse(row.json as string) as TRecord);
  }

  listBeliefs(simulationId = "default"): BeliefRecord[] {
    return this.listCompiledRecords<BeliefRecord>(simulationId, "belief");
  }

  listAccessLinks(simulationId = "default"): AccessLinkRecord[] {
    return this.listCompiledRecords<AccessLinkRecord>(simulationId, "access_link");
  }

  listBeliefHistory(simulationId = "default"): Array<BeliefRecord | ExtractedBeliefRecord> {
    return [
      ...this.listBeliefs(simulationId),
      ...this.listExtractedBeliefs(simulationId)
    ];
  }

  listAccessibleTurns(simulationId = "default", actorId: string): TranscriptTurn[] {
    return this.listTurns({ simulationId, actorId, unclosedOnly: false });
  }

  listUnclosedAccessibleTurns(simulationId = "default", actorId: string): TranscriptTurn[] {
    return this.listTurns({ simulationId, actorId, unclosedOnly: true });
  }

  listUnclosedTurns(simulationId = "default"): TranscriptTurn[] {
    return this.listTurns({ simulationId, unclosedOnly: true });
  }

  markTurnsClosed({
    simulationId = "default",
    episodeId,
    turnIds
  }: {
    simulationId?: string;
    episodeId: number | bigint;
    turnIds: Array<number | bigint>;
  }): void {
    if (turnIds.length === 0) return;

    const update = this.requireDb().prepare(`
      UPDATE transcript_turns
      SET episode_id = ?
      WHERE simulation_id = ? AND id = ? AND episode_id IS NULL
    `);

    for (const turnId of turnIds) {
      update.run(episodeId, simulationId, turnId);
    }
  }

  private listTurns({
    simulationId,
    actorId,
    unclosedOnly
  }: {
    simulationId: string;
    actorId?: string;
    unclosedOnly: boolean;
  }): TranscriptTurn[] {
    const rows = this.requireDb()
      .prepare(`
        SELECT id, simulation_id, actor_id, text, audience_json, episode_id, created_at
        FROM transcript_turns
        WHERE simulation_id = ?
          AND (? = 0 OR episode_id IS NULL)
        ORDER BY id
      `)
      .all(simulationId, unclosedOnly ? 1 : 0);

    return rows
      .map((row) => ({
        id: row.id as number | bigint,
        simulationId: row.simulation_id as string,
        actorId: row.actor_id as string,
        text: row.text as string,
        audience: JSON.parse(row.audience_json as string) as string[],
        episodeId: row.episode_id as number | bigint | null,
        createdAt: row.created_at as string
      }))
      .filter((turn) => !actorId || turn.audience.length === 0 || turn.audience.includes(actorId));
  }

  appendTurn({
    simulationId = "default",
    actorId,
    text,
    audience = []
  }: {
    simulationId?: string;
    actorId: string;
    text: string;
    audience?: string[];
  }): TranscriptTurn {
    const createdAt = new Date().toISOString();
    const result = this.requireDb()
      .prepare(`
        INSERT INTO transcript_turns (simulation_id, actor_id, text, audience_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(simulationId, actorId, text, JSON.stringify(audience), createdAt);

    return {
      id: result.lastInsertRowid,
      simulationId,
      actorId,
      text,
      audience,
      episodeId: null,
      createdAt
    };
  }

  createEpisode({
    simulationId = "default",
    label = null
  }: {
    simulationId?: string;
    label?: string | null;
  }): EpisodeRecord {
    const closedAt = new Date().toISOString();
    const result = this.requireDb()
      .prepare(`
        INSERT INTO episodes (simulation_id, label, closed_at)
        VALUES (?, ?, ?)
      `)
      .run(simulationId, label, closedAt);

    return {
      id: result.lastInsertRowid,
      simulationId,
      label,
      closedAt
    };
  }

  createEpisodeMemory({
    episodeId,
    simulationId = "default",
    actorId,
    text,
    sourceTurnIds
  }: {
    episodeId: number | bigint;
    simulationId?: string;
    actorId: string;
    text: string;
    sourceTurnIds: Array<number | bigint>;
  }): EpisodeMemoryRecord {
    const createdAt = new Date().toISOString();
    const result = this.requireDb()
      .prepare(`
        INSERT INTO episode_memories (
          episode_id,
          simulation_id,
          actor_id,
          text,
          source_turn_ids_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(episodeId, simulationId, actorId, text, JSON.stringify(sourceTurnIds), createdAt);

    return {
      id: result.lastInsertRowid,
      episodeId,
      simulationId,
      actorId,
      text,
      sourceTurnIds,
      createdAt
    };
  }

  listEpisodeMemories(simulationId = "default"): EpisodeMemoryRecord[] {
    const rows = this.requireDb()
      .prepare(`
        SELECT id, episode_id, simulation_id, actor_id, text, source_turn_ids_json, created_at
        FROM episode_memories
        WHERE simulation_id = ?
        ORDER BY id
      `)
      .all(simulationId);

    return rows.map((row) => ({
      id: row.id as number | bigint,
      episodeId: row.episode_id as number | bigint,
      simulationId: row.simulation_id as string,
      actorId: row.actor_id as string,
      text: row.text as string,
      sourceTurnIds: JSON.parse(row.source_turn_ids_json as string) as Array<number | bigint>,
      createdAt: row.created_at as string
    }));
  }

  createExtractedBelief({
    episodeId,
    memoryId,
    simulationId = "default",
    holder,
    strength,
    propositionText
  }: {
    episodeId: number | bigint;
    memoryId: number | bigint;
    simulationId?: string;
    holder: string;
    strength: number;
    propositionText: string;
  }): ExtractedBeliefRecord {
    const createdAt = new Date().toISOString();
    const result = this.requireDb()
      .prepare(`
        INSERT INTO extracted_beliefs (
          episode_id,
          memory_id,
          simulation_id,
          holder,
          strength,
          proposition_text,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(episodeId, memoryId, simulationId, holder, strength, propositionText, createdAt);

    return {
      id: result.lastInsertRowid,
      episodeId,
      memoryId,
      simulationId,
      holder,
      strength,
      propositionText,
      createdAt
    };
  }

  listExtractedBeliefs(simulationId = "default"): ExtractedBeliefRecord[] {
    const rows = this.requireDb()
      .prepare(`
        SELECT
          id,
          episode_id,
          memory_id,
          simulation_id,
          holder,
          strength,
          proposition_text,
          created_at
        FROM extracted_beliefs
        WHERE simulation_id = ?
        ORDER BY id
      `)
      .all(simulationId);

    return rows.map((row) => ({
      id: row.id as number | bigint,
      episodeId: row.episode_id as number | bigint,
      memoryId: row.memory_id as number | bigint,
      simulationId: row.simulation_id as string,
      holder: row.holder as string,
      strength: row.strength as number,
      propositionText: row.proposition_text as string,
      createdAt: row.created_at as string
    }));
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("Runtime store is not open.");
    }

    return this.db;
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.requireDb().prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((row) => row.name === column)) return;

    this.requireDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
