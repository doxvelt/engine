//! Async model orchestration. SQLite/domain work runs on blocking workers;
//! the host services provider streams and retains all credentials.
use crate::{
    Bridge, HostError, Reply,
    native::{required, stage_draft},
    routes::Operation,
};
use doxvelt_engine::{
    acceptance::accept_actor_draft,
    commands::{self, KNOWLEDGE_POLICY},
    draft_contracts,
    drafts::{self, PrepareOptions},
    error::{EngineError, ErrorCode, Result as EngineResult},
    model::{AcceptRequest, Command},
    projection::{project_branch, string},
    runtime::{FailureCode, Observation, RuntimeStream, StopReason, StreamFailure, StreamOutcome},
    storage::Store,
};
use serde_json::{Map, Value, json};
use std::{path::Path, sync::atomic::Ordering};

const ROUTING_POLICY: &str = "audience-proposal-v1";
pub fn handles(operation: &str) -> bool {
    [
        "draft.create",
        "draft.revise",
        "draft.retry",
        "draft.accept",
        "alternative.create",
        "alternative.retry",
    ]
    .contains(&operation)
}
pub async fn execute(bridge: &Bridge, operation: Operation, database: String) -> Reply {
    match run(bridge, operation, database).await {
        Ok(value) => Reply::ok(value),
        Err(error) => Reply::error(error.status, &error.message),
    }
}
pub(crate) async fn store<T: Send + 'static>(
    database: &str,
    work: impl FnOnce(&mut Store) -> EngineResult<T> + Send + 'static,
) -> Result<T, HostError> {
    let database = database.to_owned();
    tokio::task::spawn_blocking(move || work(&mut Store::open(Path::new(&database))?))
        .await
        .map_err(|_| HostError {
            status: 500,
            message: "Native generation worker failed.".into(),
        })?
        .map_err(Into::into)
}
fn invalid(message: &str) -> EngineError {
    EngineError::invalid(message)
}
fn strings(
    body: &Map<String, Value>,
    key: &str,
    required_field: bool,
) -> EngineResult<Vec<String>> {
    if !body.contains_key(key) {
        return if required_field {
            Err(invalid(&format!("{key} is required.")))
        } else {
            Ok(vec![])
        };
    }
    commands::strings(&Value::Object(body.clone()), key)
}
pub(crate) fn reject_runtime_selection(body: &Map<String, Value>) -> EngineResult<()> {
    for key in [
        "modelId",
        "baseUrl",
        "runtimeProfile",
        "actorProfile",
        "promptPolicy",
        "outputSchema",
        "skills",
        "apiKey",
        "ownerScope",
    ] {
        if body.contains_key(key) {
            return Err(invalid(&format!(
                "{key} is deployment-owned and must not be supplied."
            )));
        }
    }
    Ok(())
}
fn envelope(body: &Map<String, Value>, simulation: &str) -> EngineResult<Command> {
    Ok(Command {
        owner_scope: "local".into(),
        simulation_id: simulation.into(),
        branch_id: required(body, "branchId")?,
        expected_head: required(body, "expectedHead")?,
        command_id: required(body, "commandId")?,
        payload: Value::Null,
    })
}
pub(crate) async fn describe(
    bridge: &Bridge,
    actor: &str,
    configuration: Option<Value>,
    profile: Option<&Value>,
) -> Result<Value, HostError> {
    let mut request = json!({"actorId":actor});
    if let Some(configuration) = configuration {
        request["configuration"] = configuration;
    }
    if let Some(profile) = profile {
        request["profile"] = profile.clone();
    }
    let result = bridge.call("model.describe", request).await?;
    draft_contracts::reference(&result["profile"], "Runtime profile")?;
    if !result["configured"].is_boolean() {
        return Err(HostError {
            status: 502,
            message: "Invalid model service description.".into(),
        });
    }
    Ok(result)
}
async fn run(bridge: &Bridge, operation: Operation, database: String) -> Result<Value, HostError> {
    if operation.operation.starts_with("alternative.") {
        return crate::historical::generate(bridge, operation, &database).await;
    }
    if operation.operation == "draft.accept" {
        return accept(operation, &database).await;
    }
    let simulation = operation
        .simulation_id
        .ok_or_else(|| invalid("simulationId is required."))?;
    let sim = simulation.clone();
    let id = operation.resource_id.clone();
    let creating = operation.operation == "draft.create";
    let original = store(&database, move |store| {
        if store.simulation("local", &sim)?.is_none() {
            return Err(EngineError {
                code: ErrorCode::NotFound,
                message: format!("Simulation not found: {sim}"),
            });
        }
        if creating {
            Ok(None)
        } else {
            store.actor_draft(
                "local",
                &sim,
                id.as_deref()
                    .ok_or_else(|| invalid("draftId is required."))?,
            )
        }
    })
    .await?;
    let body = operation.body;
    let (command, retry, recall) = if creating {
        reject_runtime_selection(&body)?;
        if body
            .get("draftingPolicy")
            .is_some_and(|p| p != ROUTING_POLICY && p != KNOWLEDGE_POLICY)
        {
            return Err(invalid("Unsupported drafting policy.").into());
        }
        let actor = required(&body, "actorId")?;
        let configuration = if body.contains_key("actorConfiguration") {
            Some(json!(required(&body, "actorConfiguration")?))
        } else {
            None
        };
        let description = describe(bridge, &actor, configuration, None).await?;
        if description["configured"] != true {
            return Err(HostError {
                status: 503,
                message: "No local actor-turn runtime is configured.".into(),
            });
        }
        let knowledge = body
            .get("draftingPolicy")
            .is_some_and(|p| p == KNOWLEDGE_POLICY);
        let routed = knowledge
            || body
                .get("draftingPolicy")
                .is_some_and(|p| p == ROUTING_POLICY);
        if body.get("fixedAudience").is_some_and(|v| !v.is_boolean()) {
            return Err(invalid("fixedAudience must be a boolean.").into());
        }
        let fixed = body.get("fixedAudience") == Some(&Value::Bool(true));
        if fixed && (!knowledge || !body.get("audience").is_some_and(Value::is_array)) {
            return Err(invalid(
                "A fixed audience requires an explicit audience and actor knowledge policy.",
            )
            .into());
        }
        let limit = body
            .get("audienceLimit")
            .map(|_| strings(&body, "audienceLimit", true))
            .transpose()?;
        if limit.is_some()
            && (!knowledge || fixed || body.get("audience").is_some_and(|v| !v.is_null()))
        {
            return Err(invalid("An audience limit requires an actor choice.").into());
        }
        if knowledge && !body.get("completeWhisper").is_some_and(Value::is_string) {
            return Err(invalid("New actor knowledge policy requires completeWhisper.").into());
        }
        let mut command = envelope(&body, &simulation)?;
        let audience = if routed && body.get("audience").is_none_or(Value::is_null) {
            vec![]
        } else if body.contains_key("audience") {
            strings(&body, "audience", false)?
        } else {
            let basis = command.clone();
            store(&database, move |store| {
                Ok(project_branch(
                    store,
                    &basis.owner_scope,
                    &basis.simulation_id,
                    &basis.branch_id,
                    Some(&basis.expected_head),
                )?
                .audience
                .into_iter()
                .filter(|a| a["status"] == "active")
                .filter_map(|a| a["actorId"].as_str().map(str::to_owned))
                .collect::<Vec<_>>())
            })
            .await?
        };
        command.payload = json!({"actorId":actor,"audience":audience,"stageWhisperIds":strings(&body,"stageWhisperIds",false)?,"runtimeProfile":description["profile"],
            "promptPolicy":{"id":if knowledge {KNOWLEDGE_POLICY} else if routed {ROUTING_POLICY} else {"default"},"version":"v1"},
            "outputSchema":if routed {json!({"id":"audience-proposal","digest":"v1"})} else {json!({"id":"screenplay","digest":"schema-v1"})},"skillDigests":[]});
        if routed {
            let mut routing = json!({"version":if knowledge {3} else {1},"initialAudience":if fixed || body.get("audience").is_none_or(Value::is_null) {Value::Null} else {json!(audience)},"correction":"","correctedAudience":if fixed {json!(audience)} else {Value::Null},"preservedText":null,"sourceDraftId":null});
            if knowledge {
                routing["completeWhisper"] = body["completeWhisper"].clone();
            }
            if let Some(limit) = limit {
                routing["audienceLimit"] = json!(limit);
            }
            command.payload["routing"] = routing;
        }
        let recall = if knowledge && description["memoryEnabled"] == true {
            let recalled = crate::episode_api::recall(
                bridge,
                &database,
                doxvelt_engine::episode_memory::EpisodeQuery {
                    owner_scope: "local".into(),
                    simulation_id: simulation.clone(),
                    branch_id: command.branch_id.clone(),
                    head: Some(command.expected_head.clone()),
                },
                actor.clone(),
                body["completeWhisper"].as_str().unwrap().into(),
            )
            .await?;
            let wrapped = json!({"episodeRecall":recalled});
            doxvelt_engine::routing::captured_episode_recall(&wrapped)?
        } else {
            None
        };
        (command, None, recall)
    } else {
        let revised = operation.operation == "draft.revise";
        let allowed: &[&str] = if revised {
            &[
                "commandId",
                "audience",
                "correction",
                "completeWhisper",
                "preservedText",
                "draftingPolicy",
            ]
        } else {
            &["commandId"]
        };
        if body.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(invalid(if revised {
                "Unexpected revision field."
            } else {
                "Retry accepts only a commandId; routing is captured by the original draft."
            })
            .into());
        }
        let original = original.ok_or_else(|| {
            if revised {
                invalid("Revision requires a routed source draft.")
            } else {
                EngineError {
                    code: ErrorCode::NotFound,
                    message: "Draft not found.".into(),
                }
            }
        })?;
        if revised && original.get("routing").is_none() {
            return Err(invalid("Revision requires a routed source draft.").into());
        }
        let mut command = if revised {
            revision_command(&body, &original)?
        } else {
            drafts::captured_command(&original, &required(&body, "commandId")?)?
        };
        let description = describe(
            bridge,
            string(&original, "actorId")?,
            None,
            Some(&original["runtimeProfile"]),
        )
        .await?;
        let preserved = command
            .payload
            .get("routing")
            .is_some_and(|routing| !routing["preservedText"].is_null());
        if !preserved && description["configured"] != true {
            return Err(HostError {
                status: 503,
                message: "No local actor-turn runtime is configured.".into(),
            });
        }
        command.command_id = required(&body, "commandId")?;
        let retry = if revised {
            None
        } else {
            Some(string(&original, "id")?.to_owned())
        };
        (command, retry, None)
    };
    let lease_bridge = bridge.clone();
    let lease_database = database.clone();
    let (prepared, lease) = store(&database, move |store| {
        let prepared = drafts::prepare_actor_draft(
            store,
            command,
            PrepareOptions {
                retry_draft_id: retry.as_deref(),
                episode_recall: recall.as_ref(),
            },
        )?;
        // Own cleanup from the moment reservation commits, even if the awaiting
        // request disappears while this blocking worker is returning its result.
        let lease = (!prepared.replayed).then(|| GenerationLease {
            bridge: lease_bridge,
            database: lease_database,
            draft: prepared.draft.clone(),
            identity: json!({}),
            observation: Observation::default(),
            finished: false,
        });
        Ok((prepared, lease))
    })
    .await?;
    if prepared.replayed {
        return Ok(json!({"draft":stage_draft(&prepared.draft),"replayed":true}));
    }
    let mut lease = lease.expect("Newly reserved generation owns a cleanup lease.");
    let frozen = prepared.draft.clone();
    if let Some(preserved) = store(&database, move |store| {
        drafts::finish_preserved(store, &frozen)
    })
    .await?
    {
        lease.finished = true;
        return Ok(json!({"draft":stage_draft(&preserved),"replayed":false}));
    }
    let outcome = drive_model(bridge, &prepared.draft, |identity, observation| {
        if let Some(identity) = identity {
            lease.identity = identity;
        }
        lease.observation = observation;
    })
    .await;
    let draft = prepared.draft;
    let identity = lease.identity.clone();
    let completed = store(&database, move |store| {
        drafts::finish_runtime(store, &draft, &identity, outcome)
    })
    .await?;
    lease.finished = true;
    Ok(json!({"draft":stage_draft(&completed),"replayed":false}))
}
pub(crate) async fn drive_model(
    bridge: &Bridge,
    draft: &Value,
    mut observe: impl FnMut(Option<Value>, Observation) + Send,
) -> std::result::Result<StreamOutcome, StreamFailure> {
    let mut stream = RuntimeStream::default();
    let opened = match bridge
        .call(
            "model.open",
            json!({"request":drafts::frozen_runtime_request(draft)}),
        )
        .await
    {
        Ok(opened) => opened,
        Err(_) => return Err(stream.transport_failure()),
    };
    observe(Some(opened["identity"].clone()), stream.observation());
    loop {
        match bridge
            .call("model.next", json!({"streamId":opened["streamId"]}))
            .await
        {
            Ok(next) if next["done"] == true => return stream.finish(),
            Ok(next) if next["done"] == false => {
                stream.push(&next["event"])?;
                observe(None, stream.observation());
            }
            Ok(_) => {
                return Err(StreamFailure {
                    code: FailureCode::InvalidStream,
                    observation: stream.observation(),
                });
            }
            Err(_) => {
                return Err(StreamFailure {
                    code: FailureCode::RuntimeFailure,
                    observation: stream.observation(),
                });
            }
        }
    }
}
fn revision_command(body: &Map<String, Value>, original: &Value) -> EngineResult<Command> {
    if body
        .get("draftingPolicy")
        .is_some_and(|policy| policy != KNOWLEDGE_POLICY)
    {
        return Err(invalid("Unsupported revision drafting policy."));
    }
    let knowledge = body
        .get("draftingPolicy")
        .is_some_and(|p| p == KNOWLEDGE_POLICY)
        || original["routing"]["version"].as_f64() == Some(3.0);
    let complete = body.contains_key("completeWhisper");
    if knowledge && !complete {
        return Err(invalid(
            "Actor knowledge revisions require completeWhisper.",
        ));
    }
    if complete && (!body["completeWhisper"].is_string() || body.contains_key("correction")) {
        return Err(invalid(
            "Supply a completeWhisper without an additive correction.",
        ));
    }
    let audience = if complete && body.get("audience").is_some_and(Value::is_null) {
        None
    } else {
        Some(strings(body, "audience", true)?)
    };
    let correction = if complete {
        "".into()
    } else {
        body.get("correction")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("correction must be text."))?
            .to_owned()
    };
    if body.get("preservedText").is_some_and(|v| !v.is_string()) {
        return Err(invalid("preservedText must be text."));
    }
    let basis_audience =
        audience
            .clone()
            .unwrap_or(if original["routing"]["initialAudience"].is_null() {
                vec![]
            } else {
                commands::strings(&original["routing"], "initialAudience")?
            });
    let mut command = drafts::captured_command(original, &required(body, "commandId")?)?;
    command.payload["audience"] = json!(basis_audience);
    if knowledge {
        command.payload["promptPolicy"] = json!({"id":KNOWLEDGE_POLICY,"version":"v1"});
    }
    let mut routing = json!({"version":if knowledge {3} else if complete {2} else {1},"initialAudience":original["routing"]["initialAudience"],"correctedAudience":audience,"correction":correction,"sourceDraftId":original["id"],"preservedText":body.get("preservedText").cloned().unwrap_or(Value::Null)});
    if complete {
        routing["completeWhisper"] = body["completeWhisper"].clone();
    }
    command.payload["routing"] = routing;
    Ok(command)
}
async fn accept(operation: Operation, database: &str) -> Result<Value, HostError> {
    let body = &operation.body;
    if body
        .keys()
        .any(|key| !["commandId", "finalText"].contains(&key.as_str()))
    {
        return Err(invalid("Acceptance cannot change candidate routing.").into());
    }
    let simulation = operation
        .simulation_id
        .ok_or_else(|| invalid("simulationId is required."))?;
    let request = AcceptRequest {
        owner_scope: "local".into(),
        simulation_id: simulation.clone(),
        draft_id: operation
            .resource_id
            .ok_or_else(|| invalid("draftId is required."))?,
        command_id: required(body, "commandId")?,
        final_text: body
            .get("finalText")
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| invalid("finalText must be a string."))
            })
            .transpose()?,
    };
    let result = store(database, move |store| {
        if store.simulation("local", &request.simulation_id)?.is_none() {
            return Err(EngineError {
                code: ErrorCode::NotFound,
                message: format!("Simulation not found: {}", request.simulation_id),
            });
        }
        accept_actor_draft(store, request)
    })
    .await?;
    Ok(
        json!({"branch":{"id":result.branch.id,"headCommitId":result.branch.head_commit_id},"commit":{"id":result.commit.id},"replayed":result.replayed}),
    )
}
struct GenerationLease {
    bridge: Bridge,
    database: String,
    draft: Value,
    identity: Value,
    observation: Observation,
    finished: bool,
}
impl Drop for GenerationLease {
    fn drop(&mut self) {
        let id = format!(
            "cleanup-{}",
            self.bridge.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let _ = crate::publish(
            json!({"callId":id,"method":"model.close","params":{"draftId":self.draft["id"]}}),
        );
        if !self.finished {
            let database = self.database.clone();
            let draft = self.draft.clone();
            let identity = self.identity.clone();
            let mut observation = self.observation.clone();
            observation.stop_reason = Some(StopReason::Aborted);
            tokio::task::spawn_blocking(move || {
                if let Ok(mut store) = Store::open(Path::new(&database)) {
                    let _ = drafts::finish_runtime(
                        &mut store,
                        &draft,
                        &identity,
                        Err(StreamFailure {
                            code: FailureCode::RuntimeFailure,
                            observation,
                        }),
                    );
                }
            });
        }
    }
}
