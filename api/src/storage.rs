use crate::{
    error::{EngineError, ErrorCode, Result},
    identity::{domain_id, fingerprint},
    model::*,
};
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;
mod alternatives;
mod archive;
mod drafts;
mod navigation;

pub struct Store {
    connection: Connection,
}
impl crate::ports::SimulationReader for Store {
    fn actor_draft(&self, owner: &str, simulation: &str, id: &str) -> Result<Option<Value>> {
        Store::actor_draft(self, owner, simulation, id)
    }
    fn pending_whispers(
        &self,
        owner: &str,
        simulation: &str,
        branch: &str,
        head: &str,
        actor: &str,
    ) -> Result<Vec<Value>> {
        Store::pending_whispers(self, owner, simulation, branch, head, actor)
    }
    fn revision(&self, owner: &str, id: &str) -> Result<Option<ContentRevision>> {
        Store::revision(self, owner, id)
    }
    fn simulation(&self, owner: &str, id: &str) -> Result<Option<Simulation>> {
        Store::simulation(self, owner, id)
    }
    fn branch(&self, owner: &str, simulation: &str, id: &str) -> Result<Option<Branch>> {
        Store::branch(self, owner, simulation, id)
    }
    fn commit(&self, owner: &str, simulation: &str, id: &str) -> Result<Option<Commit>> {
        Store::commit(self, owner, simulation, id)
    }
    fn ancestry(&self, owner: &str, simulation: &str, head: &str) -> Result<Vec<Commit>> {
        Store::ancestry(self, owner, simulation, head)
    }
    fn memory_jobs(&self, owner: &str, simulation: &str) -> Result<Vec<Value>> {
        Store::memory_jobs(self, owner, simulation)
    }
    fn detached_memory_operations(&self, owner: &str, simulation: &str) -> Result<Vec<Value>> {
        Store::detached_memory_operations(self, owner, simulation)
    }
}
impl crate::ports::SimulationRepository for Store {
    fn start_memory_job(&mut self, owner: &str, simulation: &str, job: &str) -> Result<Value> {
        Store::start_memory_job(self, owner, simulation, job)
    }
    fn settle_memory_job(&mut self, job: &Value, result: Option<&Value>) -> Result<Value> {
        Store::settle_memory_job(self, job, result)
    }
    fn request_closure(
        &mut self,
        command: &Value,
        commit: Commit,
        job: Value,
    ) -> Result<(Committed, Value)> {
        let result = self.append_commit_with_job(command, commit, Some(&job))?;
        let persisted = self
            .memory_jobs(&result.commit.owner_scope, &result.commit.simulation_id)?
            .into_iter()
            .find(|j| j["id"] == job["id"])
            .ok_or_else(|| invalid("Replayed closure has no memory job."))?;
        Ok((result, persisted))
    }
    fn replay_whisper(&self, command: &Value) -> Result<Option<Value>> {
        read_whisper_replay(&self.connection, command)
    }
    fn create_whisper(&mut self, command: &Value, whisper: Value) -> Result<Value> {
        Store::create_whisper(self, command, whisper)
    }
    fn replay_branch(&self, command: &Value) -> Result<Option<BranchOutcome>> {
        read_branch_replay(&self.connection, command)
    }
    fn create_branch(
        &mut self,
        command: &Value,
        branch: Branch,
        commit: Option<Commit>,
    ) -> Result<BranchOutcome> {
        Store::create_branch(self, command, branch, commit)
    }
    fn replay_commit(&self, command: &Value) -> Result<Option<Committed>> {
        read_commit_replay(&self.connection, command)
    }
    fn append_commit(&mut self, command: &Value, commit: Commit) -> Result<Committed> {
        Store::append_commit(self, command, commit)
    }
    fn start_simulation(&mut self, input: StartSimulation) -> Result<StartedSimulation> {
        Store::start_simulation(self, input)
    }
}
fn sql_error(error: rusqlite::Error) -> EngineError {
    EngineError {
        code: ErrorCode::Internal,
        message: error.to_string(),
    }
}
fn parse<T: DeserializeOwned>(value: String) -> rusqlite::Result<T> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}
fn json_text(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).expect("serializable engine record")
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn invalid(message: impl Into<String>) -> EngineError {
    EngineError::invalid(message)
}

