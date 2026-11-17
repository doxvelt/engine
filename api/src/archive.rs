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
use std::sync::Arc;

pub mod codec;
mod conversion;
pub mod historical;
pub mod memory;
pub mod recorded;
pub mod verify;

/// Validate before import or replay. Version 4 conversion is explicit because
/// it changes closure checkpoints and their cached command outcomes together.
pub fn validate(archive: &SimulationArchive) -> Result<()> {
    validate_cancellable(archive, &|| false)
}
pub fn check_cancelled(cancel: &dyn Fn() -> bool) -> Result<()> {
    if cancel() {
        Err(EngineError::invalid("Archive operation was cancelled."))
    } else {
        Ok(())
    }
}
pub fn validate_cancellable(archive: &SimulationArchive, cancel: &dyn Fn() -> bool) -> Result<()> {
    check_cancelled(cancel)?;
    if archive.schema_version == 4 {
        return normalize_cancellable(archive.clone(), cancel).map(|_| ());
    }
    let reader = ArchiveReader::cancellable(archive, cancel);
    verify::verify_structure_with_reader(&reader)?;
    reader.check_cancelled()?;
    memory::verify_jobs_with_reader(&reader)?;
    reader.check_cancelled()?;
    verify::verify_commands_with_reader(&reader)
}

pub fn normalize(archive: SimulationArchive) -> Result<SimulationArchive> {
    normalize_cancellable(archive, &|| false)
}
pub fn normalize_cancellable(
    archive: SimulationArchive,
    cancel: &dyn Fn() -> bool,
) -> Result<SimulationArchive> {
    check_cancelled(cancel)?;
    let archive = if archive.schema_version == 4 {
        conversion::upconvert(archive, cancel)?
    } else {
        archive
    };
    validate_cancellable(&archive, cancel)?;
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
#[derive(Clone)]
pub struct ArchiveReader<'a> {
    pub archive: &'a SimulationArchive,
    pub heads: HashMap<String, String>,
    commits: Arc<HashMap<&'a str, &'a Commit>>,
    branches: Arc<HashMap<&'a str, &'a Branch>>,
    cancel: Option<&'a dyn Fn() -> bool>,
    paths: Arc<Result<ArchivePaths<'a>>>,
}
struct ArchivePaths<'a> {
    ordered: Vec<&'a Commit>,
    intervals: HashMap<&'a str, (usize, usize)>,
}
fn index_paths<'a>(
    archive: &'a SimulationArchive,
    commits: &HashMap<&'a str, &'a Commit>,
    cancel: &dyn Fn() -> bool,
) -> Result<ArchivePaths<'a>> {
    check_cancelled(cancel)?;
    let mut children: HashMap<Option<&str>, Vec<&Commit>> = HashMap::new();
    for commit in &archive.commits {
        check_cancelled(cancel)?;
        if let Some(parent) = commit.parent_commit_id.as_deref()
            && !commits.contains_key(parent)
        {
            return Err(EngineError::invalid(format!(
                "Archive commit is missing: {parent}"
            )));
        }
        children
            .entry(commit.parent_commit_id.as_deref())
            .or_default()
            .push(commit);
    }
    let mut stack = children
        .get(&None)
        .into_iter()
        .flatten()
        .rev()
        .map(|c| (*c, false))
        .collect::<Vec<_>>();
    let mut paths = ArchivePaths {
        ordered: Vec::with_capacity(commits.len()),
        intervals: HashMap::new(),
    };
    while let Some((commit, exit)) = stack.pop() {
        check_cancelled(cancel)?;
        if exit {
            paths.intervals.get_mut(commit.id.as_str()).unwrap().1 = paths.ordered.len();
            continue;
        }
        if paths
            .intervals
            .insert(&commit.id, (paths.ordered.len(), 0))
            .is_some()
        {
            return Err(EngineError::invalid("Cyclic commit ancestry."));
        }
        paths.ordered.push(commit);
        stack.push((commit, true));
        if let Some(children) = children.get(&Some(commit.id.as_str())) {
            stack.extend(children.iter().rev().map(|c| (*c, false)));
        }
    }
    if paths.ordered.len() != archive.commits.len() {
        return Err(EngineError::invalid("Cyclic commit ancestry."));
    }
    Ok(paths)
}
impl<'a> ArchiveReader<'a> {
    pub fn new(archive: &'a SimulationArchive) -> Self {
        Self::indexed(archive, None)
    }
    fn indexed(archive: &'a SimulationArchive, cancel: Option<&'a dyn Fn() -> bool>) -> Self {
        let cancelled = || cancel.is_some_and(|f| f());
        let mut commits = HashMap::new();
        let mut branches = HashMap::new();
        // Keep first-match semantics until structural validation rejects duplicates.
        for commit in &archive.commits {
            if cancelled() {
                break;
            }
            commits.entry(commit.id.as_str()).or_insert(commit);
        }
        for branch in &archive.branches {
            if cancelled() {
                break;
            }
            branches.entry(branch.id.as_str()).or_insert(branch);
        }
        let paths = Arc::new(index_paths(archive, &commits, &cancelled));
        Self {
            archive,
            heads: HashMap::new(),
            commits: Arc::new(commits),
            branches: Arc::new(branches),
            cancel,
            paths,
        }
    }
    pub fn cancellable(archive: &'a SimulationArchive, cancel: &'a dyn Fn() -> bool) -> Self {
        Self::indexed(archive, Some(cancel))
    }
    pub fn check_cancelled(&self) -> Result<()> {
        match self.cancel {
            Some(cancel) => check_cancelled(cancel),
            None => Ok(()),
        }
    }
    pub(crate) fn ordered_commits(&self) -> Result<&[&'a Commit]> {
        self.check_cancelled()?;
        self.paths
            .as_ref()
            .as_ref()
            .map(|p| p.ordered.as_slice())
            .map_err(Clone::clone)
    }
    pub fn is_ancestor(&self, base: &str, head: &str) -> Result<bool> {
        self.check_cancelled()?;
        let paths = self.paths.as_ref().as_ref().map_err(Clone::clone)?;
        let head = paths
            .intervals
            .get(head)
            .ok_or_else(|| EngineError::invalid(format!("Archive commit is missing: {head}")))?;
        Ok(paths
            .intervals
            .get(base)
            .is_some_and(|base| base.0 <= head.0 && head.0 < base.1))
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
        self.check_cancelled()?;
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
        self.check_cancelled()?;
        Ok(self
            .scoped(owner, simulation)
            .then(|| self.branches.get(id).map(|b| (*b).clone()))
            .flatten()
            .map(|mut b| {
                if let Some(head) = self.heads.get(id) {
                    b.head_commit_id = head.clone();
                }
                b
            }))
    }
    fn commit(&self, owner: &str, simulation: &str, id: &str) -> Result<Option<Commit>> {
        self.check_cancelled()?;
        Ok(self
            .scoped(owner, simulation)
            .then(|| self.commits.get(id).map(|c| (*c).clone()))
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
