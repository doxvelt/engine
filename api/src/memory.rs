//! Episode closure requests are immutable commits. Formation finishes later and
//! attaches results without advancing the branch or rewriting the closure.
use crate::{
    audience::project_turn,
    commands::compiled,
    content::{Entity, EntityKind},
    context::{ContextOptions, inspect_actor_context},
    error::ErrorCode,
    projection::string,
    retained::derive_retained_beliefs,
};
use crate::{
    commands::assert_expected_head,
    error::{EngineError, Result},
    identity::domain_id,
    model::{Command, Commit},
    ports::SimulationRepository,
    projection::project_branch,
};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use std::collections::HashSet;

pub struct BeliefCandidate {
    pub strength: f64,
    pub proposition: String,
}
pub trait ClosureGenerator {
    fn write_memory(
        &mut self,
        actor: &Entity,
        context: &Value,
        turns: &[Value],
        label: Option<&str>,
    ) -> Result<String>;
    fn write_long_term_memory(
        &mut self,
        _actor: &Entity,
        _context: &Value,
        _memory: &Value,
    ) -> Result<Option<String>> {
        Ok(None)
    }
    fn extract_beliefs(
        &mut self,
        actor: &Entity,
        context: &Value,
        memory: &Value,
    ) -> Result<Vec<BeliefCandidate>>;
}
pub struct DeterministicClosureGenerator;
impl ClosureGenerator for DeterministicClosureGenerator {
    fn write_memory(
        &mut self,
        actor: &Entity,
        _context: &Value,
        turns: &[Value],
        label: Option<&str>,
    ) -> Result<String> {
        let transcript = turns
            .iter()
            .map(|turn| {
                Ok(format!(
                    "{}: {}",
                    string(turn, "actorId")?,
                    string(turn, "text")?
                ))
            })
            .collect::<Result<Vec<_>>>()?
            .join(" ");
        Ok(format!(
            "I am @{}. {}I remember {transcript}",
            actor.id,
            label
                .filter(|s| !s.is_empty())
                .map(|s| format!("In {s}, "))
                .unwrap_or_default()
        ))
    }
    fn extract_beliefs(
        &mut self,
        actor: &Entity,
        _context: &Value,
        memory: &Value,
    ) -> Result<Vec<BeliefCandidate>> {
        Ok(vec![BeliefCandidate {
            strength: 1.0,
            proposition: format!(
                "@{} experienced an episode with {} accessible turn(s).",
                actor.id,
                crate::projection::array(memory, "sourceTurnIds")?.len()
            ),
        }])
    }
}

pub fn run_memory_job(
    repository: &mut impl SimulationRepository,
    owner: &str,
    simulation: &str,
    id: &str,
    generator: &mut impl ClosureGenerator,
) -> Result<Value> {
    let existing = repository
        .memory_jobs(owner, simulation)?
        .into_iter()
        .find(|job| job["id"] == id)
        .ok_or_else(|| EngineError {
            code: ErrorCode::NotFound,
            message: format!("Memory job not found: {id}"),
        })?;
    if existing["status"] == "completed" {
        let operations = repository
            .detached_memory_operations(owner, simulation)?
            .into_iter()
            .filter(|op| op["closureCommitId"] == existing["closureCommitId"])
            .collect::<Vec<_>>();
        return Ok(
            json!({"job":existing,"operations":operations,"closure":existing["result"],"replayed":true}),
        );
    }
    let job = repository.start_memory_job(owner, simulation, id)?;
    let closure = match generate_closure(repository, &job, generator) {
        Ok(result) => result,
        Err(error) => {
            repository.settle_memory_job(&job, None)?;
            return Err(error);
        }
    };
    let completed = repository.settle_memory_job(&job, Some(&closure))?;
    Ok(
        json!({"job":completed,"operations":closure["memoryOperations"],"closure":closure,"replayed":false}),
    )
}

