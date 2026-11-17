//! Memory provenance is checked against each immutable closure basis, never
//! against the importing machine's context, clock or model provider.
use super::{ArchiveReader, RecordedCommandResult, SimulationArchive, codec, verify::ancestor};
use crate::{
    audience::project_turn,
    content::EntityKind,
    error::{EngineError, Result},
    identity::{domain_id, fingerprint},
    model::Commit,
    ports::SimulationReader,
    projection::{array, project_branch, project_perceptions, string},
    retained::derive_retained_beliefs,
};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

fn invalid(message: &str) -> EngineError {
    EngineError::invalid(format!("Simulation archive memory {message}"))
}
fn same(a: &Value, b: &Value) -> bool {
    fingerprint(a) == fingerprint(b)
}
fn values<'a>(value: &'a Value, key: &str) -> Result<&'a [Value]> {
    array(value, key)
}
fn job_arrays(archive: &SimulationArchive) -> Result<(&[Value], &[Value], &[Value])> {
    Ok((
        archive
            .memory_jobs
            .as_deref()
            .ok_or_else(|| invalid("job collection is missing."))?,
        archive
            .memory_job_transitions
            .as_deref()
            .ok_or_else(|| invalid("transition collection is missing."))?,
        archive
            .detached_memory_operations
            .as_deref()
            .ok_or_else(|| invalid("operation collection is missing."))?,
    ))
}
pub fn verify_closure_command(
    archive: &SimulationArchive,
    record: &RecordedCommandResult,
) -> Result<()> {
    let input = &record.canonical_input;
    let commit = codec::commit(&record.result["commit"])?;
    let label = input["payload"]["label"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if input["expectedHead"] != serde_json::to_value(&commit.parent_commit_id).unwrap()
        || commit.kind != "episode_closure"
        || commit.events.len() != 1
        || commit.events[0]["type"] != "episode_closed"
        || input["branchId"] != record.result["branch"]["id"]
        || commit.events[0]["closure"]["episode"]["label"] != json!(label)
    {
        return Err(invalid("closure input mismatch."));
    }
    verify_closure_integrity(archive, &commit, &commit.events[0]["closure"], true)
}
pub fn verify_closure_integrity(
    archive: &SimulationArchive,
    commit: &Commit,
    closure: &Value,
    allow_checkpoint: bool,
) -> Result<()> {
    codec::closure(closure)?;
    let sim = &archive.simulation;
    let episode = domain_id("episode", &[&commit.command_id]);
    if commit.id != domain_id("commit", &[&sim.owner_scope, &sim.id, &commit.command_id])
        || closure["episode"]["id"] != episode
        || closure["episode"]["commitId"] != commit.id
        || closure["episode"]["simulationId"] != sim.id
    {
        return Err(invalid("closure identity mismatch."));
    }
    let reader = ArchiveReader::new(archive);
    let basis = reader.ancestry(
        &sim.owner_scope,
        &sim.id,
        commit
            .parent_commit_id
            .as_deref()
            .ok_or_else(|| invalid("closure basis is missing."))?,
    )?;
    let start = basis
        .iter()
        .rposition(|c| c.kind == "episode_closure")
        .map_or(0, |i| i + 1);
    let open = &basis[start..];
    let turns: Vec<_> = open
        .iter()
        .flat_map(|c| &c.events)
        .filter(|e| e["type"] == "message_accepted")
        .map(|e| &e["message"])
        .collect();
    if turns.is_empty() {
        return Err(invalid("closure has no open turns."));
    }
    let memories = values(closure, "memories")?;
    let long = values(closure, "longTermMemories")?;
    let beliefs = values(closure, "extractedBeliefs")?;
    let retained = values(closure, "retainedBeliefs")?;
    if allow_checkpoint
        && let Some(job) = archive
            .memory_jobs
            .as_ref()
            .and_then(|jobs| jobs.iter().find(|j| j["closureCommitId"] == commit.id))
    {
        if job["episodeId"] != closure["episode"]["id"]
            || !memories.is_empty()
            || !long.is_empty()
            || !beliefs.is_empty()
            || !retained.is_empty()
            || closure["memoryOperations"]
                .as_array()
                .is_some_and(|ops| !ops.is_empty())
        {
            return Err(invalid("checkpoint contains generated results."));
        }
        return Ok(());
    }
    let actors: Vec<_> = archive
        .content_revision
        .compiled
        .entities
        .iter()
        .filter(|e| e.kind == EntityKind::Agent)
        .filter(|e| turns.iter().any(|t| project_turn(t, &e.id).is_some()))
        .map(|e| json!(e.id))
        .collect();
    if memories
        .iter()
        .map(|m| m["actorId"].clone())
        .collect::<Vec<_>>()
        != actors
    {
        return Err(invalid("episode actor set mismatch."));
    }
    let mut record_ids = HashSet::new();
    let mut unique = |id: &Value| -> Result<()> {
        if !record_ids.insert(id.clone()) {
            return Err(invalid("closure contains duplicate record IDs."));
        }
        Ok(())
    };
    for memory in memories {
        let actor = string(memory, "actorId")?;
        let turn_ids: Vec<_> = turns
            .iter()
            .filter(|t| project_turn(t, actor).is_some())
            .map(|t| t["id"].clone())
            .collect();
        let perceptions: Vec<_> = project_perceptions(open)?
            .into_iter()
            .filter(|p| p["actorId"] == actor)
            .collect();
        if string(memory, "text")?.trim().is_empty()
            || memory["id"] != domain_id("episode_memory", &[&commit.command_id, actor])
            || memory["episodeId"] != episode
            || memory["simulationId"] != sim.id
            || memory["sourceTurnIds"] != json!(turn_ids)
        {
            return Err(invalid("episode provenance mismatch."));
        }
        for (key, source) in [
            ("sourcePerceptionIds", "id"),
            ("sourceEventIds", "sourceEventId"),
            ("sourceMessageVersionIds", "sourceMessageVersionId"),
        ] {
            if memory.get(key).is_some() || closure.get("memoryOperations").is_some() {
                if memory[key] != json!(perceptions.iter().map(|p| &p[source]).collect::<Vec<_>>())
                {
                    return Err(invalid("episode perception source mismatch."));
                }
            }
        }
        unique(&memory["id"])?;
    }
    for memory in long {
        let source = memories
            .iter()
            .find(|m| m["id"] == memory["episodeMemoryId"])
            .ok_or_else(|| invalid("long-term memory has no episode source."))?;
        if source["actorId"] != memory["actorId"]
            || string(memory, "text")?.trim().is_empty()
            || memory["id"]
                != domain_id(
                    "long_memory",
                    &[&commit.command_id, string(memory, "actorId")?],
                )
            || memory["episodeId"] != episode
            || memory["simulationId"] != sim.id
        {
            return Err(invalid("long-term provenance mismatch."));
        }
        unique(&memory["id"])?;
    }
    let mut indexes = HashMap::new();
    for belief in beliefs {
        let holder = string(belief, "holder")?;
        let index = indexes.entry(holder).or_insert(0usize);
        let source = memories
            .iter()
            .find(|m| m["id"] == belief["memoryId"])
            .ok_or_else(|| invalid("belief memory source is missing."))?;
        if source["actorId"] != holder
            || belief["id"]
                != domain_id("belief", &[&commit.command_id, holder, &index.to_string()])
            || belief["episodeId"] != episode
            || belief["simulationId"] != sim.id
            || !belief["strength"]
                .as_f64()
                .is_some_and(|s| [-3.0, -1.0, 0.0, 1.0, 3.0].contains(&s))
        {
            return Err(invalid("extracted belief provenance mismatch."));
        }
        *index += 1;
        unique(&belief["id"])?;
    }
    let branch = archive
        .command_results
        .iter()
        .find(|c| c.command_id == commit.command_id && c.canonical_input["kind"] == "closure")
        .and_then(|c| {
            archive
                .branches
                .iter()
                .find(|b| b.id == c.canonical_input["branchId"])
        });
    let excluded = branch
        .map(|b| {
            project_branch(
                &reader,
                &sim.owner_scope,
                &sim.id,
                &b.id,
                commit.parent_commit_id.as_deref(),
            )
            .map(|p| p.invalidated_closures)
        })
        .transpose()?
        .unwrap_or_default();
    let expected = derive_retained_beliefs(
        &archive.content_revision.compiled,
        &basis,
        &excluded,
        &sim.id,
        &commit.command_id,
        &episode,
        string(&closure["episode"], "closedAt")?,
    )?;
    let legacy = if excluded.is_empty() {
        None
    } else {
        Some(derive_retained_beliefs(
            &archive.content_revision.compiled,
            &basis,
            &HashSet::new(),
            &sim.id,
            &commit.command_id,
            &episode,
            string(&closure["episode"], "closedAt")?,
        )?)
    };
    if retained != expected.as_slice() && legacy.as_ref().is_none_or(|v| retained != v.as_slice()) {
        return Err(invalid("retained belief set mismatch."));
    }
    for belief in retained {
        unique(&belief["id"])?;
    }
    if let Some(ops) = closure.get("memoryOperations") {
        let ops = ops
            .as_array()
            .ok_or_else(|| invalid("operations are invalid."))?;
        if ops.len() != memories.len() + long.len() {
            return Err(invalid("closure operation set mismatch."));
        }
        let perceptions = project_perceptions(&basis)?;
        for op in ops {
            verify_operation_basis(archive, commit, op, &perceptions)?;
            if op["basisCommitId"] != json!(commit.parent_commit_id)
                || op["closureCommitId"] != commit.id
                || op["producer"]["mode"] != "episode_closure"
                || op["producer"]["commandId"] != commit.command_id
            {
                return Err(invalid("closure operation provenance mismatch."));
            }
            let episode_memory = memories.iter().find(|m| m["id"] == op["memoryId"]);
            let long_memory = long.iter().find(|m| m["id"] == op["memoryId"]);
            let source = episode_memory
                .or_else(|| {
                    long_memory
                        .and_then(|m| memories.iter().find(|s| s["id"] == m["episodeMemoryId"]))
                })
                .ok_or_else(|| invalid("operation memory target is missing."))?;
            for key in [
                "sourcePerceptionIds",
                "sourceEventIds",
                "sourceMessageVersionIds",
            ] {
                if op[key] != source[key] {
                    return Err(invalid("operation source set mismatch."));
                }
            }
            let (kind, memory) = if let Some(memory) = episode_memory {
                ("asserted", memory)
            } else {
                ("consolidated", long_memory.unwrap())
            };
            if op["type"] != kind
                || op["memoryKind"]
                    != if kind == "asserted" {
                        "episode"
                    } else {
                        "long_term"
                    }
                || op["content"] != memory["text"]
                || op["id"]
                    != domain_id(
                        "memory_operation",
                        &[&commit.id, string(memory, "id")?, kind],
                    )
                || kind == "consolidated" && op["episodeMemoryId"] != memory["episodeMemoryId"]
            {
                return Err(invalid("assertion or consolidation mismatch."));
            }
        }
    }
    Ok(())
}
pub fn verify_operation_basis(
    archive: &SimulationArchive,
    commit: &Commit,
    op: &Value,
    perceptions: &[Value],
) -> Result<()> {
    let reader = ArchiveReader::new(archive);
    if !archive
        .content_revision
        .compiled
        .entities
        .iter()
        .any(|a| a.id == op["actorId"] && a.kind.can_own_turn())
        || op["simulationId"] != archive.simulation.id
        || op["createdAt"] != commit.created_at
        || !ancestor(
            &reader,
            string(op, "basisCommitId")?,
            commit.parent_commit_id.as_deref().unwrap_or(&commit.id),
        )?
    {
        return Err(invalid("operation basis mismatch."));
    }
    for key in [
        "sourcePerceptionIds",
        "sourceEventIds",
        "sourceMessageVersionIds",
    ] {
        let ids = array(op, key)?;
        let unique: HashSet<_> = ids.iter().map(|v| v.as_str()).collect();
        if ids.len() != unique.len() {
            return Err(invalid("operation has duplicate sources."));
        }
    }
    let sources = array(op, "sourcePerceptionIds")?
        .iter()
        .map(|id| {
            perceptions
                .iter()
                .find(|p| p["id"] == *id)
                .ok_or_else(|| invalid("perception source is missing."))
        })
        .collect::<Result<Vec<_>>>()?;
    if sources.iter().any(|p| p["actorId"] != op["actorId"])
        || [
            ("sourceEventIds", "sourceEventId"),
            ("sourceMessageVersionIds", "sourceMessageVersionId"),
        ]
        .iter()
        .any(|(key, source)| {
            op[*key] != json!(sources.iter().map(|p| &p[*source]).collect::<Vec<_>>())
        })
    {
        return Err(invalid("perception provenance mismatch."));
    }
    Ok(())
}

pub fn verify_jobs(archive: &SimulationArchive) -> Result<()> {
    verify_jobs_with_reader(&ArchiveReader::new(archive))
}
pub(super) fn verify_jobs_with_reader(reader: &ArchiveReader<'_>) -> Result<()> {
    let archive = reader.archive;
    let (jobs, transitions, operations) = job_arrays(archive)?;
    let sim = &archive.simulation;
    let mut ids = HashSet::new();
    let mut transition_ids = HashSet::new();
    let mut operation_ids = HashSet::new();
    for transition in transitions {
        reader.check_cancelled()?;
        for key in ["resultFingerprint", "result", "error"] {
            if transition.get(key).is_none() {
                return Err(invalid("transition payload field is missing."));
            }
        }
        codec::strings(
            transition,
            &["id", "jobId", "ownerScope", "simulationId", "createdAt"],
        )?;
        if !transition_ids.insert(string(transition, "id")?)
            || transition["attempt"].as_u64().is_none_or(|n| n < 1)
        {
            return Err(invalid("transition identity or attempt is invalid."));
        }
        codec::enumeration(
            &transition["status"],
            &["running", "failed", "completed"],
            "job status",
        )?;
    }
    for operation in operations {
        reader.check_cancelled()?;
        codec::memory_operation(operation)?;
        if !matches!(
            operation["type"].as_str(),
            Some("asserted" | "consolidated")
        ) || !operation_ids.insert(string(operation, "id")?)
        {
            return Err(invalid("detached operation type or identity is invalid."));
        }
    }
    for job in jobs {
        reader.check_cancelled()?;
        codec::strings(
            job,
            &[
                "id",
                "ownerScope",
                "simulationId",
                "originBranchId",
                "episodeId",
                "closureCommitId",
                "basisHeadCommitId",
                "commandId",
                "createdAt",
                "updatedAt",
            ],
        )?;
        for key in ["label", "resultFingerprint", "lastError"] {
            if job.get(key).is_none() {
                return Err(invalid("job field is missing."));
            }
            codec::nullable_text(&job[key], key)?;
        }
        if job.get("result").is_none()
            || !(job["result"].is_null() || job["result"].is_object())
            || !ids.insert(string(job, "id")?)
        {
            return Err(invalid("job record is malformed or duplicated."));
        }
        let closure = archive
            .commits
            .iter()
            .find(|c| c.id == job["closureCommitId"])
            .ok_or_else(|| invalid("job closure is missing."))?;
        let branch = archive
            .branches
            .iter()
            .find(|b| b.id == job["originBranchId"])
            .ok_or_else(|| invalid("job origin branch is missing."))?;
        let command = archive
            .command_results
            .iter()
            .find(|c| c.command_id == job["commandId"] && c.canonical_input["kind"] == "closure")
            .ok_or_else(|| invalid("job request command is missing."))?;
        let input = &command.canonical_input;
        if closure.kind != "episode_closure"
            || json!(closure.parent_commit_id) != job["basisHeadCommitId"]
            || closure.command_id != job["commandId"]
            || !ancestor(&reader, &closure.id, &branch.head_commit_id)?
            || job["ownerScope"] != sim.owner_scope
            || job["simulationId"] != sim.id
            || job["id"]
                != domain_id(
                    "memory_job",
                    &[&sim.owner_scope, &sim.id, string(job, "commandId")?],
                )
            || job["episodeId"] != domain_id("episode", &[string(job, "commandId")?])
            || job["attemptCount"].as_u64().is_none()
        {
            return Err(invalid("job identity or basis mismatch."));
        }
        codec::enumeration(
            &job["status"],
            &["pending", "running", "failed", "completed"],
            "job status",
        )?;
        let checkpoint = closure
            .events
            .iter()
            .find(|e| e["type"] == "episode_closed")
            .ok_or_else(|| invalid("job checkpoint is missing."))?;
        let label = input["payload"]["label"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if input["branchId"] != job["originBranchId"]
            || input["expectedHead"] != job["basisHeadCommitId"]
            || json!(label) != job["label"]
            || checkpoint["closure"]["episode"]["label"] != job["label"]
            || checkpoint["closure"]["episode"]["closedAt"] != job["createdAt"]
            || closure.created_at != job["createdAt"]
        {
            return Err(invalid("job request is not bound to its checkpoint."));
        }
        verify_transitions(
            archive,
            job,
            &transitions
                .iter()
                .filter(|t| t["jobId"] == job["id"])
                .collect::<Vec<_>>(),
        )?;
        let detached: Vec<_> = operations
            .iter()
            .filter(|op| op["closureCommitId"] == job["closureCommitId"])
            .collect();
        if job["status"] == "completed" {
            if job["attemptCount"].as_u64().unwrap() < 1
                || job["resultFingerprint"].as_str().is_none_or(str::is_empty)
                || !job["lastError"].is_null()
                || fingerprint(&job["result"]) != job["resultFingerprint"]
                || job["result"]["memoryOperations"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    != detached.iter().map(|v| (*v).clone()).collect::<Vec<_>>()
            {
                return Err(invalid("completed job result mismatch."));
            }
            verify_closure_integrity(archive, closure, &job["result"], false)?;
            if job["result"]["episode"]["id"] != job["episodeId"]
                || job["result"]["episode"]["commitId"] != job["closureCommitId"]
                || job["result"]["episode"]["label"] != job["label"]
            {
                return Err(invalid("job episode identity mismatch."));
            }
            let basis =
                reader.ancestry(&sim.owner_scope, &sim.id, string(job, "basisHeadCommitId")?)?;
            let start = basis
                .iter()
                .rposition(|c| c.kind == "episode_closure")
                .map_or(0, |i| i + 1);
            let perceptions = project_perceptions(&basis[start..])?;
            let actors: Vec<_> = archive
                .content_revision
                .compiled
                .entities
                .iter()
                .filter(|e| {
                    e.kind == EntityKind::Agent && perceptions.iter().any(|p| p["actorId"] == e.id)
                })
                .map(|e| json!(e.id))
                .collect();
            if detached
                .iter()
                .filter(|op| op["type"] == "asserted")
                .map(|op| op["actorId"].clone())
                .collect::<Vec<_>>()
                != actors
            {
                return Err(invalid("completed operation actor set is incomplete."));
            }
        } else if !detached.is_empty()
            || !job["result"].is_null()
            || !job["resultFingerprint"].is_null()
            || job["status"] == "pending"
                && (job["attemptCount"] != 0 || !job["lastError"].is_null())
            || job["status"] == "running"
                && (job["attemptCount"].as_u64().unwrap() < 1 || !job["lastError"].is_null())
            || job["status"] == "failed"
                && (job["attemptCount"].as_u64().unwrap() < 1
                    || job["lastError"].as_str().is_none_or(str::is_empty))
        {
            return Err(invalid("incomplete job has an invalid result or state."));
        }
        let basis =
            reader.ancestry(&sim.owner_scope, &sim.id, string(job, "basisHeadCommitId")?)?;
        let perceptions = project_perceptions(&basis)?;
        let start = basis
            .iter()
            .rposition(|c| c.kind == "episode_closure")
            .map_or(0, |i| i + 1);
        let open = project_perceptions(&basis[start..])?;
        for op in &detached {
            if op["basisCommitId"] != job["basisHeadCommitId"]
                || op["producer"]["mode"] != "episode_closure"
                || op["producer"]["commandId"] != job["commandId"]
                || op["type"] == "asserted" && op["memoryKind"] != "episode"
                || op["type"] == "consolidated" && op["memoryKind"] != "long_term"
                || string(op, "content")?.trim().is_empty()
            {
                return Err(invalid("detached operation basis mismatch."));
            }
            verify_operation_basis(archive, closure, op, &perceptions)?;
            let sources: Vec<_> = open
                .iter()
                .filter(|p| p["actorId"] == op["actorId"])
                .collect();
            for (key, source) in [
                ("sourcePerceptionIds", "id"),
                ("sourceEventIds", "sourceEventId"),
                ("sourceMessageVersionIds", "sourceMessageVersionId"),
            ] {
                if op[key] != json!(sources.iter().map(|p| &p[source]).collect::<Vec<_>>()) {
                    return Err(invalid("detached provenance is incomplete."));
                }
            }
            if op["id"]
                != domain_id(
                    "memory_operation",
                    &[
                        string(job, "closureCommitId")?,
                        string(op, "memoryId")?,
                        string(op, "type")?,
                    ],
                )
                || op["memoryId"]
                    != domain_id(
                        if op["type"] == "asserted" {
                            "episode_memory"
                        } else {
                            "long_memory"
                        },
                        &[string(job, "commandId")?, string(op, "actorId")?],
                    )
                || op["type"] == "consolidated"
                    && !detached.iter().any(|other| {
                        other["type"] == "asserted"
                            && other["memoryId"] == op["episodeMemoryId"]
                            && other["actorId"] == op["actorId"]
                    })
            {
                return Err(invalid(
                    "detached operation identity or consolidation source mismatch.",
                ));
            }
        }
        let consolidations: Vec<_> = detached
            .iter()
            .filter(|op| op["type"] == "consolidated")
            .collect();
        if consolidations
            .iter()
            .map(|op| op["actorId"].as_str())
            .collect::<HashSet<_>>()
            .len()
            != consolidations.len()
        {
            return Err(invalid("contains duplicate consolidations."));
        }
    }
    if transitions
        .iter()
        .any(|t| !jobs.iter().any(|j| j["id"] == t["jobId"]))
        || operations.iter().any(|op| {
            !jobs
                .iter()
                .any(|j| j["closureCommitId"] == op["closureCommitId"])
        })
    {
        return Err(invalid("transition or detached operation has no owner."));
    }
    Ok(())
}
fn verify_transitions(
    archive: &SimulationArchive,
    job: &Value,
    transitions: &[&Value],
) -> Result<()> {
    let mut index = 0;
    let mut attempt = 1u64;
    while index < transitions.len() {
        let running = transitions[index];
        index += 1;
        if running["status"] != "running" || running["attempt"].as_u64() != Some(attempt) {
            return Err(invalid("transition order is invalid."));
        }
        verify_transition_identity(archive, job, running)?;
        if let Some(terminal) = transitions.get(index) {
            if !matches!(terminal["status"].as_str(), Some("failed" | "completed"))
                || terminal["attempt"].as_u64() != Some(attempt)
            {
                return Err(invalid("terminal transition is invalid."));
            }
            verify_transition_identity(archive, job, terminal)?;
            index += 1;
            if terminal["status"] == "completed" && index != transitions.len() {
                return Err(invalid("has transitions after completion."));
            }
            attempt += 1;
        }
    }
    let expected = if let Some(latest) = transitions.last() {
        json!({"status":latest["status"],"attemptCount":latest["attempt"],"resultFingerprint":latest["resultFingerprint"],"result":latest["result"],"lastError":latest["error"],"updatedAt":latest["createdAt"]})
    } else {
        json!({"status":"pending","attemptCount":0,"resultFingerprint":null,"result":null,"lastError":null,"updatedAt":job["createdAt"]})
    };
    for (key, value) in expected.as_object().unwrap() {
        if !same(&job[key], value) {
            return Err(invalid("job current state is forged."));
        }
    }
    Ok(())
}
fn verify_transition_identity(archive: &SimulationArchive, job: &Value, t: &Value) -> Result<()> {
    let attempt = t["attempt"]
        .as_u64()
        .ok_or_else(|| invalid("transition attempt is invalid."))?;
    let status = string(t, "status")?;
    let unsafe_error = Regex::new("(?i)(?:bearer|api[_-]?key|token|sk-)").unwrap();
    if t["id"]
        != domain_id(
            "memory_job_transition",
            &[string(job, "id")?, &attempt.to_string(), status],
        )
        || t["ownerScope"] != archive.simulation.owner_scope
        || t["simulationId"] != archive.simulation.id
        || status == "completed"
            && (t["result"].is_null()
                || t["resultFingerprint"].as_str().is_none_or(str::is_empty)
                || !t["error"].is_null())
        || status != "completed" && (!t["result"].is_null() || !t["resultFingerprint"].is_null())
        || status == "failed"
            && t["error"].as_str().is_none_or(|e| {
                e.is_empty() || e.encode_utf16().count() > 256 || unsafe_error.is_match(e)
            })
        || status == "running" && !t["error"].is_null()
    {
        return Err(invalid("transition identity or payload is invalid."));
    }
    Ok(())
}
