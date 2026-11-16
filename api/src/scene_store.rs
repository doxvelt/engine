use crate::{
    error::{EngineError, ErrorCode, Result},
    model::Command,
    ports::SimulationReader,
    scene,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::{path::Path, time::Duration};
fn sql(error: rusqlite::Error) -> EngineError {
    EngineError {
        code: ErrorCode::Internal,
        message: error.to_string(),
    }
}
pub struct SceneHeadingStore {
    connection: Connection,
}
impl SceneHeadingStore {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path).map_err(sql)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(sql)?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS scene_headings (owner TEXT NOT NULL,story TEXT NOT NULL,command TEXT NOT NULL,input TEXT NOT NULL,heading TEXT NOT NULL,PRIMARY KEY(owner,story,command))").map_err(sql)?;
        Ok(Self { connection })
    }
    pub fn create(
        &self,
        reader: &impl SimulationReader,
        command: &Command,
        title: &str,
    ) -> Result<Value> {
        let input = scene::validate(command, title)?;
        let prior = self
            .connection
            .query_row(
                "SELECT input,heading FROM scene_headings WHERE owner=? AND story=? AND command=?",
                params![
                    command.owner_scope,
                    command.simulation_id,
                    command.command_id
                ],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(sql)?;
        if let Some((previous, heading)) = prior {
            if previous != input {
                return Err(EngineError::command_conflict(
                    "This scene command was already used for another heading.",
                ));
            }
            let heading: Value =
                serde_json::from_str(&heading).map_err(|e| EngineError::invalid(e.to_string()))?;
            return Ok(scene::public(&heading, None));
        }
        let heading = scene::make(reader, command, title)?;
        self.connection
            .execute(
                "INSERT INTO scene_headings VALUES (?,?,?,?,?)",
                params![
                    command.owner_scope,
                    command.simulation_id,
                    command.command_id,
                    input,
                    serde_json::to_string(&heading).unwrap()
                ],
            )
            .map_err(sql)?;
        Ok(scene::public(&heading, None))
    }
    pub fn list(
        &self,
        reader: &impl SimulationReader,
        owner: &str,
        simulation: &str,
        branch: &str,
        head: Option<&str>,
    ) -> Result<Vec<Value>> {
        let records = self
            .connection
            .prepare("SELECT heading FROM scene_headings WHERE owner=? AND story=? ORDER BY rowid")
            .map_err(sql)?
            .query_map(params![owner, simulation], |r| {
                let value: String = r.get(0)?;
                serde_json::from_str::<Value>(&value).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })
            })
            .map_err(sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql)?;
        scene::project(reader, owner, simulation, branch, head, &records)
    }
}