fn generate_closure(
    reader: &impl SimulationRepository,
    job: &Value,
    generator: &mut impl ClosureGenerator,
) -> Result<Value> {
    let owner = string(job, "ownerScope")?;
    let simulation = string(job, "simulationId")?;
    let branch = string(job, "originBranchId")?;
    let head = string(job, "basisHeadCommitId")?;
    let command = string(job, "commandId")?;
    let created = string(job, "createdAt")?;
    let episode = string(job, "episodeId")?;
    let p = project_branch(reader, owner, simulation, branch, Some(head))?;
    let start = p
        .commits
        .iter()
        .rposition(|c| c.kind == "episode_closure")
        .map_or(0, |i| i + 1);
    let open_ids: HashSet<_> = p.commits[start..].iter().map(|c| c.id.as_str()).collect();
    let turns = p
        .transcript
        .iter()
        .filter(|t| {
            t["commitId"]
                .as_str()
                .is_some_and(|id| open_ids.contains(id))
        })
        .collect::<Vec<_>>();
    let compiled = compiled(reader, owner, simulation)?;
    let mut memories = Vec::new();
    let mut long_term = Vec::new();
    let mut beliefs = Vec::new();
    let mut operations = Vec::new();
    for actor in compiled
        .entities
        .iter()
        .filter(|e| e.kind == EntityKind::Agent)
    {
        let perceptions = p
            .perceptions
            .iter()
            .filter(|perception| {
                perception["actorId"] == actor.id
                    && perception["sourceCommitId"]
                        .as_str()
                        .is_some_and(|id| open_ids.contains(id))
            })
            .collect::<Vec<_>>();
        if perceptions.is_empty() {
            continue;
        }
        let accessible = turns
            .iter()
            .filter(|turn| {
                perceptions.iter().any(|perception| {
                    perception["sourceMessageVersionId"] == turn["messageVersionId"]
                })
            })
            .filter_map(|turn| project_turn(turn, &actor.id))
            .collect::<Vec<_>>();
        let selected: HashSet<_> = accessible
            .iter()
            .map(|t| string(t, "id").map(str::to_owned))
            .collect::<Result<_>>()?;
        let context = inspect_actor_context(
            reader,
            owner,
            simulation,
            branch,
            Some(head),
            &actor.id,
            ContextOptions {
                selected_turn_ids: Some(&selected),
                ..Default::default()
            },
        )?;
        let text = generator
            .write_memory(actor, &context, &accessible, job["label"].as_str())?
            .trim()
            .to_owned();
        if text.is_empty() {
            return Err(EngineError::invalid("Episode memory content is empty."));
        }
        let memory = json!({"id":domain_id("episode_memory",&[command,&actor.id]),"episodeId":episode,"simulationId":simulation,"actorId":actor.id,"text":text,
            "sourceTurnIds":accessible.iter().map(|t| &t["id"]).collect::<Vec<_>>(),"sourcePerceptionIds":perceptions.iter().map(|p| &p["id"]).collect::<Vec<_>>(),
            "sourceEventIds":perceptions.iter().map(|p| &p["sourceEventId"]).collect::<Vec<_>>(),"sourceMessageVersionIds":perceptions.iter().map(|p| &p["sourceMessageVersionId"]).collect::<Vec<_>>(),"createdAt":created});
        operations.push(make_operation(
            job,
            &memory,
            "asserted",
            &text,
            string(&memory, "id")?,
        )?);
        if let Some(text) = generator
            .write_long_term_memory(actor, &context, &memory)?
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
        {
            let id = domain_id("long_memory", &[command, &actor.id]);
            long_term.push(json!({"id":id,"episodeId":episode,"episodeMemoryId":memory["id"],"simulationId":simulation,"actorId":actor.id,"text":text,"createdAt":created}));
            operations.push(make_operation(job, &memory, "consolidated", &text, &id)?);
        }
        let mut index = 0;
        for candidate in generator.extract_beliefs(actor, &context, &memory)? {
            let text = candidate.proposition.trim();
            if text.is_empty() {
                continue;
            }
            let strength = if candidate.strength >= 3.0 {
                3
            } else if candidate.strength > 0.0 {
                1
            } else if candidate.strength <= -3.0 {
                -3
            } else if candidate.strength < 0.0 {
                -1
            } else {
                0
            };
            beliefs.push(json!({"id":domain_id("belief",&[command,&actor.id,&index.to_string()]),"episodeId":episode,"memoryId":memory["id"],"simulationId":simulation,"holder":actor.id,"strength":strength,"propositionText":text,"createdAt":created}));
            index += 1;
        }
        memories.push(memory);
    }
    let retained = derive_retained_beliefs(
        &compiled,
        &p.commits,
        &p.invalidated_closures,
        simulation,
        command,
        episode,
        created,
    )?;
    Ok(
        json!({"episode":{"id":episode,"simulationId":simulation,"commitId":job["closureCommitId"],"label":job["label"],"closedAt":created},"memories":memories,"longTermMemories":long_term,"extractedBeliefs":beliefs,"retainedBeliefs":retained,"memoryOperations":operations}),
    )
}
fn make_operation(
    job: &Value,
    memory: &Value,
    action: &str,
    text: &str,
    memory_id: &str,
) -> Result<Value> {
    let mut operation = json!({"id":domain_id("memory_operation",&[string(job,"closureCommitId")?,memory_id,action]),"memoryId":memory_id,"simulationId":job["simulationId"],"actorId":memory["actorId"],
        "memoryKind":if action == "asserted" {"episode"} else {"long_term"},"basisCommitId":job["basisHeadCommitId"],"closureCommitId":job["closureCommitId"],"sourcePerceptionIds":memory["sourcePerceptionIds"],"sourceEventIds":memory["sourceEventIds"],"sourceMessageVersionIds":memory["sourceMessageVersionIds"],"producer":{"mode":"episode_closure","commandId":job["commandId"]},"createdAt":job["createdAt"],"type":action,"content":text});
    if action == "consolidated" {
        operation["episodeMemoryId"] = memory["id"].clone();
    }
    Ok(operation)
}

