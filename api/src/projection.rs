//! Pure branch replay. No generation, persistence writes or host resources.
use crate::{
    access::{self, AccessChange},
    audience::project_turn,
    content::AccessLink,
    error::{EngineError, ErrorCode, Result},
    identity::domain_id,
    model::{Branch, BranchOrigin, Commit},
    ports::SimulationReader,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchProjection {
    #[serde(skip)]
    pub invalidated_closures: HashSet<String>,
    pub branch: Branch,
    pub head: Commit,
    pub commits: Vec<Commit>,
    pub transcript: Vec<Value>,
    pub audience: Vec<Value>,
    pub access_links: Vec<AccessLink>,
    pub beliefs: Vec<Value>,
    pub first_impressions: Vec<Value>,
    pub episode_closures: Vec<Value>,
    pub episode_memories: Vec<Value>,
    pub long_term_memories: Vec<Value>,
    pub perceptions: Vec<Value>,
    pub memory_operations: Vec<Value>,
}
fn missing(label: &str, id: &str) -> EngineError {
    EngineError {
        code: ErrorCode::NotFound,
        message: format!("{label} not found: {id}"),
    }
}
pub fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| EngineError::invalid(format!("Invalid persisted {key}.")))
}
pub fn array<'a>(value: &'a Value, key: &str) -> Result<&'a [Value]> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| EngineError::invalid(format!("Invalid persisted {key}.")))
}
fn event_type(event: &Value) -> Result<&str> {
    string(event, "type")
}

/// A story path inherits corrections to its prefix even if it forked before
/// the correction commit. Nearest correction wins; origin cycles fail closed.
fn body_corrections(
    reader: &impl SimulationReader,
    branch: &Branch,
) -> Result<Vec<(String, Value)>> {
    let mut corrections = Vec::new();
    let mut visited = HashSet::new();
    let mut current = Some(branch.clone());
    while let Some(branch) = current {
        let (source, correction_command) = match &branch.origin {
            BranchOrigin::Root { .. } => break,
            BranchOrigin::Edit {
                source_branch_id,
                command_id,
                ..
            } => (source_branch_id, Some(command_id)),
            BranchOrigin::Fork {
                source_branch_id, ..
            }
            | BranchOrigin::Regenerate {
                source_branch_id, ..
            } => (source_branch_id, None),
        };
        if !visited.insert(branch.id.clone()) {
            return Err(EngineError::invalid("Invalid story path ancestry."));
        }
        if let Some(command) = correction_command {
            let id = domain_id(
                "commit",
                &[&branch.owner_scope, &branch.simulation_id, command],
            );
            if let Some(commit) = reader.commit(&branch.owner_scope, &branch.simulation_id, &id)? {
                if let Some(event) = commit
                    .events
                    .iter()
                    .find(|e| e["type"] == "message_body_corrected")
                {
                    let version = string(event, "messageVersionId")?;
                    if !corrections.iter().any(|(id, _)| id == version) {
                        let mut correction = event.clone();
                        correction["commitId"] = json!(commit.id);
                        corrections.push((version.to_owned(), correction));
                    }
                }
            }
        }
        current = reader.branch(&branch.owner_scope, &branch.simulation_id, source)?;
    }
    Ok(corrections)
}

