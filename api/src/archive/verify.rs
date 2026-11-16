//! Archive checks are pure. Canonical commands are rebuilt through the same
//! application services as normal play, using a repository that compares writes
//! with the recorded outcome instead of persisting anything.
use super::{ArchiveReader, SimulationArchive, codec, recorded};
use crate::{
    acceptance, commands,
    error::{EngineError, Result},
    history,
    identity::fingerprint,
    model::*,
    ports::{SimulationReader, SimulationRepository},
    projection::string,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

fn invalid(message: &str) -> EngineError {
    EngineError::invalid(format!("Simulation archive {message}"))
}
fn value(record: &impl serde::Serialize) -> Value {
    serde_json::to_value(record).expect("archive record")
}
fn same(a: &Value, b: &Value) -> bool {
    fingerprint(a) == fingerprint(b)
}

pub fn decode_archive(value: &Value) -> Result<SimulationArchive> {
    codec::simulation(&value["simulation"])?;
    codec::revision(&value["contentRevision"])?;
    for b in crate::projection::array(value, "branches")? {
        codec::branch(b)?;
    }
    for c in crate::projection::array(value, "commits")? {
        codec::commit(c)?;
    }
    codec::decode(value)
}

pub fn verify_structure(archive: &SimulationArchive) -> Result<()> {
    if ![4, 5, 6, 7].contains(&archive.schema_version) {
        return Err(invalid("schema is unsupported."));
    }
    let sim = &archive.simulation;
    let revision = &archive.content_revision;
    codec::revision(&value(revision))?;
    if revision.owner_scope != sim.owner_scope || revision.id != sim.content_revision_id {
        return Err(invalid("content scope or revision mismatch."));
    }
    let mut portable = value(&revision.compiled);
    portable["sourceRoot"] = json!("");
    if fingerprint(&portable) != revision.digest {
        return Err(invalid("content digest is invalid."));
    }
    let reader = ArchiveReader::new(archive);
    let mut commits = HashSet::new();
    let mut operations = HashSet::new();
    for commit in &archive.commits {
        codec::commit(&value(commit))?;
        if !commits.insert(&commit.id)
            || commit.owner_scope != sim.owner_scope
            || commit.simulation_id != sim.id
        {
            return Err(invalid("contains duplicate or mis-scoped commits."));
        }
        for event in &commit.events {
            let ops = if event["type"] == "memory_operation" {
                vec![&event["operation"]]
            } else if event["type"] == "episode_closed" {
                event["closure"]["memoryOperations"]
                    .as_array()
                    .map(|a| a.iter().collect())
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            for op in ops {
                if !operations.insert(string(op, "id")?) {
                    return Err(invalid("contains duplicate memory operation IDs."));
                }
            }
            if archive.schema_version < 6 && event["message"]["provenance"]["mode"] == "generated" {
                return Err(invalid("legacy schema cannot contain generated messages."));
            }
        }
    }
    // Ancestry checks include missing parents and cycles on every path, including
    // commits that are not reachable from the selected/default branch.
    for commit in &archive.commits {
        reader.ancestry(&sim.owner_scope, &sim.id, &commit.id)?;
    }
    let mut branches = HashSet::new();
    for branch in &archive.branches {
        if !branches.insert(&branch.id)
            || branch.owner_scope != sim.owner_scope
            || branch.simulation_id != sim.id
            || !commits.contains(&branch.head_commit_id)
        {
            return Err(invalid("contains an invalid or duplicate branch."));
        }
        let mut visited = HashSet::new();
        let mut current = branch;
        loop {
            if !visited.insert(&current.id) {
                return Err(invalid("contains a branch-origin cycle."));
            }
            if let BranchOrigin::Root { .. } = current.origin {
                break;
            }
            let origin = value(&current.origin);
            let source = archive
                .branches
                .iter()
                .find(|b| b.id == origin["sourceBranchId"])
                .ok_or_else(|| invalid("branch source is missing."))?;
            if !ancestor(
                &reader,
                string(&origin, "baseCommitId")?,
                string(&origin, "sourceHeadCommitId")?,
            )? || !ancestor(
                &reader,
                string(&origin, "sourceHeadCommitId")?,
                &source.head_commit_id,
            )? || !ancestor(
                &reader,
                string(&origin, "baseCommitId")?,
                &current.head_commit_id,
            )? {
                return Err(invalid("branch origin is not on its source path."));
            }
            current = source;
        }
    }
    let mut command_ids = HashSet::new();
    let mut draft_ids = HashSet::new();
    let mut generation_ids = HashSet::new();
    for command in &archive.command_results {
        recorded::command_result(command)?;
        let c = &command.canonical_input;
        if !command_ids.insert(command.command_id.as_str())
            || c["ownerScope"] != sim.owner_scope
            || c["simulationId"] != sim.id
        {
            return Err(invalid(
                "contains duplicate or mis-scoped command identities.",
            ));
        }
        if c["kind"] == "accept_draft" {
            if archive.schema_version < 6
                || !draft_ids.insert(string(&c["payload"], "draftId")?)
                || !generation_ids.insert(string(&c["payload"], "generationCommandId")?)
            {
                return Err(invalid("contains duplicate accepted draft identities."));
            }
        }
        if archive.schema_version != 7
            && matches!(
                c["kind"].as_str(),
                Some("saved_alternative" | "correct_turn_body")
            )
        {
            return Err(invalid("historical commands require schema 7."));
        }
    }
    if generation_ids.iter().any(|id| command_ids.contains(id)) {
        return Err(invalid(
            "accepted generation identity is reused canonically.",
        ));
    }
    let mut whispers = HashSet::new();
    for w in &archive.stage_whispers {
        codec::whisper(w)?;
        let b = archive
            .branches
            .iter()
            .find(|b| b.id == w["branchId"])
            .ok_or_else(|| invalid("whisper branch is missing."))?;
        if !whispers.insert(string(w, "id")?)
            || w["ownerScope"] != sim.owner_scope
            || w["simulationId"] != sim.id
            || !command_ids.contains(string(w, "commandId")?)
            || !ancestor(&reader, string(w, "expectedHead")?, &b.head_commit_id)?
        {
            return Err(invalid("stage whisper scope or basis is invalid."));
        }
    }
    verify_provenance(archive, &reader)?;
    // Replaying every head checks membership cycles and other access invariants
    // along each path without deriving visibility from a different branch.
    crate::access::assert_valid_graph(&revision.compiled.access_links)?;
    for commit in &archive.commits {
        let mut links = revision.compiled.access_links.clone();
        for c in reader.ancestry(&sim.owner_scope, &sim.id, &commit.id)? {
            for event in c.events.iter().filter(|e| e["type"] == "access_changed") {
                let change = crate::access::AccessChange {
                    action: codec::decode(&event["action"])?,
                    member: string(event, "member")?.into(),
                    container: string(event, "container")?.into(),
                    reason: event["reason"].as_str().map(str::to_owned),
                };
                links = crate::access::apply_validated_change(&links, &change)?;
            }
        }
    }
    for branch in &archive.branches {
        crate::projection::project_branch(&reader, &sim.owner_scope, &sim.id, &branch.id, None)?;
    }
    Ok(())
}
pub fn ancestor(reader: &ArchiveReader<'_>, base: &str, head: &str) -> Result<bool> {
    let sim = &reader.archive.simulation;
    Ok(reader
        .ancestry(&sim.owner_scope, &sim.id, head)?
        .iter()
        .any(|c| c.id == base))
}
fn verify_provenance(archive: &SimulationArchive, reader: &ArchiveReader<'_>) -> Result<()> {
    let commands: HashMap<_, _> = archive
        .command_results
        .iter()
        .map(|c| (c.command_id.as_str(), c))
        .collect();
    let roots: Vec<_> = archive
        .commits
        .iter()
        .filter(|c| c.kind == "root")
        .collect();
    let root_branches: Vec<_> = archive
        .branches
        .iter()
        .filter(|b| matches!(b.origin, BranchOrigin::Root { .. }))
        .collect();
    if roots.len() != 1
        || root_branches.len() != 1
        || root_branches[0].id != archive.simulation.default_branch_id
    {
        return Err(invalid("must contain exactly one root."));
    }
    let root = roots[0];
    if root.parent_commit_id.is_some()
        || !root.events.is_empty()
        || value(&root_branches[0].origin)
            != json!({"kind":"root","commandId":root.command_id,"baseCommitId":root.id})
    {
        return Err(invalid("root branch origin is invalid."));
    }
    for commit in &archive.commits {
        let command = commands
            .get(commit.command_id.as_str())
            .ok_or_else(|| invalid("commit lacks command provenance."))?;
        let field = if commit.kind == "root" {
            "root"
        } else {
            "commit"
        };
        if !same(&command.result[field], &value(commit)) {
            return Err(invalid("commit differs from its recorded outcome."));
        }
        let mut owned = false;
        for branch in &archive.branches {
            owned |= ancestor(reader, &commit.id, &branch.head_commit_id)?;
        }
        if !owned {
            return Err(invalid("commit is not owned by any branch."));
        }
    }
    for branch in &archive.branches {
        let origin = value(&branch.origin);
        let command = commands
            .get(string(&origin, "commandId")?)
            .ok_or_else(|| invalid("branch lacks command provenance."))?;
        if command.result["branch"]["id"] != branch.id {
            return Err(invalid(
                "branch creation outcome does not match its identity.",
            ));
        }
        let c = &command.canonical_input;
        let valid = match &branch.origin {
            BranchOrigin::Root { base_commit_id, .. } => {
                c["kind"] == "start"
                    && c["defaultBranchId"] == branch.id
                    && c["rootCommitId"] == *base_commit_id
            }
            BranchOrigin::Fork {
                source_branch_id,
                source_head_commit_id,
                base_commit_id,
                ..
            } => {
                c["kind"] == "fork"
                    && c["branchId"] == branch.id
                    && c["sourceBranchId"] == *source_branch_id
                    && c["expectedHead"] == *source_head_commit_id
                    && c["atCommitId"] == *base_commit_id
            }
            BranchOrigin::Edit {
                source_branch_id,
                source_head_commit_id,
                base_commit_id,
                ..
            }
            | BranchOrigin::Regenerate {
                source_branch_id,
                source_head_commit_id,
                base_commit_id,
                ..
            } => {
                let expected_kind = if matches!(branch.origin, BranchOrigin::Edit { .. }) {
                    "edit"
                } else {
                    "regenerate"
                };
                (c["kind"] == expected_kind
                    || c["kind"] == "correct_turn_body" && expected_kind == "edit"
                    || c["kind"] == "saved_alternative"
                        && c["payload"]["request"]["action"]
                            == if expected_kind == "edit" {
                                "manual"
                            } else {
                                "generate"
                            })
                    && c["branchId"] == branch.id
                    && c["sourceBranchId"] == *source_branch_id
                    && c["expectedHead"] == *source_head_commit_id
                    && command.result["commit"]["parentCommitId"] == *base_commit_id
            }
        };
        if !valid {
            return Err(invalid("branch origin does not match its command."));
        }
    }
    for command in &archive.command_results {
        let result = &command.result;
        if result["kind"] == "whisper" {
            if !archive
                .stage_whispers
                .iter()
                .any(|w| same(w, &result["whisper"]))
            {
                return Err(invalid("whisper outcome does not match its record."));
            }
            continue;
        }
        let mut recorded = codec::branch(&result["branch"])?;
        let current = archive
            .branches
            .iter()
            .find(|b| b.id == recorded.id)
            .ok_or_else(|| invalid("outcome branch is missing."))?;
        let cached_head = recorded.head_commit_id.clone();
        recorded.head_commit_id = current.head_commit_id.clone();
        if &recorded != current || !ancestor(reader, &cached_head, &current.head_commit_id)? {
            return Err(invalid(
                "outcome branch metadata or head does not match history.",
            ));
        }
        if result["kind"] == "commit" && result["commit"]["id"] != cached_head {
            return Err(invalid("commit outcome branch head mismatch."));
        }
        if result["kind"] == "start"
            && (result["simulation"] != value(&archive.simulation)
                || result
                    .get("contentRevision")
                    .is_some_and(|r| !same(r, &value(&archive.content_revision)))
                || result["root"]["id"] != cached_head)
        {
            return Err(invalid("start outcome differs from the pinned records."));
        }
    }
    for w in &archive.stage_whispers {
        let command = commands
            .get(string(w, "commandId")?)
            .ok_or_else(|| invalid("whisper lacks provenance."))?;
        if !same(&command.result["whisper"], w) {
            return Err(invalid("whisper command provenance mismatch."));
        }
    }
    Ok(())
}

/// Rebuild all ordinary manual, branch and accepted-draft commands. Memory
/// closure results and historical receipts have their own validators.
pub fn verify_commands(archive: &SimulationArchive) -> Result<()> {
    for record in &archive.command_results {
        let input = &record.canonical_input;
        let kind = string(input, "kind")?;
        let mut repository = ComparisonRepository::new(archive, &record.result, input)?;
        let envelope = || -> Result<Command> {
            let mut v = input.clone();
            v.as_object_mut().unwrap().remove("kind");
            codec::decode(&v)
        };
        match kind {
            "start" => {
                let s = &archive.simulation;
                let r = &archive.content_revision;
                if input["scenarioId"] != value(&s.scenario_id)
                    || input["defaultBranchId"] != s.default_branch_id
                    || input["sourceRoot"] != s.source_root
                    || input
                        .get("compiled")
                        .is_some_and(|c| !same(c, &value(&r.compiled)))
                    || input.get("compiled").is_none() && input["contentRevisionId"] != r.id
                {
                    return Err(invalid("start input basis mismatch."));
                }
            }
            "turn" => {
                reject_manual_internal_fields(input)?;
                commands::commit_manual_turn(&mut repository, envelope()?)?;
            }
            "effects" => {
                commands::commit_effects(&mut repository, envelope()?)?;
            }
            "revise_memory" | "retract_memory" => {
                commands::mutate_memory(&mut repository, envelope()?, kind == "retract_memory")?;
            }
            "fork" => {
                history::fork_branch(&mut repository, input.clone())?;
            }
            "edit" | "regenerate" => {
                reject_manual_internal_fields(input)?;
                history::replace_turn(&mut repository, input.clone(), kind == "regenerate")?;
            }
            "correct_turn_body" => {
                history::correct_turn_body(&mut repository, input.clone())?;
            }
            "whisper" => {
                commands::stage_whisper(&mut repository, input.clone())?;
            }
            "accept_draft" => {
                let commit = codec::commit(&record.result["commit"])?;
                // This verifier deliberately uses the final head: it proves the
                // recorded basis AND the accepted commit are on the branch.
                acceptance::verify_recorded_acceptance(
                    &ArchiveReader::new(archive),
                    input,
                    &commit,
                )?;
            }
            "closure" => {
                super::memory::verify_closure_command(archive, record)?;
            }
            "saved_alternative" => {
                super::historical::verify_alternative(archive, record)?;
            }
            _ => return Err(invalid("command kind is unsupported.")),
        }
    }
    Ok(())
}
fn reject_manual_internal_fields(input: &Value) -> Result<()> {
    if input["payload"].get("logicalMessageId").is_some()
        || input["payload"].get("operation").is_some()
    {
        return Err(invalid("manual input contains internal message fields."));
    }
    Ok(())
}

struct ComparisonRepository<'a> {
    reader: ArchiveReader<'a>,
    outcome: &'a Value,
}
impl<'a> ComparisonRepository<'a> {
    fn new(archive: &'a SimulationArchive, outcome: &'a Value, input: &Value) -> Result<Self> {
        let mut reader = ArchiveReader::new(archive);
        if let Some(head) = input["expectedHead"].as_str() {
            let key = if input.get("sourceBranchId").is_some() {
                "sourceBranchId"
            } else {
                "branchId"
            };
            reader.heads.insert(string(input, key)?.into(), head.into());
        }
        Ok(Self { reader, outcome })
    }
    fn compare_commit(&self, mut commit: Commit) -> Result<Committed> {
        let expected = codec::commit(&self.outcome["commit"])?;
        commit.created_at = expected.created_at.clone();
        // Memory operation clocks are part of the commit's atomic write.
        for event in &mut commit.events {
            if event["type"] == "memory_operation" {
                event["operation"]["createdAt"] = json!(expected.created_at);
            }
        }
        if commit != expected {
            return Err(invalid("events do not match their canonical command."));
        }
        Ok(Committed {
            branch: codec::branch(&self.outcome["branch"])?,
            commit: expected,
            replayed: true,
        })
    }
}
impl SimulationReader for ComparisonRepository<'_> {
    fn actor_draft(&self, o: &str, s: &str, id: &str) -> Result<Option<Value>> {
        self.reader.actor_draft(o, s, id)
    }
    fn pending_whispers(&self, o: &str, s: &str, b: &str, h: &str, a: &str) -> Result<Vec<Value>> {
        self.reader.pending_whispers(o, s, b, h, a)
    }
    fn revision(&self, o: &str, id: &str) -> Result<Option<ContentRevision>> {
        self.reader.revision(o, id)
    }
    fn simulation(&self, o: &str, id: &str) -> Result<Option<Simulation>> {
        self.reader.simulation(o, id)
    }
    fn branch(&self, o: &str, s: &str, id: &str) -> Result<Option<Branch>> {
        self.reader.branch(o, s, id)
    }
    fn commit(&self, o: &str, s: &str, id: &str) -> Result<Option<Commit>> {
        self.reader.commit(o, s, id)
    }
    fn ancestry(&self, o: &str, s: &str, id: &str) -> Result<Vec<Commit>> {
        self.reader.ancestry(o, s, id)
    }
    fn memory_jobs(&self, o: &str, s: &str) -> Result<Vec<Value>> {
        self.reader.memory_jobs(o, s)
    }
    fn detached_memory_operations(&self, o: &str, s: &str) -> Result<Vec<Value>> {
        self.reader.detached_memory_operations(o, s)
    }
}
impl SimulationRepository for ComparisonRepository<'_> {
    fn replay_commit(&self, _: &Value) -> Result<Option<Committed>> {
        Ok(None)
    }
    fn replay_branch(&self, _: &Value) -> Result<Option<BranchOutcome>> {
        Ok(None)
    }
    fn replay_whisper(&self, _: &Value) -> Result<Option<Value>> {
        Ok(None)
    }
    fn append_commit(&mut self, _: &Value, c: Commit) -> Result<Committed> {
        self.compare_commit(c)
    }
    fn create_branch(
        &mut self,
        command: &Value,
        mut branch: Branch,
        commit: Option<Commit>,
    ) -> Result<BranchOutcome> {
        let expected = codec::branch(&self.outcome["branch"])?;
        branch.created_at = expected.created_at.clone();
        if branch != expected || command["sourceBranchId"] == branch.id {
            return Err(invalid("new branch does not match its command."));
        }
        let source = string(command, "sourceBranchId")?;
        let source_head = string(command, "expectedHead")?;
        if !self
            .ancestry(&branch.owner_scope, &branch.simulation_id, source_head)?
            .iter()
            .any(|c| c.id == string(&value(&branch.origin), "baseCommitId").unwrap_or(""))
            || self.reader.archive.branches.iter().all(|b| b.id != source)
        {
            return Err(invalid("new branch base is outside its source path."));
        }
        let commit = commit
            .map(|c| self.compare_commit(c).map(|r| r.commit))
            .transpose()?;
        Ok(BranchOutcome {
            branch: expected,
            commit,
            replayed: true,
        })
    }
    fn create_whisper(&mut self, _: &Value, mut whisper: Value) -> Result<Value> {
        whisper["createdAt"] = self.outcome["whisper"]["createdAt"].clone();
        if !same(&whisper, &self.outcome["whisper"]) {
            return Err(invalid("whisper differs from its command."));
        }
        Ok(whisper)
    }
    fn start_simulation(&mut self, _: StartSimulation) -> Result<StartedSimulation> {
        Err(invalid("verification cannot create simulations."))
    }
    fn request_closure(&mut self, _: &Value, _: Commit, _: Value) -> Result<(Committed, Value)> {
        Err(invalid("verification cannot request memory work."))
    }
    fn start_memory_job(&mut self, _: &str, _: &str, _: &str) -> Result<Value> {
        Err(invalid("verification cannot start memory work."))
    }
    fn settle_memory_job(&mut self, _: &Value, _: Option<&Value>) -> Result<Value> {
        Err(invalid("verification cannot settle memory work."))
    }
}
