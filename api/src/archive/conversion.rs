use super::{SimulationArchive, validate};
use crate::{
    error::{EngineError, Result},
    identity::{domain_id, fingerprint},
    projection::legacy_closure_operations,
};
use serde_json::{Value, json};

pub(super) fn upconvert(mut archive: SimulationArchive) -> Result<SimulationArchive> {
    // Validate untouched legacy results before replacing them with checkpoints.
    let mut untouched = archive.clone();
    untouched.schema_version = 5;
    untouched.memory_jobs = Some(Vec::new());
    untouched.memory_job_transitions = Some(Vec::new());
    untouched.detached_memory_operations = Some(Vec::new());
    validate(&untouched)?;
    if archive
        .command_results
        .iter()
        .any(|c| c.canonical_input["kind"] == "accept_draft")
        || archive
            .commits
            .iter()
            .flat_map(|c| &c.events)
            .any(|e| e["message"]["provenance"]["mode"] == "generated")
    {
        return Err(EngineError::invalid(
            "Legacy archives cannot claim generated provenance.",
        ));
    }
    let mut jobs = Vec::new();
    let mut transitions = Vec::new();
    let mut detached = Vec::new();
    for commit in &mut archive.commits {
        let Some(index) = commit
            .events
            .iter()
            .position(|e| e["type"] == "episode_closed")
        else {
            continue;
        };
        let mut result = commit.events[index]["closure"].clone();
        if result.get("memoryOperations").is_none() {
            result["memoryOperations"] = json!(legacy_closure_operations(commit)?);
        }
        detached.extend(
            result["memoryOperations"]
                .as_array()
                .ok_or_else(|| EngineError::invalid("Legacy closure operations are invalid."))?
                .clone(),
        );
        let command = archive
            .command_results
            .iter_mut()
            .find(|c| c.command_id == commit.command_id && c.canonical_input["kind"] == "closure")
            .ok_or_else(|| EngineError::invalid("Legacy closure command is missing."))?;
        let branch = archive
            .branches
            .iter()
            .find(|b| b.id == command.canonical_input["branchId"])
            .ok_or_else(|| EngineError::invalid("Legacy closure branch is missing."))?;
        let parent = commit
            .parent_commit_id
            .as_ref()
            .ok_or_else(|| EngineError::invalid("Legacy closure basis is missing."))?;
        let id = domain_id(
            "memory_job",
            &[
                &archive.simulation.owner_scope,
                &archive.simulation.id,
                &commit.command_id,
            ],
        );
        let hash = fingerprint(&result);
        jobs.push(json!({"id":id,"ownerScope":archive.simulation.owner_scope,"simulationId":archive.simulation.id,"originBranchId":branch.id,"episodeId":result["episode"]["id"],"closureCommitId":commit.id,"basisHeadCommitId":parent,"commandId":commit.command_id,"label":result["episode"]["label"],"status":"completed","attemptCount":1,"resultFingerprint":hash,"result":result,"lastError":null,"createdAt":commit.created_at,"updatedAt":commit.created_at}));
        for status in ["running", "completed"] {
            transitions.push(json!({"id":domain_id("memory_job_transition",&[&id,"1",status]),"jobId":id,"ownerScope":archive.simulation.owner_scope,"simulationId":archive.simulation.id,"attempt":1,"status":status,"resultFingerprint":if status=="completed" {json!(hash)} else {Value::Null},"result":if status=="completed" {result.clone()} else {Value::Null},"error":null,"createdAt":commit.created_at}));
        }
        for key in [
            "memories",
            "longTermMemories",
            "extractedBeliefs",
            "retainedBeliefs",
            "memoryOperations",
        ] {
            commit.events[index]["closure"][key] = json!([]);
        }
        if command.result["kind"] == "commit" {
            command.result["commit"] = serde_json::to_value(commit).unwrap();
        }
    }
    archive.schema_version = 5;
    archive.memory_jobs = Some(jobs);
    archive.memory_job_transitions = Some(transitions);
    archive.detached_memory_operations = Some(detached);
    Ok(archive)
}