pub fn project_branch(
    reader: &impl SimulationReader,
    owner: &str,
    simulation_id: &str,
    branch_id: &str,
    head: Option<&str>,
) -> Result<BranchProjection> {
    let mut branch = reader
        .branch(owner, simulation_id, branch_id)?
        .ok_or_else(|| missing("Branch", branch_id))?;
    let selected = head
        .filter(|h| !h.is_empty())
        .unwrap_or(&branch.head_commit_id)
        .to_owned();
    if reader.commit(owner, simulation_id, &selected)?.is_none() {
        return Err(missing("Commit", &selected));
    }
    let ancestry = reader.ancestry(owner, simulation_id, &branch.head_commit_id)?;
    let selected_index = ancestry
        .iter()
        .position(|c| c.id == selected)
        .ok_or_else(|| {
            EngineError::invalid(format!(
                "Commit {selected} is not an ancestor of branch {branch_id}."
            ))
        })?;
    let commits = ancestry[..=selected_index].to_vec();
    let simulation = reader
        .simulation(owner, simulation_id)?
        .ok_or_else(|| missing("Simulation", simulation_id))?;
    let revision = reader
        .revision(owner, &simulation.content_revision_id)?
        .ok_or_else(|| missing("Content revision", &simulation.content_revision_id))?;
    let corrections = body_corrections(reader, &branch)?;
    let present: HashSet<_> = commits
        .iter()
        .flat_map(|c| &c.events)
        .filter(|e| e["type"] == "message_accepted")
        .map(|e| string(&e["message"], "id"))
        .collect::<Result<_>>()?;
    let mut invalidated_closures = HashSet::new();
    for (version, correction) in &corrections {
        if !present.contains(version.as_str()) {
            continue;
        }
        let mut affected = false;
        for commit in reader.ancestry(owner, simulation_id, string(correction, "commitId")?)? {
            if commit
                .events
                .iter()
                .any(|e| e["type"] == "message_accepted" && e["message"]["id"] == *version)
            {
                affected = true;
            }
            if affected && commit.events.iter().any(|e| e["type"] == "episode_closed") {
                invalidated_closures.insert(commit.id);
            }
        }
    }
    let detached = reader.detached_memory_operations(owner, simulation_id)?;
    let completed: HashMap<_, _> = reader
        .memory_jobs(owner, simulation_id)?
        .into_iter()
        .filter(|job| job["status"] == "completed" && !job["result"].is_null())
        .map(|job| {
            Ok((
                string(&job, "closureCommitId")?.to_owned(),
                job["result"].clone(),
            ))
        })
        .collect::<Result<_>>()?;
    let mut transcript: Vec<Value> = Vec::new();
    let mut audience: Vec<Value> = Vec::new();
    let mut access_links = revision.compiled.access_links;
    let mut beliefs = revision
        .compiled
        .beliefs
        .into_iter()
        .map(|b| serde_json::to_value(b).unwrap())
        .collect::<Vec<_>>();
    let mut first_impressions = Vec::new();
    let mut episode_closures = Vec::new();
    let mut memory_operations = Vec::new();
    let mut invalidated_memory_ids = HashSet::new();
    let mut invalidated_belief_ids = HashSet::new();
    for commit in &commits {
        for event in &commit.events {
            match event_type(event)? {
                "message_accepted" => {
                    let message = &event["message"];
                    let mut turn = json!({"id":message["id"],"messageVersionId":message["id"],"logicalMessageId":message["logicalMessageId"],
                        "commitId":commit.id,"simulationId":simulation_id,"actorId":message["actorId"],"text":message["text"],"audience":message["audience"],"episodeId":null,"createdAt":commit.created_at});
                    if !message["performance"].is_null() {
                        turn["performance"] = message["performance"].clone();
                    }
                    transcript.push(turn);
                }
                "message_body_corrected" | "stage_whisper_consumed" => (),
                "audience_changed" => {
                    let actor = string(event, "actorId")?;
                    let position = audience.iter().position(|a| a["actorId"] == actor);
                    let action = string(event, "action")?;
                    if action == "remove" {
                        if let Some(i) = position {
                            audience.remove(i);
                        }
                    } else {
                        if !["add", "deactivate", "reactivate"].contains(&action) {
                            return Err(EngineError::invalid("Unsupported audience action."));
                        }
                        let entry = json!({"actorId":actor,"status":if action == "deactivate" {"inactive"} else {"active"}});
                        if let Some(i) = position {
                            audience[i] = entry;
                        } else {
                            audience.push(entry);
                        }
                    }
                }
                "access_changed" => {
                    let change: AccessChange = serde_json::from_value(json!({"action":event["action"],"member":event["member"],"container":event["container"],"reason":event["reason"]})).map_err(|e| EngineError::invalid(e.to_string()))?;
                    access_links = access::apply_change(&access_links, &change);
                }
                "first_impression_formed" => {
                    let mut impression = event["impression"].clone();
                    impression["id"] = json!(format!(
                        "{}:impression:{}",
                        commit.id,
                        first_impressions.len()
                    ));
                    impression["simulationId"] = json!(simulation_id);
                    impression["createdAt"] = json!(commit.created_at);
                    first_impressions.push(impression.clone());
                    beliefs.push(impression);
                }
                "episode_closed" => {
                    let mut closure = completed
                        .get(&commit.id)
                        .unwrap_or(&event["closure"])
                        .clone();
                    for turn in &mut transcript {
                        if turn["episodeId"].is_null() {
                            turn["episodeId"] = closure["episode"]["id"].clone();
                        }
                    }
                    let late = detached
                        .iter()
                        .filter(|op| op["closureCommitId"] == commit.id)
                        .cloned()
                        .collect::<Vec<_>>();
                    let operations = if late.is_empty() {
                        legacy_closure_operations(commit)?
                    } else {
                        late
                    };
                    if invalidated_closures.contains(&commit.id) {
                        for operation in &operations {
                            invalidated_memory_ids
                                .insert(string(operation, "memoryId")?.to_owned());
                        }
                        for key in ["memories", "longTermMemories"] {
                            for memory in array(&closure, key)? {
                                invalidated_memory_ids.insert(string(memory, "id")?.to_owned());
                            }
                        }
                        for key in ["extractedBeliefs", "retainedBeliefs"] {
                            for belief in array(&closure, key)? {
                                invalidated_belief_ids.insert(string(belief, "id")?.to_owned());
                            }
                        }
                        for key in [
                            "memories",
                            "longTermMemories",
                            "extractedBeliefs",
                            "retainedBeliefs",
                            "memoryOperations",
                        ] {
                            closure[key] = json!([]);
                        }
                    } else {
                        memory_operations.extend(operations);
                        closure["retainedBeliefs"] = json!(
                            array(&closure, "retainedBeliefs")?
                                .iter()
                                .filter(|b| b["sourceBelief"]["id"]
                                    .as_str()
                                    .is_none_or(|id| !invalidated_belief_ids.contains(id)))
                                .cloned()
                                .collect::<Vec<_>>()
                        );
                    }
                    beliefs.extend(array(&closure, "extractedBeliefs")?.iter().cloned());
                    beliefs.extend(array(&closure, "retainedBeliefs")?.iter().cloned());
                    episode_closures.push(closure);
                }
                "memory_operation" => {
                    if !invalidated_memory_ids.contains(string(&event["operation"], "memoryId")?) {
                        memory_operations.push(event["operation"].clone());
                    }
                }
                unknown => {
                    return Err(EngineError::invalid(format!(
                        "Unsupported runtime event: {unknown}"
                    )));
                }
            }
        }
    }
    for (version, correction) in corrections {
        if let Some(turn) = transcript
            .iter_mut()
            .find(|turn| turn["messageVersionId"] == version)
        {
            turn["text"] = correction["text"].clone();
            if !correction["performance"].is_null() {
                turn["performance"] = correction["performance"].clone();
            }
            turn["bodyRevisionId"] = correction["commitId"].clone();
        }
    }
    let mut current: Vec<&Value> = Vec::new();
    for operation in &memory_operations {
        if let Some(i) = current
            .iter()
            .position(|op| op["memoryId"] == operation["memoryId"])
        {
            current[i] = operation;
        } else {
            current.push(operation);
        }
    }
    let mut episode_memories = Vec::new();
    let mut long_term_memories = Vec::new();
    for operation in current.into_iter().filter(|op| op["type"] != "retracted") {
        let episode = operation["memoryKind"] == "episode";
        let key = if episode {
            "memories"
        } else {
            "longTermMemories"
        };
        let original = episode_closures
            .iter()
            .flat_map(|c| c[key].as_array().into_iter().flatten())
            .find(|m| m["id"] == operation["memoryId"]);
        let mut memory = json!({"id":operation["memoryId"],"episodeId":original.and_then(|m| m.get("episodeId")).filter(|id| !id.is_null() && id.as_str() != Some("")).unwrap_or_else(|| if operation["closureCommitId"].is_null() {&operation["basisCommitId"]} else {&operation["closureCommitId"]}),
            "simulationId":operation["simulationId"],"actorId":operation["actorId"],"text":operation["content"],"createdAt":operation["createdAt"]});
        if episode {
            memory["sourceTurnIds"] = original
                .and_then(|m| m.get("sourceTurnIds"))
                .unwrap_or(&operation["sourceMessageVersionIds"])
                .clone();
            for key in [
                "sourcePerceptionIds",
                "sourceEventIds",
                "sourceMessageVersionIds",
            ] {
                memory[key] = operation[key].clone();
            }
            episode_memories.push(memory);
        } else {
            memory["episodeMemoryId"] = original
                .and_then(|m| m.get("episodeMemoryId"))
                .filter(|id| !id.is_null() && id.as_str() != Some(""))
                .unwrap_or_else(|| {
                    if operation["type"] == "consolidated" {
                        &operation["episodeMemoryId"]
                    } else {
                        &operation["memoryId"]
                    }
                })
                .clone();
            long_term_memories.push(memory);
        }
    }
    let perceptions = project_perceptions(&commits)?;
    branch.head_commit_id = selected;
    Ok(BranchProjection {
        invalidated_closures,
        branch,
        head: commits.last().unwrap().clone(),
        commits,
        transcript,
        audience,
        access_links,
        beliefs,
        first_impressions,
        episode_closures,
        episode_memories,
        long_term_memories,
        perceptions,
        memory_operations,
    })
}

