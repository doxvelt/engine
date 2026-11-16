use crate::{error::Result, model::*};

/// Domain queries are independent of SQL, HTTP, DSH and deployment topology.
pub trait SimulationReader {
    fn actor_draft(
        &self,
        owner: &str,
        simulation: &str,
        id: &str,
    ) -> Result<Option<serde_json::Value>>;
    fn pending_whispers(
        &self,
        owner: &str,
        simulation: &str,
        branch: &str,
        head: &str,
        actor: &str,
    ) -> Result<Vec<serde_json::Value>>;
    fn revision(&self, owner: &str, id: &str) -> Result<Option<ContentRevision>>;
    fn simulation(&self, owner: &str, id: &str) -> Result<Option<Simulation>>;
    fn branch(&self, owner: &str, simulation: &str, id: &str) -> Result<Option<Branch>>;
    fn commit(&self, owner: &str, simulation: &str, id: &str) -> Result<Option<Commit>>;
    fn ancestry(&self, owner: &str, simulation: &str, head: &str) -> Result<Vec<Commit>>;
    fn memory_jobs(&self, owner: &str, simulation: &str) -> Result<Vec<serde_json::Value>>;
    fn detached_memory_operations(
        &self,
        owner: &str,
        simulation: &str,
    ) -> Result<Vec<serde_json::Value>>;
}
pub trait SimulationRepository: SimulationReader {
    fn start_memory_job(
        &mut self,
        owner: &str,
        simulation: &str,
        job: &str,
    ) -> Result<serde_json::Value>;
    fn settle_memory_job(
        &mut self,
        job: &serde_json::Value,
        result: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value>;
    fn request_closure(
        &mut self,
        command: &serde_json::Value,
        commit: Commit,
        job: serde_json::Value,
    ) -> Result<(Committed, serde_json::Value)>;
    fn replay_whisper(&self, command: &serde_json::Value) -> Result<Option<serde_json::Value>>;
    fn create_whisper(
        &mut self,
        command: &serde_json::Value,
        whisper: serde_json::Value,
    ) -> Result<serde_json::Value>;
    fn replay_branch(&self, command: &serde_json::Value) -> Result<Option<BranchOutcome>>;
    fn create_branch(
        &mut self,
        command: &serde_json::Value,
        branch: Branch,
        commit: Option<Commit>,
    ) -> Result<BranchOutcome>;
    fn start_simulation(&mut self, input: StartSimulation) -> Result<StartedSimulation>;
    fn replay_commit(&self, command: &serde_json::Value) -> Result<Option<Committed>>;
    fn append_commit(&mut self, command: &serde_json::Value, commit: Commit) -> Result<Committed>;
}

pub trait ActorDraftRepository: SimulationRepository {
    fn replay_accepted_draft(&self, request: &AcceptRequest) -> Result<Option<Committed>>;
    fn commit_accepted_draft(
        &mut self,
        request: &AcceptRequest,
        command: &serde_json::Value,
        created_at: &str,
    ) -> Result<Committed>;
    fn reserve_actor_draft(
        &mut self,
        draft: serde_json::Value,
        command_fingerprint: &str,
    ) -> Result<(serde_json::Value, bool)>;
    fn transition_actor_draft(
        &mut self,
        owner: &str,
        simulation: &str,
        id: &str,
        artifact: Option<&serde_json::Value>,
        failure: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value>;
    fn discard_actor_draft(
        &mut self,
        owner: &str,
        simulation: &str,
        id: &str,
        command: &str,
    ) -> Result<(serde_json::Value, bool)>;
}

pub trait AlternativeReader: SimulationReader {
    fn export_archive(
        &self,
        owner: &str,
        simulation: &str,
    ) -> Result<crate::archive::SimulationArchive>;
    fn alternative(
        &self,
        owner: &str,
        simulation: &str,
        id: &str,
    ) -> Result<Option<serde_json::Value>>;
}
pub trait SavedAlternativeRepository: ActorDraftRepository + AlternativeReader {
    fn reserve_alternative(
        &mut self,
        record: serde_json::Value,
    ) -> Result<(serde_json::Value, bool)>;
    fn update_alternative_draft(
        &mut self,
        record: &serde_json::Value,
        draft: serde_json::Value,
    ) -> Result<serde_json::Value>;
    fn settle_alternative(
        &mut self,
        owner: &str,
        simulation: &str,
        id: &str,
        status: &str,
        failure: Option<&str>,
    ) -> Result<serde_json::Value>;
    fn save_alternative(
        &mut self,
        owner: &str,
        simulation: &str,
        id: &str,
    ) -> Result<serde_json::Value>;
}
