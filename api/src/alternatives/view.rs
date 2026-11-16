use crate::{
    error::{EngineError, Result},
    model::*,
    ports::{
        ActorDraftRepository, AlternativeReader, SavedAlternativeRepository, SimulationReader,
        SimulationRepository,
    },
    projection::string,
};
use serde_json::{Value, json};
pub struct HistoricalContext<'a, R: AlternativeReader> {
    pub repository: &'a R,
    pub operation: &'a Value,
}
impl<R: AlternativeReader> SimulationReader for HistoricalContext<'_, R> {
    fn actor_draft(&self, o: &str, s: &str, id: &str) -> Result<Option<Value>> {
        let r = &self.operation["request"];
        if r["ownerScope"] != o || r["simulationId"] != s {
            return Ok(None);
        }
        Ok(self
            .repository
            .alternative(o, s, string(self.operation, "id")?)?
            .and_then(|current| current.get("draft").filter(|d| d["id"] == id).cloned()))
    }
    fn pending_whispers(&self, _: &str, _: &str, _: &str, _: &str, _: &str) -> Result<Vec<Value>> {
        Ok(Vec::new())
    }
    fn revision(&self, o: &str, id: &str) -> Result<Option<ContentRevision>> {
        self.repository.revision(o, id)
    }
    fn simulation(&self, o: &str, id: &str) -> Result<Option<Simulation>> {
        self.repository.simulation(o, id)
    }
    fn branch(&self, o: &str, s: &str, id: &str) -> Result<Option<Branch>> {
        let r = &self.operation["request"];
        Ok(self.repository.branch(o, s, id)?.map(|mut b| {
            if r["ownerScope"] == o && r["simulationId"] == s && r["sourceBranchId"] == id {
                b.head_commit_id = self.operation["parentCommitId"].as_str().unwrap().into();
            }
            b
        }))
    }
    fn commit(&self, o: &str, s: &str, id: &str) -> Result<Option<Commit>> {
        self.repository.commit(o, s, id)
    }
    fn ancestry(&self, o: &str, s: &str, id: &str) -> Result<Vec<Commit>> {
        self.repository.ancestry(o, s, id)
    }
    fn memory_jobs(&self, o: &str, s: &str) -> Result<Vec<Value>> {
        self.repository.memory_jobs(o, s)
    }
    fn detached_memory_operations(&self, o: &str, s: &str) -> Result<Vec<Value>> {
        self.repository.detached_memory_operations(o, s)
    }
}
pub struct HistoricalDraftRepository<'a, R: SavedAlternativeRepository> {
    pub repository: &'a mut R,
    pub operation: Value,
}
impl<R: SavedAlternativeRepository> HistoricalDraftRepository<'_, R> {
    fn context(&self) -> HistoricalContext<'_, R> {
        HistoricalContext {
            repository: self.repository,
            operation: &self.operation,
        }
    }
    fn current(&self) -> Result<Value> {
        let r = &self.operation["request"];
        self.repository
            .alternative(
                string(r, "ownerScope")?,
                string(r, "simulationId")?,
                string(&self.operation, "id")?,
            )?
            .ok_or_else(|| EngineError::invalid("Historical operation is missing."))
    }
}
impl<R: SavedAlternativeRepository> SimulationReader for HistoricalDraftRepository<'_, R> {
    fn actor_draft(&self, o: &str, s: &str, id: &str) -> Result<Option<Value>> {
        self.context().actor_draft(o, s, id)
    }
    fn pending_whispers(&self, o: &str, s: &str, b: &str, h: &str, a: &str) -> Result<Vec<Value>> {
        self.context().pending_whispers(o, s, b, h, a)
    }
    fn revision(&self, o: &str, id: &str) -> Result<Option<ContentRevision>> {
        self.context().revision(o, id)
    }
    fn simulation(&self, o: &str, id: &str) -> Result<Option<Simulation>> {
        self.context().simulation(o, id)
    }
    fn branch(&self, o: &str, s: &str, id: &str) -> Result<Option<Branch>> {
        self.context().branch(o, s, id)
    }
    fn commit(&self, o: &str, s: &str, id: &str) -> Result<Option<Commit>> {
        self.context().commit(o, s, id)
    }
    fn ancestry(&self, o: &str, s: &str, id: &str) -> Result<Vec<Commit>> {
        self.context().ancestry(o, s, id)
    }
    fn memory_jobs(&self, o: &str, s: &str) -> Result<Vec<Value>> {
        self.context().memory_jobs(o, s)
    }
    fn detached_memory_operations(&self, o: &str, s: &str) -> Result<Vec<Value>> {
        self.context().detached_memory_operations(o, s)
    }
}
fn unsupported() -> EngineError {
    EngineError::invalid("Historical draft views cannot write accepted history.")
}
impl<R: SavedAlternativeRepository> SimulationRepository for HistoricalDraftRepository<'_, R> {
    fn replay_commit(&self, _: &Value) -> Result<Option<Committed>> {
        Err(unsupported())
    }
    fn replay_branch(&self, _: &Value) -> Result<Option<BranchOutcome>> {
        Err(unsupported())
    }
    fn replay_whisper(&self, _: &Value) -> Result<Option<Value>> {
        Err(unsupported())
    }
    fn append_commit(&mut self, _: &Value, _: Commit) -> Result<Committed> {
        Err(unsupported())
    }
    fn create_branch(&mut self, _: &Value, _: Branch, _: Option<Commit>) -> Result<BranchOutcome> {
        Err(unsupported())
    }
    fn create_whisper(&mut self, _: &Value, _: Value) -> Result<Value> {
        Err(unsupported())
    }
    fn start_simulation(&mut self, _: StartSimulation) -> Result<StartedSimulation> {
        Err(unsupported())
    }
    fn request_closure(&mut self, _: &Value, _: Commit, _: Value) -> Result<(Committed, Value)> {
        Err(unsupported())
    }
    fn start_memory_job(&mut self, _: &str, _: &str, _: &str) -> Result<Value> {
        Err(unsupported())
    }
    fn settle_memory_job(&mut self, _: &Value, _: Option<&Value>) -> Result<Value> {
        Err(unsupported())
    }
}
impl<R: SavedAlternativeRepository> ActorDraftRepository for HistoricalDraftRepository<'_, R> {
    fn replay_accepted_draft(&self, _: &AcceptRequest) -> Result<Option<Committed>> {
        Err(unsupported())
    }
    fn commit_accepted_draft(
        &mut self,
        _: &AcceptRequest,
        _: &Value,
        _: &str,
    ) -> Result<Committed> {
        Err(unsupported())
    }
    fn reserve_actor_draft(&mut self, draft: Value, _: &str) -> Result<(Value, bool)> {
        let current = self.current()?;
        if !current["draft"].is_null() {
            return Ok((current["draft"].clone(), true));
        }
        let saved = self
            .repository
            .update_alternative_draft(&self.operation, draft)?;
        if saved["draft"].is_null() {
            return Err(EngineError::invalid("Historical operation is terminal."));
        }
        Ok((saved["draft"].clone(), false))
    }
    fn transition_actor_draft(
        &mut self,
        _: &str,
        _: &str,
        _: &str,
        artifact: Option<&Value>,
        failure: Option<&Value>,
    ) -> Result<Value> {
        if artifact.is_some() == failure.is_some() {
            return Err(EngineError::invalid(
                "Historical completion requires an artifact or failure.",
            ));
        }
        let mut draft = self.current()?["draft"].clone();
        draft["status"] = json!(if artifact.is_some() {
            "ready"
        } else {
            "failed"
        });
        draft["artifact"] = artifact.cloned().unwrap_or(Value::Null);
        draft["failure"] = failure.cloned().unwrap_or(Value::Null);
        draft["updatedAt"] =
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        Ok(self
            .repository
            .update_alternative_draft(&self.operation, draft)?["draft"]
            .clone())
    }
    fn discard_actor_draft(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<(Value, bool)> {
        Err(unsupported())
    }
}