pub fn project_perceptions(commits: &[Commit]) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    for commit in commits {
        for (index, event) in commit.events.iter().enumerate() {
            if event_type(event)? != "message_accepted" {
                continue;
            }
            let message = &event["message"];
            let version = string(message, "id")?;
            let source = format!("{}:event:{index}", commit.id);
            for actor in array(message, "audience")? {
                let actor = actor
                    .as_str()
                    .ok_or_else(|| EngineError::invalid("Invalid persisted audience."))?;
                if project_turn(message, actor).is_none() {
                    continue;
                }
                result.push(json!({"id":domain_id("perception",&[actor,&source,version]),"simulationId":commit.simulation_id,"actorId":actor,"sourceCommitId":commit.id,"sourceEventId":source,"sourceMessageVersionId":version,"createdAt":commit.created_at}));
            }
        }
    }
    Ok(result)
}

pub(crate) fn legacy_closure_operations(commit: &Commit) -> Result<Vec<Value>> {
    let Some(event) = commit.events.iter().find(|e| e["type"] == "episode_closed") else {
        return Ok(vec![]);
    };
    let closure = &event["closure"];
    if let Some(operations) = closure.get("memoryOperations").filter(|v| !v.is_null()) {
        return operations
            .as_array()
            .cloned()
            .ok_or_else(|| EngineError::invalid("Invalid closure memory operations."));
    }
    let mut operations = Vec::new();
    for (key, kind, action) in [
        ("memories", "episode", "asserted"),
        ("longTermMemories", "long_term", "consolidated"),
    ] {
        for memory in array(closure, key)? {
            let id = string(memory, "id")?;
            let mut operation = json!({"memoryId":id,"simulationId":commit.simulation_id,"actorId":memory["actorId"],"basisCommitId":commit.parent_commit_id,"closureCommitId":commit.id,
                "sourcePerceptionIds":[],"sourceEventIds":[],"sourceMessageVersionIds":[],"producer":{"mode":"legacy_closure","commandId":commit.command_id},"createdAt":commit.created_at,
                "id":domain_id("memory_operation",&[&commit.id,id,action]),"memoryKind":kind,"type":action,"content":memory["text"]});
            if action == "consolidated" {
                operation["episodeMemoryId"] = memory["episodeMemoryId"].clone();
            }
            operations.push(operation);
        }
    }
    Ok(operations)
}
