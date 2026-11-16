//! Native application dispatch. The fallback bridge is retired operation by
//! operation while the TypeScript implementation serves as the parity oracle.
use crate::routes::Operation;
use doxvelt_engine::{
    application::{StartRequest, start_from_source},
    commands::{self, KNOWLEDGE_POLICY, commit_manual_turn},
    content::compile_workspace,
    context::{ContextOptions, inspect_actor_context},
    error::{EngineError, Result},
    history,
    memory::{DeterministicClosureGenerator, request_episode_closure, run_memory_job},
    model::Command,
    projection::project_branch,
    storage::Store,
};
use serde_json::{Map, Value, json};
use std::path::Path;

pub fn handles(operation: &str) -> bool {
    if crate::historical::handles(operation) {
        return true;
    }
    if ["draft.read", "draft.list", "draft.discard"].contains(&operation) {
        return true;
    }
    operation.starts_with("projection.")
        || operation.starts_with("source.")
        || operation.starts_with("navigation.")
        || operation.starts_with("package.")
        || operation.starts_with("branch.")
        || operation == "turn.correct"
        || [
            "episode.request-closure",
            "episode.close",
            "memory-job.run",
            "memory-job.list",
            "memory-job.transitions",
        ]
        .contains(&operation)
        || operation.starts_with("memory.")
        || [
            "audience.change",
            "access.change",
            "whisper.list",
            "whisper.create",
        ]
        .contains(&operation)
        || matches!(
            operation,
            "source.compile"
                | "simulation.start"
                | "simulation.list"
                | "recovery.identity"
                | "actors.list"
                | "context.read"
                | "turn.perform"
                | "example.play"
        )
}
pub(crate) fn optional(body: &Map<String, Value>, key: &str) -> Result<Option<String>> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(EngineError::invalid(format!("{key} must be a string."))),
    }
}
pub(crate) fn required(body: &Map<String, Value>, key: &str) -> Result<String> {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| EngineError::invalid(format!("{key} must be a non-empty string.")))
}
fn workspace(body: &Map<String, Value>) -> Result<String> {
    body.get("workspacePath")
        .filter(|value| !value.is_null())
        .or_else(|| body.get("worldPath"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| EngineError::invalid("workspacePath is required."))
}
pub fn execute(operation: Operation, database: &Path) -> Result<Value> {
    if operation.operation.starts_with("source.") && operation.operation != "source.compile" {
        use doxvelt_engine::{error::ErrorCode, source};
        let query = |key: &str| {
            operation
                .query
                .get(key)
                .filter(|s| !s.is_empty())
                .cloned()
                .ok_or_else(|| EngineError::invalid(format!("{key} is required.")))
        };
        let body = &operation.body;
        let result = match operation.operation.as_str() {
            "source.list" => source::list(Path::new(&query("workspacePath")?)),
            "source.read" => source::read(Path::new(&query("workspacePath")?), &query("path")?),
            "source.write" => {
                let text = body
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| EngineError::invalid("text must be a string."))?;
                source::write(Path::new(&workspace(body)?), &required(body, "path")?, text)
            }
            "source.init" => source::init(
                Path::new(&workspace(body)?),
                optional(body, "template")?.as_deref(),
            ),
            "source.delete" => source::delete(Path::new(&workspace(body)?)),
            _ => {
                return Err(EngineError {
                    code: ErrorCode::NotFound,
                    message: "Unknown source route.".into(),
                });
            }
        };
        // Source path/OS failures were server-side errors in the existing API;
        // transport body validation above retains its explicit 400 responses.
        return result.map_err(|mut e| {
            e.code = ErrorCode::Internal;
            e
        });
    }
    if operation.operation == "package.export" {
        return doxvelt_engine::portable::export_package(
            database,
            "local",
            &optional(&operation.body, "simulationId")?
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| "default".into()),
            Path::new(&required(&operation.body, "targetDir")?),
        );
    }
    if operation.operation == "package.import" {
        let target = optional(&operation.body, "targetDbPath")?.filter(|path| !path.is_empty());
        return doxvelt_engine::portable::import_package(
            Path::new(&required(&operation.body, "packageDir")?),
            Path::new(&required(&operation.body, "targetSourceDir")?),
            target.as_deref().map(Path::new).unwrap_or(database),
            Some("local"),
        );
    }
    if operation.operation == "source.compile" {
        return Ok(serde_json::to_value(compile_workspace(Path::new(&workspace(
            &operation.body,
        )?))?)
        .expect("compiled source"));
    }
    let mut store = Store::open(database)?;
    if operation.operation == "example.play" {
        if !operation.body.is_empty() {
            return Err(EngineError::invalid(
                "Example setup accepts an empty object; the app chooses the workspace and run.",
            ));
        }
        let database = doxvelt_engine::safe_fs::absolute(database)?;
        return doxvelt_engine::examples::play_last_crossing(
            &mut store,
            database
                .parent()
                .ok_or_else(|| EngineError::invalid("Example data directory is missing."))?,
        );
    }
    if crate::historical::handles(&operation.operation) {
        return crate::historical::execute(operation, &mut store);
    }
    if operation.operation.starts_with("navigation.") {
        let simulation = operation
            .simulation_id
            .as_deref()
            .ok_or_else(|| EngineError::invalid("simulationId is required."))?;
        if store.simulation("local", simulation)?.is_none() {
            return Err(EngineError {
                code: doxvelt_engine::error::ErrorCode::NotFound,
                message: format!("Simulation not found: {simulation}"),
            });
        }
        if operation.operation == "navigation.read" {
            let branch = operation
                .query
                .get("branchId")
                .filter(|s| !s.is_empty())
                .ok_or_else(|| EngineError::invalid("branchId must be a non-empty string."))?;
            if store.branch("local", simulation, branch)?.is_none() {
                return Err(EngineError {
                    code: doxvelt_engine::error::ErrorCode::NotFound,
                    message: "Saved branch not found.".into(),
                });
            }
            return Ok(json!({"version":store.navigation_version("local")?}));
        }
        let body = &operation.body;
        if body
            .keys()
            .any(|key| !["branchId", "operationId", "expectedVersion"].contains(&key.as_str()))
        {
            return Err(EngineError::invalid("Unexpected navigation field."));
        }
        let expected = match body.get("expectedVersion") {
            Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.as_str()),
            _ => return Err(EngineError::invalid("Invalid navigation token.")),
        };
        return store.record_simulation_opened(
            "local",
            simulation,
            &required(body, "branchId")?,
            &required(body, "operationId")?,
            expected,
        );
    }
    if ["draft.read", "draft.list", "draft.discard"].contains(&operation.operation.as_str())
        || operation.operation.starts_with("projection.")
        || operation.operation.starts_with("branch.")
        || operation.operation == "turn.correct"
        || [
            "episode.request-closure",
            "episode.close",
            "memory-job.run",
            "memory-job.list",
            "memory-job.transitions",
        ]
        .contains(&operation.operation.as_str())
        || operation.operation.starts_with("memory.")
        || [
            "audience.change",
            "access.change",
            "whisper.list",
            "whisper.create",
        ]
        .contains(&operation.operation.as_str())
        || ["actors.list", "context.read", "turn.perform"].contains(&operation.operation.as_str())
    {
        let simulation_id = operation
            .simulation_id
            .as_deref()
            .ok_or_else(|| EngineError::invalid("simulationId is required."))?;
        let simulation = store
            .simulation("local", simulation_id)?
            .ok_or_else(|| EngineError {
                code: doxvelt_engine::error::ErrorCode::NotFound,
                message: format!("Simulation not found: {simulation_id}"),
            })?;
        let branch = operation
            .query
            .get("branchId")
            .filter(|s| !s.is_empty())
            .map(String::as_str)
            .unwrap_or(&simulation.default_branch_id);
        if operation.operation == "draft.discard" {
            let id = operation
                .resource_id
                .as_deref()
                .ok_or_else(|| EngineError::invalid("draftId is required."))?;
            let (draft, replayed) = store.discard_actor_draft(
                "local",
                simulation_id,
                id,
                &required(&operation.body, "commandId")?,
            )?;
            return Ok(json!({"draft":stage_draft(&draft),"replayed":replayed}));
        }
        if operation.operation == "draft.read" {
            let id = operation
                .resource_id
                .as_deref()
                .ok_or_else(|| EngineError::invalid("draftId is required."))?;
            let draft = store
                .actor_draft("local", simulation_id, id)?
                .ok_or_else(|| EngineError {
                    code: doxvelt_engine::error::ErrorCode::NotFound,
                    message: format!("Draft not found: {id}"),
                })?;
            return Ok(stage_draft(&draft));
        }
        if operation.operation == "draft.list" {
            let branch = operation
                .query
                .get("branchId")
                .filter(|s| !s.is_empty())
                .ok_or_else(|| EngineError::invalid("branchId is required for draft discovery."))?;
            if store.branch("local", simulation_id, branch)?.is_none() {
                return Err(EngineError {
                    code: doxvelt_engine::error::ErrorCode::NotFound,
                    message: format!("Branch not found: {branch}"),
                });
            }
            return Ok(
                json!({"drafts":store.recoverable_actor_drafts("local",simulation_id,branch)?.iter().map(stage_draft).collect::<Vec<_>>()}),
            );
        }
        if operation.operation == "memory-job.list" {
            return Ok(json!(store.memory_jobs("local", simulation_id)?));
        }
        if operation.operation == "memory-job.transitions" {
            return Ok(json!(store.memory_job_transitions(
                "local",
                simulation_id,
                operation.resource_id.as_deref()
            )?));
        }
        if operation.operation == "memory-job.run" {
            return run_memory_job(
                &mut store,
                "local",
                simulation_id,
                operation
                    .resource_id
                    .as_deref()
                    .ok_or_else(|| EngineError::invalid("jobId is required."))?,
                &mut DeterministicClosureGenerator,
            );
        }
        if ["episode.request-closure", "episode.close"].contains(&operation.operation.as_str()) {
            let body = &operation.body;
            let requested = request_episode_closure(
                &mut store,
                Command {
                    owner_scope: "local".into(),
                    simulation_id: simulation_id.into(),
                    branch_id: required(body, "branchId")?,
                    expected_head: required(body, "expectedHead")?,
                    command_id: required(body, "commandId")?,
                    payload: json!({"label":optional(body,"label")?.filter(|s| !s.is_empty())}),
                },
            )?;
            if operation.operation == "episode.close" {
                let run = run_memory_job(
                    &mut store,
                    "local",
                    simulation_id,
                    requested["job"]["id"]
                        .as_str()
                        .ok_or_else(|| EngineError::invalid("Missing memory job."))?,
                    &mut DeterministicClosureGenerator,
                )?;
                let mut closure = run["closure"].clone();
                closure["commit"] = requested["commit"].clone();
                return Ok(closure);
            }
            return Ok(requested);
        }
        if operation.operation == "whisper.create" {
            let body = &operation.body;
            return commands::stage_whisper(
                &mut store,
                json!({"ownerScope":"local","simulationId":simulation_id,"branchId":required(body,"branchId")?,"expectedHead":required(body,"expectedHead")?,"commandId":required(body,"commandId")?,"targetActorId":required(body,"targetActorId")?,"text":required(body,"text")?}),
            );
        }
        if operation.operation.starts_with("branch.") || operation.operation == "turn.correct" {
            let body = &operation.body;
            let mut request = json!({"ownerScope":"local","simulationId":simulation_id,"expectedHead":required(body,"expectedHead")?,"commandId":required(body,"commandId")?});
            let result = if operation.operation == "turn.correct" {
                if body.keys().any(|key| {
                    ![
                        "sourceBranchId",
                        "expectedHead",
                        "commandId",
                        "messageVersionId",
                        "text",
                    ]
                    .contains(&key.as_str())
                }) {
                    return Err(EngineError::invalid(
                        "Save correction changes only the performance wording.",
                    ));
                }
                request["sourceBranchId"] = json!(required(body, "sourceBranchId")?);
                request["payload"] = json!({"messageVersionId":required(body,"messageVersionId")?,"text":required(body,"text")?});
                history::correct_turn_body(&mut store, request)?
            } else {
                request["sourceBranchId"] = json!(required(body, "branchId")?);
                request["branchId"] = json!(required(body, "newBranchId")?);
                if operation.operation == "branch.fork" {
                    request["atCommitId"] = json!(required(body, "atCommitId")?);
                    request["name"] = json!(optional(body, "name")?.filter(|s| !s.is_empty()));
                    history::fork_branch(&mut store, request)?
                } else {
                    request["sourceCommitId"] = json!(required(body, "sourceCommitId")?);
                    request["payload"] = json!({"actorId":required(body,"actorId")?,"text":required(body,"manualText")?,"audience":if body.contains_key("audience") {commands::strings(&Value::Object(body.clone()),"audience")?} else {vec![]}});
                    history::replace_turn(
                        &mut store,
                        request,
                        operation.operation == "branch.regenerate",
                    )?
                }
            };
            return Ok(serde_json::to_value(result).unwrap());
        }
        if operation.operation == "whisper.list" {
            let head = operation
                .query
                .get("expectedHead")
                .filter(|s| !s.is_empty())
                .ok_or_else(|| EngineError::invalid("expectedHead is required."))?;
            let actor = operation
                .query
                .get("actorId")
                .filter(|s| !s.is_empty())
                .ok_or_else(|| EngineError::invalid("actorId is required."))?;
            return Ok(
                json!({"stageWhispers":store.pending_whispers("local",simulation_id,branch,head,actor)?}),
            );
        }
        if operation.operation.starts_with("memory.")
            || ["audience.change", "access.change"].contains(&operation.operation.as_str())
        {
            let body = &operation.body;
            let payload = if operation.operation.starts_with("memory.") {
                let mut payload = json!({"actorId":required(body,"actorId")?,"memoryId":required(body,"memoryId")?});
                for key in if operation.operation == "memory.revise" {
                    vec!["revisesOperationId", "content"]
                } else {
                    vec!["retractsOperationId"]
                } {
                    payload[key] = json!(required(body, key)?);
                }
                payload
            } else {
                let key = if operation.operation == "audience.change" {
                    "audienceChanges"
                } else {
                    "accessChanges"
                };
                let fields: &[&str] = if key == "audienceChanges" {
                    &["actorId", "action"]
                } else {
                    &["action", "member", "container"]
                };
                let wrapped = Map::from_iter([(key.to_owned(), json!([body]))]);
                json!({key:changes(&wrapped,key,fields)?})
            };
            let command = Command {
                owner_scope: "local".into(),
                simulation_id: simulation_id.into(),
                branch_id: required(body, "branchId")?,
                expected_head: required(body, "expectedHead")?,
                command_id: required(body, "commandId")?,
                payload,
            };
            let result = if operation.operation.starts_with("memory.") {
                commands::mutate_memory(
                    &mut store,
                    command,
                    operation.operation == "memory.retract",
                )?
            } else {
                commands::commit_effects(&mut store, command)?
            };
            return Ok(serde_json::to_value(result).unwrap());
        }
        if operation.operation == "actors.list" {
            return Ok(
                json!({"simulationId":simulation_id,"actors":commands::compiled(&store,"local",simulation_id)?.entities.into_iter().filter(|e| e.kind.can_own_turn()).collect::<Vec<_>>()}),
            );
        }
        if operation.operation == "turn.perform" {
            return perform(&mut store, simulation_id, &operation.body);
        }
        let p = project_branch(
            &store,
            "local",
            simulation_id,
            branch,
            operation.query.get("head").map(String::as_str),
        )?;
        if operation.operation == "context.read" {
            let actor = operation
                .resource_id
                .as_deref()
                .ok_or_else(|| EngineError::invalid("actorId is required."))?;
            let whispers = store.pending_whispers(
                "local",
                simulation_id,
                branch,
                &p.branch.head_commit_id,
                actor,
            )?;
            return inspect_actor_context(
                &store,
                "local",
                simulation_id,
                branch,
                Some(&p.branch.head_commit_id),
                actor,
                ContextOptions {
                    whispers: &whispers,
                    ..Default::default()
                },
            );
        }
        return Ok(match operation.operation.as_str() {
            "projection.transcript" => json!({"branch":p.branch,"transcript":p.transcript}),
            "projection.audience" => {
                json!({"branch":p.branch,"activeAudience":p.audience.iter().filter(|a| a["status"] == "active").map(|a| &a["actorId"]).collect::<Vec<_>>(),"audienceMembers":p.audience})
            }
            "projection.access" => json!({"branch":p.branch,"effectiveAccessLinks":p.access_links}),
            "projection.beliefs" => json!({"branch":p.branch,"beliefs":p.beliefs}),
            "projection.memories" => {
                json!({"branch":p.branch,"memories":p.episode_memories,"longTermMemories":p.long_term_memories,"operations":p.memory_operations,"perceptions":p.perceptions})
            }
            "projection.branches" => {
                json!({"branch":p.branch,"branches":store.branches("local",simulation_id)?})
            }
            _ => return Err(EngineError::invalid("Unknown projection.")),
        });
    }
    match operation.operation.as_str() {
        "simulation.start" => {
            let source = workspace(&operation.body)?;
            let simulation = optional(&operation.body, "simulationId")?
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "default".into());
            let command = required(&operation.body, "commandId")?;
            let started = start_from_source(
                &mut store,
                StartRequest {
                    owner_scope: "local",
                    simulation_id: &simulation,
                    command_id: &command,
                    scenario_id: Some(
                        optional(&operation.body, "scenarioId")?
                            .filter(|value| !value.is_empty())
                            .unwrap_or_else(|| "default".into()),
                    ),
                    branch_id: Some(
                        optional(&operation.body, "branchId")?
                            .filter(|value| !value.is_empty())
                            .unwrap_or_else(|| "main".into()),
                    ),
                },
                Path::new(&source),
            )?;
            let compiled = started.content_revision.compiled.clone();
            let mut result = serde_json::to_value(started).expect("started simulation");
            let object = result.as_object_mut().unwrap();
            object.insert(
                "actors".into(),
                serde_json::to_value(
                    compiled
                        .entities
                        .iter()
                        .filter(|entity| entity.kind.can_own_turn())
                        .collect::<Vec<_>>(),
                )
                .unwrap(),
            );
            object.insert(
                "models".into(),
                serde_json::to_value(&compiled.models).unwrap(),
            );
            object.insert(
                "diagnostics".into(),
                serde_json::to_value(&compiled.diagnostics).unwrap(),
            );
            object.insert("compiled".into(), serde_json::to_value(compiled).unwrap());
            Ok(result)
        }
        "simulation.list" => Ok(json!({"simulations":store.list_simulations("local")?})),
        "recovery.identity" => store.recovery_identity("local"),
        _ => Err(EngineError::invalid("Unknown native operation.")),
    }
}

