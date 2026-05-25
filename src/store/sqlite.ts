import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AccessLinkRecord,
  AssetRecord,
  AudienceEventRecord,
  AudienceMemberRecord,
  BeliefRecord,
  CompiledWorld,
  EntityRecord,
  EpisodeMemoryRecord,
  EpisodeRecord,
  ExtractedBeliefRecord,
  FirstImpressionRecord,
  LongTermMemoryRecord,
  RetainedBeliefRecord,
  RuntimeAccessEventRecord,
  SimulationRecord,
  StageWhisperRecord,
  SurfaceRecord,
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

      CREATE TABLE IF NOT EXISTS long_term_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL,
        episode_memory_id INTEGER NOT NULL,
        simulation_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        text TEXT NOT NULL,
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

      CREATE TABLE IF NOT EXISTS runtime_access_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        simulation_id TEXT NOT NULL,
        action TEXT NOT NULL,
        member TEXT NOT NULL,
        container TEXT NOT NULL,
        mode TEXT NOT NULL,
        reason TEXT,
        turn_id INTEGER,
        episode_id INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stage_whispers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        simulation_id TEXT NOT NULL,
        target_actor_id TEXT NOT NULL,
        text TEXT NOT NULL,
        consumed_turn_id INTEGER,
        created_at TEXT NOT NULL,
        consumed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS audience_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        simulation_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        turn_id INTEGER,
        episode_id INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS first_impressions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        simulation_id TEXT NOT NULL,
        observer_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        strength INTEGER NOT NULL,
        proposition_text TEXT NOT NULL,
        surface_source_span_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(simulation_id, observer_id, entity_id)
      );

      CREATE TABLE IF NOT EXISTS retained_beliefs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL,
        simulation_id TEXT NOT NULL,
        holder TEXT NOT NULL,
        strength INTEGER NOT NULL,
        proposition_text TEXT NOT NULL,
        source_holder TEXT NOT NULL,
        access_path_json TEXT NOT NULL,
        source_belief_json TEXT NOT NULL,
        runtime_access_event_id INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE(simulation_id, holder, source_holder, proposition_text, runtime_access_event_id)
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

    for (const surface of compiled.surfaces) {
      insert.run(id, "surface", `${surface.entity}:${surface.sourceSpan.file}:${surface.sourceSpan.line}`, JSON.stringify(surface));
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

  getCompiledRecord<TRecord extends AssetRecord | EntityRecord | BeliefRecord | AccessLinkRecord | SurfaceRecord>(
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

  listCompiledRecords<TRecord extends AssetRecord | EntityRecord | BeliefRecord | AccessLinkRecord | SurfaceRecord>(
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

  listSurfaces(simulationId = "default"): SurfaceRecord[] {
    return this.listCompiledRecords<SurfaceRecord>(simulationId, "surface");
  }

  listEffectiveAccessLinks(simulationId = "default"): AccessLinkRecord[] {
    return this.resolveEffectiveAccessLinks(simulationId, this.listRuntimeAccessEvents(simulationId));
  }

  listEffectiveAccessLinksBeforeEvent(
    simulationId = "default",
    runtimeAccessEventId: number | bigint
  ): AccessLinkRecord[] {
    return this.resolveEffectiveAccessLinks(
      simulationId,
      this.listRuntimeAccessEvents(simulationId).filter((event) => BigInt(event.id) < BigInt(runtimeAccessEventId))
    );
  }

  private resolveEffectiveAccessLinks(
    simulationId: string,
    events: RuntimeAccessEventRecord[]
  ): AccessLinkRecord[] {
    const effective = new Map<string, AccessLinkRecord>();

    for (const link of this.listAccessLinks(simulationId)) {
      effective.set(accessLinkKey(link.member, link.container, link.mode), link);
    }

    for (const event of events) {
      const key = accessLinkKey(event.member, event.container, event.mode);
      if (event.action === "revoke") {
        effective.delete(key);
        continue;
      }

      effective.set(key, runtimeAccessEventToLink(event));
    }

    return [...effective.values()];
  }

  appendRuntimeAccessEvent({
    simulationId = "default",
    action,
    member,
    container,
    mode = "member",
    reason = null,
    turnId = null,
    episodeId = null
  }: {
    simulationId?: string;
    action: "grant" | "revoke";
    member: string;
    container: string;
    mode?: "member";
    reason?: string | null;
    turnId?: number | bigint | null;
    episodeId?: number | bigint | null;
  }): RuntimeAccessEventRecord {
    const createdAt = new Date().toISOString();
    const result = this.requireDb()
      .prepare(`
        INSERT INTO runtime_access_events (
          simulation_id,
          action,
          member,
          container,
          mode,
          reason,
          turn_id,
          episode_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(simulationId, action, member, container, mode, reason, turnId, episodeId, createdAt);

    return {
      id: result.lastInsertRowid,
      simulationId,
      action,
      member,
      container,
      mode,
      reason,
      turnId,
      episodeId,
      createdAt
    };
  }

  listRuntimeAccessEvents(simulationId = "default"): RuntimeAccessEventRecord[] {
    const rows = this.requireDb()
      .prepare(`
        SELECT
          id,
          simulation_id,
          action,
          member,
          container,
          mode,
          reason,
          turn_id,
          episode_id,
          created_at
        FROM runtime_access_events
        WHERE simulation_id = ?
        ORDER BY id
      `)
      .all(simulationId);

    return rows.map((row) => ({
      id: row.id as number | bigint,
      simulationId: row.simulation_id as string,
      action: runtimeAccessAction(row.action),
      member: row.member as string,
      container: row.container as string,
      mode: runtimeAccessMode(row.mode),
      reason: row.reason as string | null,
      turnId: row.turn_id as number | bigint | null,
      episodeId: row.episode_id as number | bigint | null,
      createdAt: row.created_at as string
    }));
  }

  listBeliefHistory(
    simulationId = "default"
  ): Array<BeliefRecord | ExtractedBeliefRecord | FirstImpressionRecord | RetainedBeliefRecord> {
    return [
      ...this.listBeliefs(simulationId),
      ...this.listFirstImpressions(simulationId),
      ...this.listExtractedBeliefs(simulationId),
      ...this.listRetainedBeliefs(simulationId)
    ];
  }

  listNonRetainedBeliefHistory(
    simulationId = "default"
  ): Array<BeliefRecord | ExtractedBeliefRecord | FirstImpressionRecord> {
    return [
      ...this.listBeliefs(simulationId),
      ...this.listFirstImpressions(simulationId),
      ...this.listExtractedBeliefs(simulationId)
    ];
  }

  createFirstImpression({
    simulationId = "default",
    observerId,
    entityId,
    strength,
    propositionText,
    surfaceSourceSpan
  }: {
    simulationId?: string;
    observerId: string;
    entityId: string;
    strength: number;
    propositionText: string;
    surfaceSourceSpan: FirstImpressionRecord["surfaceSourceSpan"];
  }): FirstImpressionRecord {
    const createdAt = new Date().toISOString();
    const result = this.requireDb()
      .prepare(`
        INSERT OR IGNORE INTO first_impressions (
          simulation_id,
          observer_id,
          entity_id,
          strength,
          proposition_text,
          surface_source_span_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        simulationId,
        observerId,
        entityId,
        strength,
        propositionText,
        JSON.stringify(surfaceSourceSpan),
        createdAt
      );

    if (result.changes === 0) {
      const existing = this.getFirstImpression(simulationId, observerId, entityId);
      if (!existing) throw new Error(`Failed to create or load first impression for ${observerId} -> ${entityId}`);
      return existing;
    }

    return {
      id: result.lastInsertRowid,
      simulationId,
      holder: observerId,
      observerId,
      entityId,
      strength,
      propositionText,
      surfaceSourceSpan,
      createdAt
    };
  }

  getFirstImpression(
    simulationId = "default",
    observerId: string,
    entityId: string
  ): FirstImpressionRecord | null {
    const row = this.requireDb()
      .prepare(`
        SELECT
          id,
          simulation_id,
          observer_id,
          entity_id,
          strength,
          proposition_text,
          surface_source_span_json,
          created_at
        FROM first_impressions
        WHERE simulation_id = ?
          AND observer_id = ?
          AND entity_id = ?
      `)
      .get(simulationId, observerId, entityId);

    return row ? rowToFirstImpression(row) : null;
  }

  listFirstImpressions(simulationId = "default"): FirstImpressionRecord[] {
    const rows = this.requireDb()
      .prepare(`
        SELECT
          id,
          simulation_id,
          observer_id,
          entity_id,
          strength,
          proposition_text,
          surface_source_span_json,
          created_at
        FROM first_impressions
        WHERE simulation_id = ?
        ORDER BY id
      `)
      .all(simulationId);

    return rows.map(rowToFirstImpression);
  }

  listAccessibleTurns(simulationId = "default", actorId: string): TranscriptTurn[] {
    return this.listTurns({ simulationId, actorId, unclosedOnly: false });
  }

  appendAudienceEvent({
    simulationId = "default",
    actorId,
    action,
    reason = null,
    turnId = null,
    episodeId = null
  }: {
    simulationId?: string;
    actorId: string;
    action: AudienceEventRecord["action"];
    reason?: string | null;
    turnId?: number | bigint | null;
    episodeId?: number | bigint | null;
  }): AudienceEventRecord {
    const createdAt = new Date().toISOString();
    const result = this.requireDb()
      .prepare(`
        INSERT INTO audience_events (
          simulation_id,
          actor_id,
          action,
          reason,
          turn_id,
          episode_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(simulationId, actorId, action, reason, turnId, episodeId, createdAt);

    return {
      id: result.lastInsertRowid,
      simulationId,
      actorId,
      action,
      reason,
      turnId,
      episodeId,
      createdAt
    };
  }

  listAudienceEvents(simulationId = "default"): AudienceEventRecord[] {
    const rows = this.requireDb()
      .prepare(`
        SELECT id, simulation_id, actor_id, action, reason, turn_id, episode_id, created_at
        FROM audience_events
        WHERE simulation_id = ?
        ORDER BY id
      `)
      .all(simulationId);

    return rows.map((row) => ({
      id: row.id as number | bigint,
      simulationId: row.simulation_id as string,
      actorId: row.actor_id as string,
      action: audienceAction(row.action),
      reason: row.reason as string | null,
      turnId: row.turn_id as number | bigint | null,
      episodeId: row.episode_id as number | bigint | null,
      createdAt: row.created_at as string
    }));
  }

  listAudienceMembers(simulationId = "default"): AudienceMemberRecord[] {
    const members = new Map<string, AudienceMemberRecord>();

    for (const event of this.listAudienceEvents(simulationId)) {
      if (event.action === "remove") {
        members.delete(event.actorId);
      } else if (event.action === "deactivate") {
        members.set(event.actorId, { actorId: event.actorId, status: "inactive" });
      } else {
        members.set(event.actorId, { actorId: event.actorId, status: "active" });
      }
    }

    return [...members.values()];
  }

  listActiveAudienceIds(simulationId = "default"): string[] {
    return this.listAudienceMembers(simulationId)
      .filter((member) => member.status === "active")
      .map((member) => member.actorId);
  }

  listUnclosedAccessibleTurns(simulationId = "default", actorId: string): TranscriptTurn[] {
    return this.listTurns({ simulationId, actorId, unclosedOnly: true });
  }

  listUnclosedTurns(simulationId = "default"): TranscriptTurn[] {
    return this.listTurns({ simulationId, unclosedOnly: true });
  }

  listTranscript(simulationId = "default"): TranscriptTurn[] {
    return this.listTurns({ simulationId, unclosedOnly: false });
  }

  createStageWhisper({
    simulationId = "default",
    targetActorId,
    text
  }: {
    simulationId?: string;
    targetActorId: string;
    text: string;
  }): StageWhisperRecord {
    const createdAt = new Date().toISOString();
    const result = this.requireDb()
      .prepare(`
        INSERT INTO stage_whispers (simulation_id, target_actor_id, text, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(simulationId, targetActorId, text, createdAt);

    return {
      id: result.lastInsertRowid,
      simulationId,
      targetActorId,
      text,
      consumedTurnId: null,
      createdAt,
      consumedAt: null
    };
  }

  listPendingStageWhispers(simulationId = "default", targetActorId: string): StageWhisperRecord[] {
    const rows = this.requireDb()
      .prepare(`
        SELECT id, simulation_id, target_actor_id, text, consumed_turn_id, created_at, consumed_at
        FROM stage_whispers
        WHERE simulation_id = ?
          AND target_actor_id = ?
          AND consumed_turn_id IS NULL
        ORDER BY id
      `)
      .all(simulationId, targetActorId);

    return rows.map(rowToStageWhisper);
  }

  listStageWhispers(simulationId = "default"): StageWhisperRecord[] {
    const rows = this.requireDb()
      .prepare(`
        SELECT id, simulation_id, target_actor_id, text, consumed_turn_id, created_at, consumed_at
        FROM stage_whispers
        WHERE simulation_id = ?
        ORDER BY id
      `)
      .all(simulationId);

    return rows.map(rowToStageWhisper);
  }

  consumePendingStageWhispers({
    simulationId = "default",
    targetActorId,
    turnId
  }: {
    simulationId?: string;
    targetActorId: string;
    turnId: number | bigint;
  }): StageWhisperRecord[] {
    const pending = this.listPendingStageWhispers(simulationId, targetActorId);
    if (pending.length === 0) return [];

    const consumedAt = new Date().toISOString();
    const update = this.requireDb().prepare(`
      UPDATE stage_whispers
      SET consumed_turn_id = ?, consumed_at = ?
      WHERE simulation_id = ? AND id = ? AND consumed_turn_id IS NULL
    `);

    for (const whisper of pending) {
      update.run(turnId, consumedAt, simulationId, whisper.id);
    }

    return pending.map((whisper) => ({
      ...whisper,
      consumedTurnId: turnId,
      consumedAt
    }));
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
    audience = [],
    consumeStageWhispers = true
  }: {
    simulationId?: string;
    actorId: string;
    text: string;
    audience?: string[];
    consumeStageWhispers?: boolean;
  }): TranscriptTurn {
    const createdAt = new Date().toISOString();
    const result = this.requireDb()
      .prepare(`
        INSERT INTO transcript_turns (simulation_id, actor_id, text, audience_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(simulationId, actorId, text, JSON.stringify(audience), createdAt);

    const turn = {
      id: result.lastInsertRowid,
      simulationId,
      actorId,
      text,
      audience,
      episodeId: null,
      createdAt
    };

    if (consumeStageWhispers) {
      this.consumePendingStageWhispers({
        simulationId,
        targetActorId: actorId,
        turnId: turn.id
      });
    }

    return turn;
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

  createLongTermMemory({
    episodeId,
    episodeMemoryId,
    simulationId = "default",
    actorId,
    text
  }: {
    episodeId: number | bigint;
    episodeMemoryId: number | bigint;
    simulationId?: string;
    actorId: string;
    text: string;
  }): LongTermMemoryRecord {
    const createdAt = new Date().toISOString();
    const result = this.requireDb()
      .prepare(`
        INSERT INTO long_term_memories (
          episode_id,
          episode_memory_id,
          simulation_id,
          actor_id,
          text,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(episodeId, episodeMemoryId, simulationId, actorId, text, createdAt);

    return {
      id: result.lastInsertRowid,
      episodeId,
      episodeMemoryId,
      simulationId,
      actorId,
      text,
      createdAt
    };
  }

  listLongTermMemories(simulationId = "default", actorId?: string): LongTermMemoryRecord[] {
    const rows = this.requireDb()
      .prepare(`
        SELECT id, episode_id, episode_memory_id, simulation_id, actor_id, text, created_at
        FROM long_term_memories
        WHERE simulation_id = ?
          AND (? IS NULL OR actor_id = ?)
        ORDER BY id
      `)
      .all(simulationId, actorId || null, actorId || null);

    return rows.map((row) => ({
      id: row.id as number | bigint,
      episodeId: row.episode_id as number | bigint,
      episodeMemoryId: row.episode_memory_id as number | bigint,
      simulationId: row.simulation_id as string,
      actorId: row.actor_id as string,
      text: row.text as string,
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

  createRetainedBelief({
    episodeId,
    simulationId = "default",
    holder,
    strength,
    propositionText,
    sourceHolder,
    accessPath,
    sourceBelief,
    runtimeAccessEventId = null
  }: {
    episodeId: number | bigint;
    simulationId?: string;
    holder: string;
    strength: number;
    propositionText: string;
    sourceHolder: string;
    accessPath: string[];
    sourceBelief: RetainedBeliefRecord["sourceBelief"];
    runtimeAccessEventId?: number | bigint | null;
  }): RetainedBeliefRecord {
    const createdAt = new Date().toISOString();
    const result = this.requireDb()
      .prepare(`
        INSERT OR IGNORE INTO retained_beliefs (
          episode_id,
          simulation_id,
          holder,
          strength,
          proposition_text,
          source_holder,
          access_path_json,
          source_belief_json,
          runtime_access_event_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        episodeId,
        simulationId,
        holder,
        strength,
        propositionText,
        sourceHolder,
        JSON.stringify(accessPath),
        JSON.stringify(sourceBelief),
        runtimeAccessEventId,
        createdAt
      );

    if (result.changes === 0) {
      const existing = this.getRetainedBelief({
        simulationId,
        holder,
        sourceHolder,
        propositionText,
        runtimeAccessEventId
      });
      if (!existing) throw new Error(`Failed to create or load retained belief for ${holder}`);
      return existing;
    }

    return {
      id: result.lastInsertRowid,
      episodeId,
      simulationId,
      holder,
      strength,
      propositionText,
      sourceHolder,
      accessPath,
      sourceBelief,
      runtimeAccessEventId,
      createdAt
    };
  }

  getRetainedBelief({
    simulationId = "default",
    holder,
    sourceHolder,
    propositionText,
    runtimeAccessEventId
  }: {
    simulationId?: string;
    holder: string;
    sourceHolder: string;
    propositionText: string;
    runtimeAccessEventId: number | bigint | null;
  }): RetainedBeliefRecord | null {
    const row = this.requireDb()
      .prepare(`
        SELECT
          id,
          episode_id,
          simulation_id,
          holder,
          strength,
          proposition_text,
          source_holder,
          access_path_json,
          source_belief_json,
          runtime_access_event_id,
          created_at
        FROM retained_beliefs
        WHERE simulation_id = ?
          AND holder = ?
          AND source_holder = ?
          AND proposition_text = ?
          AND (
            (runtime_access_event_id IS NULL AND ? IS NULL)
            OR runtime_access_event_id = ?
          )
      `)
      .get(simulationId, holder, sourceHolder, propositionText, runtimeAccessEventId, runtimeAccessEventId);

    return row ? rowToRetainedBelief(row) : null;
  }

  listRetainedBeliefs(simulationId = "default"): RetainedBeliefRecord[] {
    const rows = this.requireDb()
      .prepare(`
        SELECT
          id,
          episode_id,
          simulation_id,
          holder,
          strength,
          proposition_text,
          source_holder,
          access_path_json,
          source_belief_json,
          runtime_access_event_id,
          created_at
        FROM retained_beliefs
        WHERE simulation_id = ?
        ORDER BY id
      `)
      .all(simulationId);

    return rows.map(rowToRetainedBelief);
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

function accessLinkKey(member: string, container: string, mode: "member"): string {
  return `${mode}:${member}:${container}`;
}

function runtimeAccessEventToLink(event: RuntimeAccessEventRecord): AccessLinkRecord {
  return {
    member: event.member,
    container: event.container,
    mode: event.mode,
    sourceSpan: {
      file: "runtime",
      line: Number(event.id),
      quote: event.reason || `${event.action} ${event.member} ${event.mode} access to ${event.container}`
    }
  };
}

function runtimeAccessAction(value: unknown): RuntimeAccessEventRecord["action"] {
  if (value === "grant" || value === "revoke") return value;
  throw new Error(`Invalid runtime access action: ${String(value)}`);
}

function runtimeAccessMode(value: unknown): RuntimeAccessEventRecord["mode"] {
  if (value === "member") return value;
  throw new Error(`Invalid runtime access mode: ${String(value)}`);
}

function rowToStageWhisper(row: Record<string, unknown>): StageWhisperRecord {
  return {
    id: row.id as number | bigint,
    simulationId: row.simulation_id as string,
    targetActorId: row.target_actor_id as string,
    text: row.text as string,
    consumedTurnId: row.consumed_turn_id as number | bigint | null,
    createdAt: row.created_at as string,
    consumedAt: row.consumed_at as string | null
  };
}

function audienceAction(value: unknown): AudienceEventRecord["action"] {
  if (value === "add" || value === "remove" || value === "deactivate" || value === "reactivate") {
    return value;
  }

  throw new Error(`Invalid audience action: ${String(value)}`);
}

function rowToFirstImpression(row: Record<string, unknown>): FirstImpressionRecord {
  const observerId = row.observer_id as string;
  return {
    id: row.id as number | bigint,
    simulationId: row.simulation_id as string,
    holder: observerId,
    observerId,
    entityId: row.entity_id as string,
    strength: row.strength as number,
    propositionText: row.proposition_text as string,
    surfaceSourceSpan: JSON.parse(row.surface_source_span_json as string),
    createdAt: row.created_at as string
  };
}

function rowToRetainedBelief(row: Record<string, unknown>): RetainedBeliefRecord {
  return {
    id: row.id as number | bigint,
    episodeId: row.episode_id as number | bigint,
    simulationId: row.simulation_id as string,
    holder: row.holder as string,
    strength: row.strength as number,
    propositionText: row.proposition_text as string,
    sourceHolder: row.source_holder as string,
    accessPath: JSON.parse(row.access_path_json as string) as string[],
    sourceBelief: JSON.parse(row.source_belief_json as string) as RetainedBeliefRecord["sourceBelief"],
    runtimeAccessEventId: row.runtime_access_event_id as number | bigint | null,
    createdAt: row.created_at as string
  };
}
