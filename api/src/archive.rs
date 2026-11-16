//! Portable accepted history. Operational drafts, navigation, credentials and
//! filesystem handles are deliberately absent from this contract.
use crate::{
    error::{EngineError, Result},
    model::*,
    ports::SimulationReader,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub mod codec;
mod conversion;
pub mod historical;
pub mod memory;
pub mod recorded;
pub mod verify;

/// Validate before import or replay. Version 4 conversion is explicit because
/// it changes closure checkpoints and their cached command outcomes together.
pub fn validate(archive: &SimulationArchive) -> Result<()> {
    if archive.schema_version == 4 {
        return normalize(archive.clone()).map(|_| ());
    }
    verify::verify_structure(archive)?;
    memory::verify_jobs(archive)?;
    verify::verify_commands(archive)
}

pub fn normalize(archive: SimulationArchive) -> Result<SimulationArchive> {
    let archive = if archive.schema_version == 4 {
        conversion::upconvert(archive)?
    } else {
        archive
    };
    validate(&archive)?;
    Ok(archive)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordedCommandResult {
    pub command_id: String,
    pub canonical_input: Value,
    pub fingerprint: String,
    pub result: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SimulationArchive {
    pub schema_version: u8,
    pub content_revision: ContentRevision,
    pub simulation: Simulation,
    pub branches: Vec<Branch>,
    pub commits: Vec<Commit>,
    pub stage_whispers: Vec<Value>,
    pub command_results: Vec<RecordedCommandResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_jobs: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detached_memory_operations: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_job_transitions: Option<Vec<Value>>,
}

/// A read-only view over immutable archive records. The temporary heads are
/// command preconditions, used to verify historical commands without changing
/// either their source branch or the archive's final heads.
pub struct ArchiveReader<'a> {
    pub archive: &'a SimulationArchive,
    pub heads: HashMap<String, String>,
}
impl<'a> ArchiveReader<'a> {
    pub fn new(archive: &'a SimulationArchive) -> Self {
        Self {
            archive,
            heads: HashMap::new(),
        }
    }
    fn scoped(&self, owner: &str, simulation: &str) -> bool {
        self.archive.simulation.owner_scope == owner && self.archive.simulation.id == simulation
    }
}
impl SimulationReader for ArchiveReader<'_> {
    fn actor_draft(&self, _: &str, _: &str, _: &str) -> Result<Option<Value>> {
        Ok(None)
    }
    fn revision(&self, owner: &str, id: &str) -> Result<Option<ContentRevision>> {
        Ok((owner == self.archive.content_revision.owner_scope
            && id == self.archive.content_revision.id)
            .then(|| self.archive.content_revision.clone()))
    }
    fn simulation(&self, owner: &str, id: &str) -> Result<Option<Simulation>> {
        Ok(self
            .scoped(owner, id)
            .then(|| self.archive.simulation.clone()))
    }
    fn branch(&self, owner: &str, simulation: &str, id: &str) -> Result<Option<Branch>> {
        Ok(self
            .scoped(owner, simulation)
            .then(|| self.archive.branches.iter().find(|b| b.id == id).cloned())
            .flatten()
            .map(|mut b| {
                if let Some(head) = self.heads.get(id) {
                    b.head_commit_id = head.clone();
                }
                b
            }))
    }
    fn commit(&self, owner: &str, simulation: &str, id: &str) -> Result<Option<Commit>> {
        Ok(self
            .scoped(owner, simulation)
            .then(|| self.archive.commits.iter().find(|c| c.id == id).cloned())
            .flatten())
    }
    fn ancestry(&self, owner: &str, simulation: &str, head: &str) -> Result<Vec<Commit>> {
        let mut result = Vec::new();
        let mut seen = HashSet::new();
        let mut next = Some(head.to_owned());
        while let Some(id) = next {
            if !seen.insert(id.clone()) {
                return Err(EngineError::invalid("Cyclic commit ancestry."));
            }
            let commit = self
                .commit(owner, simulation, &id)?
                .ok_or_else(|| EngineError::invalid(format!("Archive commit is missing: {id}")))?;
            next = commit.parent_commit_id.clone();
            result.push(commit);
        }
        result.reverse();
        Ok(result)
    }
    fn memory_jobs(&self, owner: &str, simulation: &str) -> Result<Vec<Value>> {
        Ok(if self.scoped(owner, simulation) {
            self.archive.memory_jobs.clone().unwrap_or_default()
        } else {
            Vec::new()
        })
    }
    fn detached_memory_operations(&self, owner: &str, simulation: &str) -> Result<Vec<Value>> {
        Ok(if self.scoped(owner, simulation) {
            self.archive
                .detached_memory_operations
                .clone()
                .unwrap_or_default()
        } else {
            Vec::new()
        })
    }
    fn pending_whispers(
        &self,
        owner: &str,
        simulation: &str,
        branch: &str,
        head: &str,
        actor: &str,
    ) -> Result<Vec<Value>> {
        if !self.scoped(owner, simulation) {
            return Ok(Vec::new());
        }
        let mut whispers: Vec<_> = self
            .archive
            .stage_whispers
            .iter()
            .filter(|w| {
                w["ownerScope"] == owner
                    && w["simulationId"] == simulation
                    && w["branchId"] == branch
                    && w["targetActorId"] == actor
                    && w["expectedHead"] == head
            })
            .cloned()
            .collect();
        whispers.sort_by(|a, b| {
            a["createdAt"]
                .as_str()
                .cmp(&b["createdAt"].as_str())
                .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
        });
        Ok(whispers)
    }
}
