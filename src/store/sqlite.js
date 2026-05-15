import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openRuntimeStore(dbPath = ".doxvelt/runtime.sqlite") {
  const resolved = path.resolve(dbPath);
  return new RuntimeStore(resolved);
}

export class RuntimeStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async open() {
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
        created_at TEXT NOT NULL
      );
    `);
    return this;
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  saveSimulation({ id, sourceRoot, scenarioId, compiled }) {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO simulations (id, source_root, scenario_id, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_root = excluded.source_root,
          scenario_id = excluded.scenario_id
      `)
      .run(id, sourceRoot, scenarioId || null, createdAt);

    this.db.prepare("DELETE FROM compiled_records WHERE simulation_id = ?").run(id);

    const insert = this.db.prepare(`
      INSERT INTO compiled_records (simulation_id, kind, id, json)
      VALUES (?, ?, ?, ?)
    `);

    for (const entity of compiled.entities) {
      insert.run(id, "entity", entity.id, JSON.stringify(entity));
    }

    for (const model of compiled.models) {
      insert.run(id, "model", model.id, JSON.stringify(model));
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
  }

  listActors(simulationId = "default") {
    const rows = this.db
      .prepare(`
        SELECT json FROM compiled_records
        WHERE simulation_id = ? AND kind = 'entity'
        ORDER BY id
      `)
      .all(simulationId);

    return rows.map((row) => JSON.parse(row.json)).filter((entity) => entity.kind !== "artifact");
  }

  getSimulation(simulationId = "default") {
    const row = this.db
      .prepare(`
        SELECT id, source_root, scenario_id, created_at
        FROM simulations
        WHERE id = ?
      `)
      .get(simulationId);

    if (!row) return null;

    return {
      id: row.id,
      sourceRoot: row.source_root,
      scenarioId: row.scenario_id,
      createdAt: row.created_at
    };
  }

  getCompiledRecord(simulationId, kind, id) {
    const row = this.db
      .prepare(`
        SELECT json FROM compiled_records
        WHERE simulation_id = ? AND kind = ? AND id = ?
      `)
      .get(simulationId, kind, id);

    return row ? JSON.parse(row.json) : null;
  }

  listCompiledRecords(simulationId, kind) {
    const rows = this.db
      .prepare(`
        SELECT json FROM compiled_records
        WHERE simulation_id = ? AND kind = ?
        ORDER BY id
      `)
      .all(simulationId, kind);

    return rows.map((row) => JSON.parse(row.json));
  }

  listBeliefs(simulationId = "default") {
    return this.listCompiledRecords(simulationId, "belief");
  }

  listAccessibleTurns(simulationId = "default", actorId) {
    const rows = this.db
      .prepare(`
        SELECT id, simulation_id, actor_id, text, audience_json, created_at
        FROM transcript_turns
        WHERE simulation_id = ?
        ORDER BY id
      `)
      .all(simulationId);

    return rows
      .map((row) => ({
        id: row.id,
        simulationId: row.simulation_id,
        actorId: row.actor_id,
        text: row.text,
        audience: JSON.parse(row.audience_json),
        createdAt: row.created_at
      }))
      .filter((turn) => turn.audience.length === 0 || turn.audience.includes(actorId));
  }

  appendTurn({ simulationId = "default", actorId, text, audience = [] }) {
    const createdAt = new Date().toISOString();
    const result = this.db
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
      createdAt
    };
  }
}