impl Store {
    /// One bounded initialization budget; a failed open never publishes a handle.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(|error| invalid(error.to_string()))?;
        }
        let connection = Connection::open(path).map_err(sql_error)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let remaining = || deadline.saturating_duration_since(Instant::now());
        connection.busy_timeout(remaining()).map_err(sql_error)?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON")
            .map_err(sql_error)?;
        loop {
            connection.busy_timeout(remaining()).map_err(sql_error)?;
            match connection.execute_batch("PRAGMA journal_mode = WAL") {
                Ok(()) => break,
                Err(rusqlite::Error::SqliteFailure(error, _))
                    if error.code == rusqlite::ErrorCode::DatabaseBusy
                        && !remaining().is_zero() =>
                {
                    thread::sleep(Duration::from_millis(25).min(remaining()))
                }
                Err(error) => return Err(sql_error(error)),
            }
        }
        for statement in include_str!("schema.sql")
            .split(';')
            .filter(|sql| !sql.trim().is_empty())
        {
            connection.busy_timeout(remaining()).map_err(sql_error)?;
            connection.execute_batch(statement).map_err(sql_error)?;
        }
        connection.busy_timeout(remaining()).map_err(sql_error)?;
        let has_result = connection
            .prepare("PRAGMA table_info(memory_jobs)")
            .map_err(sql_error)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?
            .iter()
            .any(|name| name == "result_json");
        if !has_result {
            connection
                .execute_batch("ALTER TABLE memory_jobs ADD COLUMN result_json TEXT")
                .map_err(sql_error)?;
        }
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(sql_error)?;
        Ok(Self { connection })
    }
    pub fn revision(&self, owner: &str, id: &str) -> Result<Option<ContentRevision>> {
        read_revision(&self.connection, owner, id).map_err(sql_error)
    }
    pub fn simulation(&self, owner: &str, id: &str) -> Result<Option<Simulation>> {
        read_simulation(&self.connection, owner, id).map_err(sql_error)
    }
    pub fn branch(&self, owner: &str, simulation: &str, id: &str) -> Result<Option<Branch>> {
        read_branch(&self.connection, owner, simulation, id).map_err(sql_error)
    }
    pub fn commit(&self, owner: &str, simulation: &str, id: &str) -> Result<Option<Commit>> {
        read_commit(&self.connection, owner, simulation, id).map_err(sql_error)
    }
    pub fn branches(&self, owner: &str, simulation: &str) -> Result<Vec<Branch>> {
        let ids = self.connection.prepare("SELECT id FROM branches WHERE owner_scope = ? AND simulation_id = ? ORDER BY created_at, id").map_err(sql_error)?
            .query_map(params![owner, simulation], |row| row.get::<_,String>(0)).map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)?;
        ids.into_iter()
            .map(|id| {
                self.branch(owner, simulation, &id)?
                    .ok_or_else(|| invalid("Branch disappeared during read."))
            })
            .collect()
    }
    pub fn ancestry(&self, owner: &str, simulation: &str, head: &str) -> Result<Vec<Commit>> {
        let mut commits = Vec::new();
        let mut next = Some(head.to_owned());
        let mut seen = std::collections::HashSet::new();
        while let Some(id) = next {
            if !seen.insert(id.clone()) {
                return Err(invalid("Cyclic commit ancestry."));
            }
            let commit = self
                .commit(owner, simulation, &id)?
                .ok_or_else(|| EngineError {
                    code: ErrorCode::NotFound,
                    message: format!("Commit not found: {id}"),
                })?;
            next = commit.parent_commit_id.clone();
            commits.push(commit);
        }
        commits.reverse();
        Ok(commits)
    }
    pub fn detached_memory_operations(&self, owner: &str, simulation: &str) -> Result<Vec<Value>> {
        self.connection.prepare("SELECT operation_json FROM detached_memory_operations WHERE owner_scope = ? AND simulation_id = ? ORDER BY rowid")
            .map_err(sql_error)?.query_map(params![owner, simulation], |row| parse(row.get(0)?))
            .map_err(sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)
    }
    pub fn actor_draft(&self, owner: &str, simulation: &str, id: &str) -> Result<Option<Value>> {
        drafts::read_actor_draft(&self.connection, owner, simulation, id)
    }
    pub fn recoverable_actor_drafts(
        &self,
        owner: &str,
        simulation: &str,
        branch: &str,
    ) -> Result<Vec<Value>> {
        let drafts = self.connection.prepare("SELECT draft_json FROM actor_turn_drafts WHERE owner_scope=? AND simulation_id=? AND json_extract(draft_json,'$.branchId')=? AND status IN ('generating','ready','failed') ORDER BY created_at,id").map_err(sql_error)?
            .query_map(params![owner,simulation,branch],|row| parse::<Value>(row.get(0)?)).map_err(sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)?;
        for draft in &drafts {
            crate::draft_contracts::draft_record(draft)?;
        }
        Ok(drafts)
    }
    /// Lifecycle state comes exclusively from append-only transitions, never the
    /// mutable compatibility columns on the original request row.
    pub fn memory_jobs(&self, owner: &str, simulation: &str) -> Result<Vec<Value>> {
        read_memory_jobs(&self.connection, owner, simulation)
    }
    pub fn start_memory_job(&mut self, owner: &str, simulation: &str, id: &str) -> Result<Value> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let job = read_memory_job(&transaction, owner, simulation, id)?;
        if job["status"] == "completed" {
            return Ok(job);
        }
        if job["status"] == "running" {
            return Err(EngineError {
                code: ErrorCode::MemoryJobConflict,
                message: format!("Memory job is already running: {id}"),
            });
        }
        let attempt = job["attemptCount"]
            .as_i64()
            .ok_or_else(|| invalid("Invalid memory job attempt."))?
            + 1;
        insert_job_transition(&transaction, &job, attempt, "running", None)?;
        let result = read_memory_job(&transaction, owner, simulation, id)?;
        transaction.commit().map_err(sql_error)?;
        Ok(result)
    }
    pub fn settle_memory_job(&mut self, job: &Value, result: Option<&Value>) -> Result<Value> {
        use crate::projection::{array, string};
        let owner = string(job, "ownerScope")?;
        let simulation = string(job, "simulationId")?;
        let id = string(job, "id")?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let current = read_memory_job(&transaction, owner, simulation, id)?;
        if result.is_some() && current["status"] == "completed" {
            return Ok(current);
        }
        if current["status"] != "running" {
            return Err(invalid(format!("Memory job is not running: {id}")));
        }
        if current["attemptCount"] != job["attemptCount"] {
            return Err(EngineError {
                code: ErrorCode::MemoryJobConflict,
                message: format!("Stale memory job attempt: {id}"),
            });
        }
        if let Some(result) = result {
            if result["episode"]["id"] != job["episodeId"]
                || result["episode"]["commitId"] != job["closureCommitId"]
                || result["episode"]["simulationId"] != simulation
            {
                return Err(invalid("Memory result does not match its pinned closure."));
            }
            for operation in array(result, "memoryOperations")? {
                if operation["simulationId"] != simulation
                    || operation["closureCommitId"] != job["closureCommitId"]
                    || operation["basisCommitId"] != job["basisHeadCommitId"]
                {
                    return Err(invalid("Detached operation does not match its memory job."));
                }
                transaction
                    .execute(
                        "INSERT INTO detached_memory_operations VALUES (?,?,?,?,?)",
                        params![
                            string(operation, "id")?,
                            owner,
                            simulation,
                            id,
                            json_text(operation)
                        ],
                    )
                    .map_err(sql_error)?;
            }
        }
        let attempt = current["attemptCount"]
            .as_i64()
            .ok_or_else(|| invalid("Invalid memory job attempt."))?;
        insert_job_transition(
            &transaction,
            &current,
            attempt,
            if result.is_some() {
                "completed"
            } else {
                "failed"
            },
            result,
        )?;
        let completed = read_memory_job(&transaction, owner, simulation, id)?;
        transaction.commit().map_err(sql_error)?;
        Ok(completed)
    }
    pub fn pending_whispers(
        &self,
        owner: &str,
        simulation: &str,
        branch: &str,
        head: &str,
        actor: &str,
    ) -> Result<Vec<Value>> {
        self.connection.prepare("SELECT id, command_id, text, created_at FROM draft_stage_whispers WHERE owner_scope = ? AND simulation_id = ? AND branch_id = ? AND expected_head = ? AND target_actor_id = ? ORDER BY created_at, id").map_err(sql_error)?
            .query_map(params![owner,simulation,branch,head,actor],|row| Ok(json!({"id":row.get::<_,String>(0)?,"ownerScope":owner,"simulationId":simulation,"branchId":branch,"expectedHead":head,"targetActorId":actor,"commandId":row.get::<_,String>(1)?,"text":row.get::<_,String>(2)?,"createdAt":row.get::<_,String>(3)?})))
            .map_err(sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)
    }
    pub fn create_whisper(&mut self, command: &Value, whisper: Value) -> Result<Value> {
        use crate::projection::string;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        if let Some(prior) = read_whisper_replay(&transaction, command)? {
            return Ok(prior);
        }
        let owner = string(command, "ownerScope")?;
        let simulation = string(command, "simulationId")?;
        let branch_id = string(command, "branchId")?;
        let head = string(command, "expectedHead")?;
        let branch = read_branch(&transaction, owner, simulation, branch_id)
            .map_err(sql_error)?
            .ok_or_else(|| EngineError {
                code: ErrorCode::NotFound,
                message: format!("Branch not found: {branch_id}"),
            })?;
        if branch.head_commit_id != head {
            return Err(branch_conflict(head, &branch.head_commit_id));
        }
        validate_whisper(command, &whisper)?;
        transaction
            .execute(
                "INSERT INTO draft_stage_whispers VALUES (?,?,?,?,?,?,?,?,?)",
                params![
                    string(&whisper, "id")?,
                    owner,
                    simulation,
                    branch_id,
                    head,
                    string(command, "commandId")?,
                    string(command, "targetActorId")?,
                    string(command, "text")?,
                    string(&whisper, "createdAt")?
                ],
            )
            .map_err(sql_error)?;
        let outcome = json!({"kind":"whisper","whisper":whisper});
        transaction
            .execute(
                "INSERT INTO command_results VALUES (?,?,?,?,?,?,?)",
                params![
                    owner,
                    simulation,
                    string(command, "commandId")?,
                    json_text(command),
                    fingerprint(command),
                    json_text(&outcome),
                    now()
                ],
            )
            .map_err(sql_error)?;
        transaction.commit().map_err(sql_error)?;
        Ok(whisper)
    }
    pub fn create_branch(
        &mut self,
        command: &Value,
        branch: Branch,
        commit: Option<Commit>,
    ) -> Result<BranchOutcome> {
        use crate::projection::string;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        if let Some(prior) = read_branch_replay(&transaction, command)? {
            return Ok(prior);
        }
        let owner = string(command, "ownerScope")?;
        let simulation = string(command, "simulationId")?;
        let source_id = string(command, "sourceBranchId")?;
        let head = string(command, "expectedHead")?;
        let source = read_branch(&transaction, owner, simulation, source_id)
            .map_err(sql_error)?
            .ok_or_else(|| EngineError {
                code: ErrorCode::NotFound,
                message: format!("Source branch not found: {source_id}"),
            })?;
        if source.head_commit_id != head {
            return Err(branch_conflict(head, &source.head_commit_id));
        }
        validate_new_branch(command, &branch, commit.as_ref(), &transaction)?;
        let base = match &branch.origin {
            BranchOrigin::Fork { base_commit_id, .. }
            | BranchOrigin::Edit { base_commit_id, .. }
            | BranchOrigin::Regenerate { base_commit_id, .. } => base_commit_id,
            _ => return Err(invalid("New sibling cannot be a root branch.")),
        };
        let mut next = Some(head.to_owned());
        let mut seen = std::collections::HashSet::new();
        let mut found = false;
        while let Some(id) = next {
            if !seen.insert(id.clone()) {
                return Err(invalid("Cyclic commit ancestry."));
            }
            let record = read_commit(&transaction, owner, simulation, &id)
                .map_err(sql_error)?
                .ok_or_else(|| invalid("Missing ancestor."))?;
            found |= &id == base;
            next = record.parent_commit_id;
        }
        if !found {
            return Err(invalid(format!(
                "Branch point {base} is not on source branch {source_id}."
            )));
        }
        if let Some(commit) = &commit {
            transaction
                .execute(
                    "INSERT INTO commits VALUES (?,?,?,?,?,?,?,?)",
                    params![
                        commit.id,
                        owner,
                        simulation,
                        commit.parent_commit_id,
                        commit.kind,
                        commit.command_id,
                        json_text(&commit.events),
                        commit.created_at
                    ],
                )
                .map_err(sql_error)?;
        }
        transaction
            .execute(
                "INSERT INTO branches VALUES (?,?,?,?,?,?,?)",
                params![
                    branch.id,
                    owner,
                    simulation,
                    branch.name,
                    branch.head_commit_id,
                    json_text(&branch.origin),
                    branch.created_at
                ],
            )
            .map_err(sql_error)?;
        let outcome = if let Some(commit) = &commit {
            json!({"kind":"commit","branch":branch,"commit":commit})
        } else {
            json!({"kind":"branch","branch":branch})
        };
        transaction
            .execute(
                "INSERT INTO command_results VALUES (?,?,?,?,?,?,?)",
                params![
                    owner,
                    simulation,
                    string(command, "commandId")?,
                    json_text(command),
                    fingerprint(command),
                    json_text(&outcome),
                    now()
                ],
            )
            .map_err(sql_error)?;
        transaction.commit().map_err(sql_error)?;
        Ok(BranchOutcome {
            branch,
            commit,
            replayed: false,
        })
    }
    pub fn append_commit(&mut self, command: &Value, commit: Commit) -> Result<Committed> {
        self.append_commit_with_job(command, commit, None)
    }
    fn append_commit_with_job(
        &mut self,
        command: &Value,
        commit: Commit,
        job: Option<&Value>,
    ) -> Result<Committed> {
        use crate::projection::string;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        if let Some(prior) = read_commit_replay(&transaction, command)? {
            return Ok(prior);
        }
        let owner = string(command, "ownerScope")?;
        let simulation = string(command, "simulationId")?;
        let branch_id = string(command, "branchId")?;
        let head = string(command, "expectedHead")?;
        let mut branch = read_branch(&transaction, owner, simulation, branch_id)
            .map_err(sql_error)?
            .ok_or_else(|| EngineError {
                code: ErrorCode::NotFound,
                message: format!("Branch not found: {branch_id}"),
            })?;
        if branch.head_commit_id != head {
            return Err(branch_conflict(head, &branch.head_commit_id));
        }
        if commit.owner_scope != owner
            || commit.simulation_id != simulation
            || commit.command_id != string(command, "commandId")?
            || commit.id != domain_id("commit", &[owner, simulation, &commit.command_id])
            || commit.parent_commit_id.as_deref() != Some(head)
        {
            return Err(invalid(
                "Commit identity and parent must match the command.",
            ));
        }
        transaction
            .execute(
                "INSERT INTO commits VALUES (?,?,?,?,?,?,?,?)",
                params![
                    commit.id,
                    commit.owner_scope,
                    commit.simulation_id,
                    commit.parent_commit_id,
                    commit.kind,
                    commit.command_id,
                    json_text(&commit.events),
                    commit.created_at
                ],
            )
            .map_err(sql_error)?;
        let changed = transaction.execute("UPDATE branches SET head_commit_id = ? WHERE owner_scope = ? AND simulation_id = ? AND id = ? AND head_commit_id = ?",params![commit.id,owner,simulation,branch_id,head]).map_err(sql_error)?;
        if changed != 1 {
            return Err(branch_conflict(head, "missing"));
        }
        if let Some(job) = job {
            if command["kind"] != "closure"
                || commit.kind != "episode_closure"
                || job["ownerScope"] != owner
                || job["simulationId"] != simulation
                || job["originBranchId"] != branch_id
                || job["commandId"] != commit.command_id
                || job["closureCommitId"] != commit.id
                || job["basisHeadCommitId"] != head
                || job["createdAt"] != commit.created_at
                || job["id"] != domain_id("memory_job", &[owner, simulation, &commit.command_id])
                || job["episodeId"] != domain_id("episode", &[&commit.command_id])
            {
                return Err(invalid("Closure job does not match its immutable request."));
            }
            transaction.execute("INSERT INTO memory_jobs (id,owner_scope,simulation_id,origin_branch_id,episode_id,closure_commit_id,basis_head_commit_id,command_id,label,status,attempt_count,result_fingerprint,result_json,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',0,NULL,NULL,NULL,?,?)",
                params![string(job,"id")?,owner,simulation,branch_id,string(job,"episodeId")?,commit.id,head,commit.command_id,job["label"].as_str(),commit.created_at,commit.created_at]).map_err(sql_error)?;
        } else if commit.kind == "episode_closure" {
            return Err(invalid("Closure commits require an atomic memory job."));
        }
        branch.head_commit_id = commit.id.clone();
        let outcome = json!({"kind":"commit","branch":branch,"commit":commit});
        transaction
            .execute(
                "INSERT INTO command_results VALUES (?,?,?,?,?,?,?)",
                params![
                    owner,
                    simulation,
                    commit.command_id,
                    json_text(command),
                    fingerprint(command),
                    json_text(&outcome),
                    now()
                ],
            )
            .map_err(sql_error)?;
        transaction.commit().map_err(sql_error)?;
        Ok(Committed {
            branch,
            commit,
            replayed: false,
        })
    }
    pub fn start_simulation(&mut self, mut input: StartSimulation) -> Result<StartedSimulation> {
        input.compiled = input.compiled.portable();
        input.compiled.require_valid()?;
        let mut command =
            serde_json::to_value(&input).map_err(|error| invalid(error.to_string()))?;
        command
            .as_object_mut()
            .unwrap()
            .insert("kind".into(), json!("start"));
        let command_fingerprint = fingerprint(&command);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        if let Some(mut result) = read_command(
            &transaction,
            &input.owner_scope,
            &input.simulation_id,
            &input.command_id,
            &command_fingerprint,
        )? {
            if result.get("kind").and_then(Value::as_str) != Some("start") {
                return Err(invalid("Stored command is not a start outcome."));
            }
            result
                .as_object_mut()
                .ok_or_else(|| invalid("Invalid recorded start outcome."))?
                .remove("kind");
            let started: StartedSimulation =
                serde_json::from_value(result).map_err(|error| invalid(error.to_string()))?;
            validate_start_receipt(&transaction, &input, &started)?;
            transaction.commit().map_err(sql_error)?;
            return Ok(started);
        }
        let digest = fingerprint(
            &serde_json::to_value(&input.compiled).map_err(|error| invalid(error.to_string()))?,
        );
        let revision = match transaction
            .query_row(
                "SELECT id FROM content_revisions WHERE owner_scope=? AND digest=?",
                params![input.owner_scope, digest],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(sql_error)?
        {
            Some(id) => read_revision(&transaction, &input.owner_scope, &id)
                .map_err(sql_error)?
                .ok_or_else(|| invalid("Content revision disappeared."))?,
            None => {
                let revision = ContentRevision {
                    id: format!("rev_{}", Uuid::new_v4()),
                    owner_scope: input.owner_scope.clone(),
                    digest,
                    compiled: input.compiled.clone(),
                    created_at: now(),
                };
                transaction
                    .execute(
                        "INSERT INTO content_revisions VALUES (?,?,?,?,?)",
                        params![
                            revision.id,
                            revision.owner_scope,
                            revision.digest,
                            json_text(&revision.compiled),
                            revision.created_at
                        ],
                    )
                    .map_err(sql_error)?;
                revision
            }
        };
        let created_at = now();
        let simulation = Simulation {
            id: input.simulation_id.clone(),
            owner_scope: input.owner_scope.clone(),
            content_revision_id: revision.id.clone(),
            source_root: input.source_root.clone(),
            scenario_id: input.scenario_id.clone(),
            default_branch_id: input.default_branch_id.clone(),
            created_at: created_at.clone(),
        };
        let root = Commit {
            id: input.root_commit_id.clone(),
            owner_scope: input.owner_scope.clone(),
            simulation_id: input.simulation_id.clone(),
            parent_commit_id: None,
            kind: "root".into(),
            command_id: input.command_id.clone(),
            events: vec![],
            created_at: created_at.clone(),
        };
        let branch = Branch {
            id: input.default_branch_id.clone(),
            owner_scope: input.owner_scope.clone(),
            simulation_id: input.simulation_id.clone(),
            name: Some("main".into()),
            head_commit_id: root.id.clone(),
            origin: BranchOrigin::Root {
                command_id: input.command_id.clone(),
                base_commit_id: root.id.clone(),
            },
            created_at: created_at.clone(),
        };
        transaction
            .execute(
                "INSERT INTO branch_simulations VALUES (?,?,?,?,?,?,?)",
                params![
                    simulation.owner_scope,
                    simulation.id,
                    simulation.content_revision_id,
                    simulation.source_root,
                    simulation.scenario_id,
                    simulation.default_branch_id,
                    simulation.created_at
                ],
            )
            .map_err(sql_error)?;
        transaction
            .execute(
                "INSERT INTO commits VALUES (?,?,?,?,?,?,?,?)",
                params![
                    root.id,
                    root.owner_scope,
                    root.simulation_id,
                    root.parent_commit_id,
                    root.kind,
                    root.command_id,
                    json_text(&root.events),
                    root.created_at
                ],
            )
            .map_err(sql_error)?;
        transaction
            .execute(
                "INSERT INTO branches VALUES (?,?,?,?,?,?,?)",
                params![
                    branch.id,
                    branch.owner_scope,
                    branch.simulation_id,
                    branch.name,
                    branch.head_commit_id,
                    json_text(&branch.origin),
                    branch.created_at
                ],
            )
            .map_err(sql_error)?;
        let started = StartedSimulation {
            simulation,
            branch,
            root,
            content_revision: revision,
        };
        let mut outcome =
            serde_json::to_value(&started).map_err(|error| invalid(error.to_string()))?;
        outcome
            .as_object_mut()
            .unwrap()
            .insert("kind".into(), json!("start"));
        transaction
            .execute(
                "INSERT INTO command_results VALUES (?,?,?,?,?,?,?)",
                params![
                    input.owner_scope,
                    input.simulation_id,
                    input.command_id,
                    json_text(&command),
                    command_fingerprint,
                    json_text(&outcome),
                    created_at
                ],
            )
            .map_err(sql_error)?;
        transaction.commit().map_err(sql_error)?;
        Ok(started)
    }
    pub fn recovery_identity(&self, owner: &str) -> Result<Value> {
        self.connection
            .execute(
                "INSERT OR IGNORE INTO application_installation VALUES (1,?)",
                [Uuid::new_v4().to_string()],
            )
            .map_err(sql_error)?;
        let installation: String = self
            .connection
            .query_row(
                "SELECT id FROM application_installation WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        Ok(json!({"installationId":installation,"ownerId":owner}))
    }
    pub fn memory_job_transitions(
        &self,
        owner: &str,
        simulation: &str,
        job: Option<&str>,
    ) -> Result<Vec<Value>> {
        self.connection.prepare("SELECT id,job_id,attempt,status,result_fingerprint,result_json,error,created_at FROM memory_job_transitions WHERE owner_scope=? AND simulation_id=? AND (? IS NULL OR job_id=?) ORDER BY job_id,attempt,CASE status WHEN 'running' THEN 0 ELSE 1 END,created_at,id").map_err(sql_error)?
            .query_map(params![owner,simulation,job,job],|row| {let result: Option<String> = row.get(5)?; Ok(json!({"id":row.get::<_,String>(0)?,"jobId":row.get::<_,String>(1)?,"ownerScope":owner,"simulationId":simulation,"attempt":row.get::<_,i64>(2)?,"status":row.get::<_,String>(3)?,"resultFingerprint":row.get::<_,Option<String>>(4)?,"result":result.map(parse::<Value>).transpose()?,"error":row.get::<_,Option<String>>(6)?,"createdAt":row.get::<_,String>(7)?}))})
            .map_err(sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)
    }
    pub fn list_simulations(&self, owner: &str) -> Result<Vec<Value>> {
        let mut query=self.connection.prepare("SELECT s.id,
          (SELECT json_extract(scenario.value, '$.name') FROM json_each(r.compiled_json, '$.scenarios') AS scenario
           WHERE json_extract(scenario.value, '$.id') = s.scenario_id LIMIT 1),
          s.created_at,n.opened_at,COALESCE(n.branch_id,s.default_branch_id)
          FROM branch_simulations s JOIN content_revisions r ON r.id=s.content_revision_id AND r.owner_scope=s.owner_scope
          LEFT JOIN application_simulation_navigation n ON n.owner_scope=s.owner_scope AND n.simulation_id=s.id
          WHERE s.owner_scope=? ORDER BY (n.opened_at IS NOT NULL) DESC,n.opened_at DESC,s.created_at DESC,s.id COLLATE BINARY ASC").map_err(sql_error)?;
        query.query_map([owner],|row|Ok(json!({"simulationId":row.get::<_,String>(0)?,"scenarioName":row.get::<_,Option<String>>(1)?,"createdAt":row.get::<_,String>(2)?,"openedAt":row.get::<_,Option<String>>(3)?,"branchId":row.get::<_,String>(4)?}))).map_err(sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)
    }
}
pub(crate) fn branch_conflict(expected: &str, actual: &str) -> EngineError {
    EngineError::branch_conflict(expected, actual)
}
fn read_commit_replay(connection: &Connection, command: &Value) -> Result<Option<Committed>> {
    use crate::projection::string;
    let owner = string(command, "ownerScope")?;
    let simulation = string(command, "simulationId")?;
    let id = string(command, "commandId")?;
    let Some(mut receipt) = read_command(connection, owner, simulation, id, &fingerprint(command))?
    else {
        return Ok(None);
    };
    if receipt["kind"] != "commit" {
        return Err(invalid("Expected a recorded commit outcome."));
    }
    receipt.as_object_mut().unwrap().remove("kind");
    receipt["replayed"] = json!(true);
    let outcome: Committed = serde_json::from_value(receipt).map_err(|e| invalid(e.to_string()))?;
    let branch_id = string(command, "branchId")?;
    let mut stored_branch = read_branch(connection, owner, simulation, branch_id)
        .map_err(sql_error)?
        .ok_or_else(|| invalid("Recorded branch is missing."))?;
    stored_branch.head_commit_id = outcome.branch.head_commit_id.clone();
    if outcome.branch != stored_branch
        || outcome.branch.head_commit_id != outcome.commit.id
        || outcome.commit.id != domain_id("commit", &[owner, simulation, id])
        || outcome.commit.command_id != id
        || outcome.commit.owner_scope != owner
        || outcome.commit.simulation_id != simulation
        || outcome.commit.parent_commit_id.as_deref() != Some(string(command, "expectedHead")?)
        || read_commit(connection, owner, simulation, &outcome.commit.id)
            .map_err(sql_error)?
            .as_ref()
            != Some(&outcome.commit)
    {
        return Err(invalid(
            "Recorded commit outcome does not match immutable history.",
        ));
    }
    Ok(Some(outcome))
}
fn validate_new_branch(
    command: &Value,
    branch: &Branch,
    commit: Option<&Commit>,
    connection: &Connection,
) -> Result<()> {
    use crate::projection::string;
    let owner = string(command, "ownerScope")?;
    let simulation = string(command, "simulationId")?;
    let id = string(command, "commandId")?;
    let kind = string(command, "kind")?;
    let base = match kind {
        "fork" => string(command, "atCommitId")?.to_owned(),
        "correct_turn_body" => string(command, "expectedHead")?.to_owned(),
        "edit" | "regenerate" => read_commit(
            connection,
            owner,
            simulation,
            string(command, "sourceCommitId")?,
        )
        .map_err(sql_error)?
        .and_then(|c| c.parent_commit_id)
        .ok_or_else(|| invalid("Historical source has no parent."))?,
        _ => return Err(invalid("Unsupported branch command.")),
    };
    let mut expected_origin = json!({"kind":if kind == "correct_turn_body" {"edit"} else {kind},"commandId":id,"sourceBranchId":string(command,"sourceBranchId")?,"sourceHeadCommitId":string(command,"expectedHead")?,"baseCommitId":base});
    let origin: BranchOrigin =
        serde_json::from_value(expected_origin.take()).map_err(|e| invalid(e.to_string()))?;
    if branch.id != string(command, "branchId")?
        || branch.owner_scope != owner
        || branch.simulation_id != simulation
        || branch.origin != origin
    {
        return Err(invalid(
            "Recorded branch identity does not match its command.",
        ));
    }
    if kind == "correct_turn_body"
        && branch.id != domain_id("correction_branch", &[owner, simulation, id])
    {
        return Err(invalid("Invalid correction branch identity."));
    }
    match (kind, commit) {
        ("fork", None) if branch.head_commit_id == base => (),
        ("edit" | "regenerate" | "correct_turn_body", Some(commit))
            if commit.id == domain_id("commit", &[owner, simulation, id])
                && commit.owner_scope == owner
                && commit.simulation_id == simulation
                && commit.command_id == id
                && commit.parent_commit_id.as_deref() == Some(&base)
                && branch.head_commit_id == commit.id =>
        {
            ()
        }
        _ => {
            return Err(invalid(
                "Branch commit identity does not match its command.",
            ));
        }
    }
    Ok(())
}
fn read_branch_replay(connection: &Connection, command: &Value) -> Result<Option<BranchOutcome>> {
    use crate::projection::string;
    let owner = string(command, "ownerScope")?;
    let simulation = string(command, "simulationId")?;
    let id = string(command, "commandId")?;
    let Some(mut receipt) = read_command(connection, owner, simulation, id, &fingerprint(command))?
    else {
        return Ok(None);
    };
    let expected = if command["kind"] == "fork" {
        "branch"
    } else {
        "commit"
    };
    if receipt["kind"] != expected {
        return Err(invalid("Unexpected branch outcome kind."));
    }
    receipt.as_object_mut().unwrap().remove("kind");
    receipt["replayed"] = json!(true);
    let outcome: BranchOutcome =
        serde_json::from_value(receipt).map_err(|e| invalid(e.to_string()))?;
    validate_new_branch(
        command,
        &outcome.branch,
        outcome.commit.as_ref(),
        connection,
    )?;
    let mut stored = read_branch(connection, owner, simulation, &outcome.branch.id)
        .map_err(sql_error)?
        .ok_or_else(|| invalid("Recorded branch is missing."))?;
    stored.head_commit_id = outcome.branch.head_commit_id.clone();
    if stored != outcome.branch {
        return Err(invalid("Recorded branch does not match immutable history."));
    }
    if let Some(commit) = &outcome.commit {
        if read_commit(connection, owner, simulation, &commit.id)
            .map_err(sql_error)?
            .as_ref()
            != Some(commit)
        {
            return Err(invalid(
                "Recorded sibling commit does not match immutable history.",
            ));
        }
    }
    Ok(Some(outcome))
}
fn validate_whisper(command: &Value, whisper: &Value) -> Result<()> {
    use crate::projection::string;
    if command["kind"] != "whisper"
        || whisper["id"]
            != domain_id(
                "whisper",
                &[
                    string(command, "ownerScope")?,
                    string(command, "simulationId")?,
                    string(command, "commandId")?,
                ],
            )
        || [
            "ownerScope",
            "simulationId",
            "branchId",
            "expectedHead",
            "commandId",
            "targetActorId",
            "text",
        ]
        .iter()
        .any(|key| whisper[key] != command[key])
    {
        return Err(invalid("Recorded whisper does not match its command."));
    }
    Ok(())
}
fn read_whisper_replay(connection: &Connection, command: &Value) -> Result<Option<Value>> {
    use crate::projection::string;
    let owner = string(command, "ownerScope")?;
    let simulation = string(command, "simulationId")?;
    let Some(receipt) = read_command(
        connection,
        owner,
        simulation,
        string(command, "commandId")?,
        &fingerprint(command),
    )?
    else {
        return Ok(None);
    };
    if receipt["kind"] != "whisper" {
        return Err(invalid("Expected a recorded whisper outcome."));
    }
    let whisper = receipt["whisper"].clone();
    validate_whisper(command, &whisper)?;
    let stored = connection.query_row("SELECT id,owner_scope,simulation_id,branch_id,expected_head,command_id,target_actor_id,text,created_at FROM draft_stage_whispers WHERE owner_scope=? AND simulation_id=? AND id=?",params![owner,simulation,string(&whisper,"id")?],|row| Ok(json!({"id":row.get::<_,String>(0)?,"ownerScope":row.get::<_,String>(1)?,"simulationId":row.get::<_,String>(2)?,"branchId":row.get::<_,String>(3)?,"expectedHead":row.get::<_,String>(4)?,"commandId":row.get::<_,String>(5)?,"targetActorId":row.get::<_,String>(6)?,"text":row.get::<_,String>(7)?,"createdAt":row.get::<_,String>(8)?}))).optional().map_err(sql_error)?;
    if stored.as_ref() != Some(&whisper) {
        return Err(invalid(
            "Recorded whisper does not match persisted direction.",
        ));
    }
    Ok(Some(whisper))
}
fn read_revision(
    connection: &Connection,
    owner: &str,
    id: &str,
) -> rusqlite::Result<Option<ContentRevision>> {
    connection.query_row("SELECT id,owner_scope,digest,compiled_json,created_at FROM content_revisions WHERE owner_scope=? AND id=?",params![owner,id],|row|Ok(ContentRevision {id:row.get(0)?,owner_scope:row.get(1)?,digest:row.get(2)?,compiled:parse(row.get(3)?)?,created_at:row.get(4)?})).optional()
}
fn read_simulation(
    connection: &Connection,
    owner: &str,
    id: &str,
) -> rusqlite::Result<Option<Simulation>> {
    connection.query_row("SELECT id,owner_scope,content_revision_id,source_root,scenario_id,default_branch_id,created_at FROM branch_simulations WHERE owner_scope=? AND id=?",params![owner,id],|row|Ok(Simulation {id:row.get(0)?,owner_scope:row.get(1)?,content_revision_id:row.get(2)?,source_root:row.get(3)?,scenario_id:row.get(4)?,default_branch_id:row.get(5)?,created_at:row.get(6)?})).optional()
}
fn read_branch(
    connection: &Connection,
    owner: &str,
    simulation: &str,
    id: &str,
) -> rusqlite::Result<Option<Branch>> {
    connection.query_row("SELECT id,owner_scope,simulation_id,name,head_commit_id,origin_json,created_at FROM branches WHERE owner_scope=? AND simulation_id=? AND id=?",params![owner,simulation,id],|row|Ok(Branch {id:row.get(0)?,owner_scope:row.get(1)?,simulation_id:row.get(2)?,name:row.get(3)?,head_commit_id:row.get(4)?,origin:parse(row.get(5)?)?,created_at:row.get(6)?})).optional()
}
fn read_commit(
    connection: &Connection,
    owner: &str,
    simulation: &str,
    id: &str,
) -> rusqlite::Result<Option<Commit>> {
    connection.query_row("SELECT id,owner_scope,simulation_id,parent_commit_id,kind,command_id,events_json,created_at FROM commits WHERE owner_scope=? AND simulation_id=? AND id=?",params![owner,simulation,id],|row|Ok(Commit {id:row.get(0)?,owner_scope:row.get(1)?,simulation_id:row.get(2)?,parent_commit_id:row.get(3)?,kind:row.get(4)?,command_id:row.get(5)?,events:parse(row.get(6)?)?,created_at:row.get(7)?})).optional()
}
fn read_command(
    connection: &Connection,
    owner: &str,
    simulation: &str,
    id: &str,
    expected: &str,
) -> Result<Option<Value>> {
    let reserved=connection.query_row("SELECT 1 FROM actor_turn_draft_commands WHERE owner_scope=? AND simulation_id=? AND command_id=?
      UNION ALL SELECT 1 FROM accepted_actor_turn_draft_identities WHERE owner_scope=? AND simulation_id=? AND generation_command_id=? LIMIT 1",
      params![owner,simulation,id,owner,simulation,id],|row|row.get::<_,i64>(0)).optional().map_err(sql_error)?.is_some();
    assert_no_historical_command(connection, owner, simulation, id)?;
    if reserved {
        return Err(EngineError::command_conflict(id));
    }
    let row=connection.query_row("SELECT canonical_input_json,fingerprint,result_json FROM command_results WHERE owner_scope=? AND simulation_id=? AND command_id=?",params![owner,simulation,id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))).optional().map_err(sql_error)?;
    let Some((input, saved, result)) = row else {
        return Ok(None);
    };
    let input: Value = serde_json::from_str(&input).map_err(|error| invalid(error.to_string()))?;
    if fingerprint(&input) != saved {
        return Err(invalid(
            "Stored command fingerprint does not match canonical input.",
        ));
    }
    if saved != expected {
        return Err(EngineError {
            code: ErrorCode::CommandConflict,
            message: format!("Command identity conflict: {id}"),
        });
    }
    Ok(Some(
        serde_json::from_str(&result).map_err(|error| invalid(error.to_string()))?,
    ))
}
fn validate_start_receipt(
    connection: &Connection,
    input: &StartSimulation,
    outcome: &StartedSimulation,
) -> Result<()> {
    let expected_root = domain_id(
        "commit",
        &[&input.owner_scope, &input.simulation_id, &input.command_id],
    );
    if outcome.simulation.id != input.simulation_id
        || outcome.simulation.owner_scope != input.owner_scope
        || outcome.branch.id != input.default_branch_id
        || outcome.branch.simulation_id != input.simulation_id
        || outcome.branch.owner_scope != input.owner_scope
        || outcome.root.id != input.root_commit_id
        || outcome.root.id != expected_root
        || outcome.root.owner_scope != input.owner_scope
        || outcome.root.simulation_id != input.simulation_id
        || outcome.root.command_id != input.command_id
        || outcome.root.kind != "root"
        || outcome.root.parent_commit_id.is_some()
        || !outcome.root.events.is_empty()
        || outcome.branch.origin
            != (BranchOrigin::Root {
                command_id: input.command_id.clone(),
                base_commit_id: outcome.root.id.clone(),
            })
        || outcome.branch.head_commit_id != outcome.root.id
    {
        return Err(invalid("Recorded start outcome has invalid identity."));
    }
    if read_simulation(connection, &input.owner_scope, &input.simulation_id)
        .map_err(sql_error)?
        .as_ref()
        != Some(&outcome.simulation)
        || read_commit(
            connection,
            &input.owner_scope,
            &input.simulation_id,
            &outcome.root.id,
        )
        .map_err(sql_error)?
        .as_ref()
            != Some(&outcome.root)
        || read_revision(connection, &input.owner_scope, &outcome.content_revision.id)
            .map_err(sql_error)?
            .as_ref()
            != Some(&outcome.content_revision)
        || outcome.simulation.content_revision_id != outcome.content_revision.id
    {
        return Err(invalid(
            "Recorded start outcome does not match immutable history.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::compile_workspace;
    fn input() -> StartSimulation {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/last-crossing");
        let compiled = compile_workspace(&source).unwrap();
        StartSimulation {
            owner_scope: "local".into(),
            simulation_id: "native-story".into(),
            source_root: compiled.source_root.clone(),
            compiled,
            scenario_id: Some("last-crossing".into()),
            default_branch_id: "main".into(),
            root_commit_id: domain_id("commit", &["local", "native-story", "start"]),
            command_id: "start".into(),
        }
    }
    #[test]
    fn native_start_is_atomic_idempotent_owner_scoped_and_reopens_existing_schema() {
        let directory = std::env::temp_dir().join(format!("doxvelt-rust-store-{}", Uuid::new_v4()));
        let database = directory.join("runtime.sqlite");
        {
            let mut store = Store::open(&database).unwrap();
            let input = input();
            let first = store.start_simulation(input.clone()).unwrap();
            assert_eq!(store.start_simulation(input.clone()).unwrap(), first);
            let mut changed = input.clone();
            changed.scenario_id = Some("different".into());
            assert_eq!(
                store.start_simulation(changed).unwrap_err().code,
                ErrorCode::CommandConflict
            );
            assert!(store.simulation("other", "native-story").unwrap().is_none());
            assert_eq!(
                store
                    .ancestry("local", "native-story", &first.root.id)
                    .unwrap(),
                vec![first.root.clone()]
            );
            assert!(first.content_revision.compiled.source_root.is_empty());
            let mut invalid = input;
            invalid.command_id = "new-command".into();
            assert!(store.start_simulation(invalid).is_err());
            let count: i64 = store
                .connection
                .query_row("SELECT count(*) FROM content_revisions", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 1);
        }
        {
            let mut reopened = Store::open(&database).unwrap();
            let recovered = reopened.start_simulation(input()).unwrap();
            assert_eq!(
                recovered.root.id,
                domain_id("commit", &["local", "native-story", "start"])
            );
            assert_eq!(
                reopened.recovery_identity("local").unwrap(),
                reopened.recovery_identity("local").unwrap()
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn native_turns_project_private_scopes_and_rejected_effects_leave_no_history() {
        use crate::{
            commands::commit_manual_turn,
            context::{ContextOptions, inspect_actor_context},
            projection::project_branch,
        };
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let start = store.start_simulation(input()).unwrap();
        let command = Command {
            owner_scope: "local".into(),
            simulation_id: "native-story".into(),
            branch_id: "main".into(),
            expected_head: start.root.id,
            command_id: "private".into(),
            payload: json!({"actorId":"corin","text":"#Mara(private truth) Shared words.","audience":["mara","nell"],"audienceSyntax":"scoped-v1","knowledgePolicy":"actor-knowledge-v1","stageWhisper":"private direction"}),
        };
        let accepted = commit_manual_turn(&mut store, command.clone()).unwrap();
        assert!(!accepted.replayed);
        assert!(
            commit_manual_turn(&mut store, command.clone())
                .unwrap()
                .replayed
        );
        let mara = inspect_actor_context(
            &store,
            "local",
            "native-story",
            "main",
            None,
            "mara",
            ContextOptions::default(),
        )
        .unwrap();
        let nell = inspect_actor_context(
            &store,
            "local",
            "native-story",
            "main",
            None,
            "nell",
            ContextOptions::default(),
        )
        .unwrap();
        assert_eq!(
            mara["subjective"]["transcript"][0]["text"],
            "private truth Shared words."
        );
        assert_eq!(nell["subjective"]["transcript"][0]["text"], "Shared words.");
        assert!(
            !nell["promptPreview"]
                .as_str()
                .unwrap()
                .contains("private truth")
        );
        let before = project_branch(&store, "local", "native-story", "main", None).unwrap();
        let mut invalid = command.clone();
        invalid.command_id = "bad".into();
        invalid.expected_head = accepted.commit.id.clone();
        invalid.payload["accessChanges"] =
            json!([{"action":"grant","member":"corin","container":"corin"}]);
        assert!(commit_manual_turn(&mut store, invalid).is_err());
        let mut stale = command.clone();
        stale.command_id = "stale".into();
        assert_eq!(
            commit_manual_turn(&mut store, stale).unwrap_err().code,
            ErrorCode::Conflict
        );
        let mut reused = command;
        reused.payload["text"] = json!("Different.");
        assert_eq!(
            commit_manual_turn(&mut store, reused).unwrap_err().code,
            ErrorCode::CommandConflict
        );
        let after = project_branch(&store, "local", "native-story", "main", None).unwrap();
        assert_eq!(
            serde_json::to_value(before).unwrap(),
            serde_json::to_value(after).unwrap()
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM command_results", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
}

fn read_memory_job(
    connection: &Connection,
    owner: &str,
    simulation: &str,
    id: &str,
) -> Result<Value> {
    read_memory_jobs(connection, owner, simulation)?
        .into_iter()
        .find(|job| job["id"] == id)
        .ok_or_else(|| EngineError {
            code: ErrorCode::NotFound,
            message: format!("Memory job not found: {id}"),
        })
}
fn insert_job_transition(
    connection: &Connection,
    job: &Value,
    attempt: i64,
    status: &str,
    result: Option<&Value>,
) -> Result<()> {
    use crate::projection::string;
    connection
        .execute(
            "INSERT INTO memory_job_transitions VALUES (?,?,?,?,?,?,?,?,?,?)",
            params![
                domain_id(
                    "memory_job_transition",
                    &[string(job, "id")?, &attempt.to_string(), status]
                ),
                string(job, "id")?,
                string(job, "ownerScope")?,
                string(job, "simulationId")?,
                attempt,
                status,
                result.map(fingerprint),
                result.map(json_text),
                if status == "failed" {
                    Some("Memory generation failed.")
                } else {
                    None
                },
                now()
            ],
        )
        .map_err(sql_error)?;
    Ok(())
}
fn read_memory_jobs(connection: &Connection, owner: &str, simulation: &str) -> Result<Vec<Value>> {
    let mut statement = connection.prepare("SELECT id, origin_branch_id, episode_id, closure_commit_id, basis_head_commit_id, command_id, label, created_at FROM memory_jobs WHERE owner_scope = ? AND simulation_id = ? ORDER BY created_at, id").map_err(sql_error)?;
    let requests = statement.query_map(params![owner, simulation], |row| Ok(json!({
            "id":row.get::<_,String>(0)?, "ownerScope":owner,"simulationId":simulation,
            "originBranchId":row.get::<_,String>(1)?,"episodeId":row.get::<_,String>(2)?,
            "closureCommitId":row.get::<_,String>(3)?,"basisHeadCommitId":row.get::<_,String>(4)?,
            "commandId":row.get::<_,String>(5)?,"label":row.get::<_,Option<String>>(6)?,
            "createdAt":row.get::<_,String>(7)?
        }))).map_err(sql_error)?.collect::<rusqlite::Result<Vec<Value>>>().map_err(sql_error)?;
    requests.into_iter().map(|mut job| {
            let latest = connection.query_row("SELECT status, attempt, result_fingerprint, result_json, error, created_at FROM memory_job_transitions WHERE owner_scope = ? AND simulation_id = ? AND job_id = ? ORDER BY attempt DESC, CASE status WHEN 'running' THEN 0 ELSE 1 END DESC, created_at DESC, id DESC LIMIT 1", params![owner, simulation, job["id"].as_str()], |row| {
                let result: Option<String> = row.get(3)?;
                Ok(json!({"status":row.get::<_,String>(0)?,"attemptCount":row.get::<_,i64>(1)?,
                    "resultFingerprint":row.get::<_,Option<String>>(2)?,"result":result.map(parse::<Value>).transpose()?,
                    "lastError":row.get::<_,Option<String>>(4)?,"updatedAt":row.get::<_,String>(5)?}))
            }).optional().map_err(sql_error)?;
            let state = latest.unwrap_or_else(|| json!({"status":"pending","attemptCount":0,"resultFingerprint":null,"result":null,"lastError":null,"updatedAt":job["createdAt"]}));
            job.as_object_mut().unwrap().extend(state.as_object().unwrap().clone());
            Ok(job)
        }).collect()
}

fn assert_no_historical_command(
    connection: &Connection,
    owner: &str,
    simulation: &str,
    id: &str,
) -> Result<()> {
    let historical=connection.prepare("SELECT id,json_extract(record_json,'$.request.commandId'),json_extract(record_json,'$.request.action') FROM saved_alternative_operations WHERE owner_scope=? AND simulation_id=?").map_err(sql_error)?
      .query_map(params![owner,simulation],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))).map_err(sql_error)?
      .collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)?;
    let accepted_historical=connection.query_row("SELECT 1 FROM command_results WHERE owner_scope=? AND simulation_id=? AND json_extract(canonical_input_json,'$.kind')='saved_alternative' AND json_extract(canonical_input_json,'$.payload.generated.generationCommandId')=? LIMIT 1",params![owner,simulation,id],|row|row.get::<_,i64>(0)).optional().map_err(sql_error)?.is_some();
    if accepted_historical
        || historical.iter().any(|(operation, command, action)| {
            command == id
                || (action == "generate" && domain_id("alternative_generation", &[operation]) == id)
        })
    {
        return Err(EngineError {
            code: ErrorCode::CommandConflict,
            message: format!("Command identity conflict: {id}"),
        });
    }
    Ok(())
}