pub(crate) fn stage_draft(draft: &Value) -> Value {
    let mut stage = Map::new();
    for field in [
        "id",
        "branchId",
        "basisHeadCommitId",
        "actorId",
        "audience",
        "status",
        "artifact",
        "failure",
        "createdAt",
        "generationCommandId",
    ] {
        stage.insert(field.into(), draft[field].clone());
    }
    if let Some(audience) = draft["artifact"].get("proposedAudience") {
        stage.insert("audience".into(), audience.clone());
    }
    if let Some(routing) = draft.get("routing") {
        let snapshots = draft["stageWhispers"]
            .as_array()
            .expect("validated whisper snapshots");
        let version = routing["version"].as_f64();
        let complete = if [Some(2.0), Some(3.0)].contains(&version) {
            routing["completeWhisper"].clone()
        } else if !routing["sourceDraftId"].is_null() || snapshots.len() > 1 {
            Value::Null
        } else {
            snapshots
                .first()
                .map(|s| s["text"].clone())
                .unwrap_or(json!(""))
        };
        stage.insert("routingReview".into(),json!({"completeWhisper":complete,"initialAudience":routing["initialAudience"],"correctedAudience":routing["correctedAudience"],"originalWhisper":snapshots.iter().map(|s| &s["text"]).collect::<Vec<_>>(),"correction":routing["correction"],"sourceDraftId":routing["sourceDraftId"],"sourceAudience":routing["source"]["audience"],"originalDraftId":routing["originalDraftId"],"preserved":!routing["preservedText"].is_null()}));
    }
    Value::Object(stage)
}
fn perform(store: &mut Store, simulation_id: &str, body: &Map<String, Value>) -> Result<Value> {
    let knowledge = match body.get("knowledgePolicy") {
        None => false,
        Some(Value::String(policy)) if policy == KNOWLEDGE_POLICY => true,
        _ => return Err(EngineError::invalid("Unsupported manual knowledge policy.")),
    };
    let syntax = body
        .get("audienceSyntax")
        .map(|v| {
            serde_json::from_value::<doxvelt_engine::audience::AudienceSyntax>(v.clone())
                .map_err(|_| EngineError::invalid("Unsupported audience syntax."))
        })
        .transpose()?;
    if syntax.is_some() && !knowledge {
        return Err(EngineError::invalid(
            "Scoped authoring requires actor-knowledge-v1.",
        ));
    }
    let branch = required(body, "branchId")?;
    let head = required(body, "expectedHead")?;
    let command = required(body, "commandId")?;
    if optional(body, "modelId")?.is_some_and(|s| !s.is_empty()) {
        return Err(EngineError::invalid(
            "Model output must be generated with turn-draft and accepted separately as manualText.",
        ));
    }
    let text = required(body, "manualText")?;
    let actor = required(body, "actorId")?;
    let body_value = Value::Object(body.clone());
    if !body.contains_key("stageWhisperIds") {
        return Err(EngineError::invalid("stageWhisperIds is required."));
    }
    let whisper_ids = commands::strings(&body_value, "stageWhisperIds")?;
    let mut envelope = Command {
        owner_scope: "local".into(),
        simulation_id: simulation_id.into(),
        branch_id: branch.clone(),
        expected_head: head.clone(),
        command_id: command,
        payload: Value::Null,
    };
    if store.commit("local", simulation_id, &head)?.is_none() {
        commands::assert_expected_head(store, &envelope)?;
    }
    let audience = if syntax.is_some() && body.get("audience").is_none_or(Value::is_null) {
        None
    } else if body.contains_key("audience") {
        Some(commands::strings(&body_value, "audience")?)
    } else {
        Some(
            project_branch(store, "local", simulation_id, &branch, Some(&head))?
                .audience
                .iter()
                .filter(|a| a["status"] == "active")
                .filter_map(|a| a["actorId"].as_str().map(str::to_owned))
                .collect::<Vec<_>>(),
        )
    };
    let whispers = store
        .pending_whispers("local", simulation_id, &branch, &head, &actor)?
        .into_iter()
        .filter(|w| {
            w["id"]
                .as_str()
                .is_some_and(|id| whisper_ids.iter().any(|selected| selected == id))
        })
        .collect::<Vec<_>>();
    let context = if knowledge {
        None
    } else {
        Some(inspect_actor_context(
            store,
            "local",
            simulation_id,
            &branch,
            Some(&head),
            &actor,
            ContextOptions {
                audience: audience.as_deref(),
                whispers: &whispers,
                ..Default::default()
            },
        )?)
    };
    envelope.payload = json!({"actorId":actor,"text":text,"audience":audience,"stageWhisper":optional(body,"whisperText")?.filter(|s| !s.is_empty()),"stageWhisperIds":whisper_ids,
        "audienceChanges":changes(body,"audienceChanges",&["actorId","action"])? ,"accessChanges":changes(body,"accessChanges",&["action","member","container"])?});
    if let Some(syntax) = syntax {
        envelope.payload["audienceSyntax"] = serde_json::to_value(syntax).unwrap();
    }
    if knowledge {
        envelope.payload["knowledgePolicy"] = json!(KNOWLEDGE_POLICY);
    }
    let committed = commit_manual_turn(store, envelope)?;
    let turn = project_branch(store, "local", simulation_id, &branch, None)?
        .transcript
        .into_iter()
        .find(|t| t["commitId"] == committed.commit.id);
    let mut result = serde_json::to_value(committed).unwrap();
    if let Some(turn) = turn {
        result["turn"] = turn;
    }
    if let Some(context) = context {
        result["context"] = context;
    }
    Ok(result)
}
fn changes(body: &Map<String, Value>, key: &str, fields: &[&str]) -> Result<Vec<Value>> {
    let Some(values) = body.get(key) else {
        return Ok(vec![]);
    };
    values
        .as_array()
        .ok_or_else(|| EngineError::invalid(format!("{key} must be an array of objects.")))?
        .iter()
        .map(|v| {
            let object = v.as_object().ok_or_else(|| {
                EngineError::invalid(format!("{key} must be an array of objects."))
            })?;
            let mut change = Map::new();
            for field in fields {
                change.insert((*field).into(), json!(required(object, field)?));
            }
            let action = change["action"].as_str().unwrap();
            let allowed: &[&str] = if key == "audienceChanges" {
                &["add", "remove", "deactivate", "reactivate"]
            } else {
                &["grant", "revoke"]
            };
            if !allowed.contains(&action) {
                return Err(EngineError::invalid("action is invalid."));
            }
            change.insert(
                "reason".into(),
                json!(optional(object, "reason")?.filter(|s| !s.is_empty())),
            );
            Ok(Value::Object(change))
        })
        .collect()
}