pub fn request_episode_closure(
    repository: &mut impl SimulationRepository,
    mut command: Command,
) -> Result<Value> {
    let label = command.payload["label"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    command.payload = json!({"label":label});
    let mut recorded = serde_json::to_value(&command).unwrap();
    recorded["kind"] = json!("closure");
    let ids = [
        &*command.owner_scope,
        &*command.simulation_id,
        &*command.command_id,
    ];
    let job_id = domain_id("memory_job", &ids);
    if let Some(prior) = repository.replay_commit(&recorded)? {
        let job = repository
            .memory_jobs(&command.owner_scope, &command.simulation_id)?
            .into_iter()
            .find(|job| job["id"] == job_id)
            .ok_or_else(|| EngineError::invalid("Replayed closure has no memory job."))?;
        let mut result = serde_json::to_value(prior).unwrap();
        result["job"] = job;
        return Ok(result);
    }
    assert_expected_head(repository, &command)?;
    let p = project_branch(
        repository,
        &command.owner_scope,
        &command.simulation_id,
        &command.branch_id,
        Some(&command.expected_head),
    )?;
    let start = p
        .commits
        .iter()
        .rposition(|c| c.kind == "episode_closure")
        .map_or(0, |i| i + 1);
    if !p.commits[start..]
        .iter()
        .any(|c| c.events.iter().any(|e| e["type"] == "message_accepted"))
    {
        return Err(EngineError::invalid(format!(
            "No unclosed turns to close for simulation: {}",
            command.simulation_id
        )));
    }
    let created = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let commit_id = domain_id("commit", &ids);
    let episode_id = domain_id("episode", &[&command.command_id]);
    let closure = json!({"episode":{"id":episode_id,"simulationId":command.simulation_id,"commitId":commit_id,"label":label,"closedAt":created},"memories":[],"longTermMemories":[],"extractedBeliefs":[],"retainedBeliefs":[],"memoryOperations":[]});
    let job = json!({"id":job_id,"ownerScope":command.owner_scope,"simulationId":command.simulation_id,"originBranchId":command.branch_id,"episodeId":episode_id,"closureCommitId":commit_id,"basisHeadCommitId":command.expected_head,"commandId":command.command_id,
        "label":label,"status":"pending","attemptCount":0,"resultFingerprint":null,"result":null,"lastError":null,"createdAt":created,"updatedAt":created});
    let commit = Commit {
        id: commit_id,
        owner_scope: command.owner_scope,
        simulation_id: command.simulation_id,
        parent_commit_id: Some(command.expected_head),
        kind: "episode_closure".into(),
        command_id: command.command_id,
        events: vec![json!({"type":"episode_closed","closure":closure})],
        created_at: created,
    };
    let (committed, job) = repository.request_closure(&recorded, commit, job)?;
    let mut result = serde_json::to_value(committed).unwrap();
    result["job"] = job;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        application::{StartRequest, start_from_source},
        commands::commit_manual_turn,
        projection::project_branch,
        storage::Store,
    };
    use std::path::Path;
    struct FailingGenerator;
    impl ClosureGenerator for FailingGenerator {
        fn write_memory(
            &mut self,
            _: &Entity,
            _: &Value,
            _: &[Value],
            _: Option<&str>,
        ) -> Result<String> {
            Err(EngineError::invalid("Private provider detail"))
        }
        fn extract_beliefs(
            &mut self,
            _: &Entity,
            _: &Value,
            _: &Value,
        ) -> Result<Vec<BeliefCandidate>> {
            unreachable!()
        }
    }
    #[test]
    fn failed_jobs_retry_without_rewriting_history_and_reject_stale_settlement() {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let started = start_from_source(
            &mut store,
            StartRequest {
                owner_scope: "local",
                simulation_id: "story",
                command_id: "start",
                scenario_id: Some("last-crossing".into()),
                branch_id: Some("main".into()),
            },
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/last-crossing"),
        )
        .unwrap();
        let turn = commit_manual_turn(&mut store,Command {owner_scope:"local".into(),simulation_id:"story".into(),branch_id:"main".into(),expected_head:started.root.id,command_id:"turn".into(),payload:json!({"actorId":"corin","audience":["mara"],"text":"Only we heard this.","knowledgePolicy":"actor-knowledge-v1"})}).unwrap();
        let requested = request_episode_closure(
            &mut store,
            Command {
                owner_scope: "local".into(),
                simulation_id: "story".into(),
                branch_id: "main".into(),
                expected_head: turn.commit.id,
                command_id: "close".into(),
                payload: json!({"label":"Evening"}),
            },
        )
        .unwrap();
        let id = requested["job"]["id"].as_str().unwrap();
        let commits = project_branch(&store, "local", "story", "main", None)
            .unwrap()
            .commits;
        assert!(run_memory_job(&mut store, "local", "story", id, &mut FailingGenerator).is_err());
        let failed = store.memory_jobs("local", "story").unwrap().remove(0);
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["lastError"], "Memory generation failed.");
        let second = store.start_memory_job("local", "story", id).unwrap();
        assert_eq!(second["attemptCount"], 2);
        assert_eq!(
            store
                .settle_memory_job(&requested["job"], None)
                .unwrap_err()
                .code,
            ErrorCode::MemoryJobConflict
        );
        let invalid = json!({"episode":{"id":"wrong","commitId":requested["commit"]["id"],"simulationId":"story"},"memoryOperations":[]});
        assert!(store.settle_memory_job(&second, Some(&invalid)).is_err());
        assert!(
            store
                .detached_memory_operations("local", "story")
                .unwrap()
                .is_empty()
        );
        store.settle_memory_job(&second, None).unwrap();
        let done = run_memory_job(
            &mut store,
            "local",
            "story",
            id,
            &mut DeterministicClosureGenerator,
        )
        .unwrap();
        assert_eq!(done["job"]["attemptCount"], 3);
        assert_eq!(done["job"]["status"], "completed");
        assert_eq!(done["closure"]["memories"].as_array().unwrap().len(), 2);
        assert!(
            !done["closure"]["memories"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["actorId"] == "nell")
        );
        let replay =
            run_memory_job(&mut store, "local", "story", id, &mut FailingGenerator).unwrap();
        assert_eq!(replay["closure"], done["closure"]);
        assert_eq!(replay["replayed"], true);
        assert_eq!(
            project_branch(&store, "local", "story", "main", None)
                .unwrap()
                .commits,
            commits
        );
        assert_eq!(
            store
                .memory_job_transitions("local", "story", Some(id))
                .unwrap()
                .len(),
            6
        );
    }
}
