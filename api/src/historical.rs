use crate::{
    Bridge, HostError,
    generation::{describe, drive_model, reject_runtime_selection, store as work},
};
use crate::{native::required, routes::Operation};
use doxvelt_engine::{
    alternatives::{self, view::HistoricalDraftRepository},
    archive::historical,
    drafts::{self, PrepareOptions},
    error::{EngineError, ErrorCode, Result},
    projection::string,
    runtime::{FailureCode, Observation, StopReason, StreamFailure},
    storage::Store,
};
use serde_json::{Map, Value, json};
use std::{path::Path, sync::atomic::Ordering};

pub fn handles(operation: &str) -> bool {
    [
        "alternative.origin",
        "alternative.list",
        "alternative.read",
        "alternative.discard",
    ]
    .contains(&operation)
}
fn selection(store: &Store, sim: &str, fields: &Map<String, Value>) -> Result<Value> {
    let mut request = json!({"ownerScope":"local","simulationId":sim});
    for key in [
        "sourceBranchId",
        "expectedHead",
        "sourceCommitId",
        "messageVersionId",
        "logicalMessageId",
        "actorId",
    ] {
        request[key] = json!(required(fields, key)?);
    }
    if store
        .branch("local", sim, request["sourceBranchId"].as_str().unwrap())?
        .is_none()
    {
        return Err(EngineError {
            code: ErrorCode::NotFound,
            message: "Historical source not found.".into(),
        });
    }
    Ok(request)
}
pub fn execute(operation: Operation, store: &mut Store) -> Result<Value> {
    let sim = operation
        .simulation_id
        .as_deref()
        .ok_or_else(|| EngineError::invalid("simulationId is required."))?;
    if store.simulation("local", sim)?.is_none() {
        return Err(EngineError {
            code: ErrorCode::NotFound,
            message: format!("Simulation not found: {sim}"),
        });
    }
    if operation.operation == "alternative.origin" {
        if operation.body.keys().any(|key| {
            ![
                "sourceBranchId",
                "expectedHead",
                "sourceCommitId",
                "messageVersionId",
                "logicalMessageId",
                "actorId",
            ]
            .contains(&key.as_str())
        }) {
            return Err(EngineError::invalid(
                "Unknown originating-input query field.",
            ));
        }
        let request = selection(store, sim, &operation.body)?;
        return historical::originating_input(&store.export_simulation("local", sim)?, &request);
    }
    if operation.operation == "alternative.list" {
        let records = store.alternatives("local", sim)?;
        if !operation.query.contains_key("sourceCommitId") {
            return Ok(
                json!({"operations":records.iter().map(alternatives::summary).collect::<Vec<_>>()}),
            );
        }
        let fields = operation
            .query
            .iter()
            .map(|(key, value)| (key.clone(), json!(value)))
            .collect();
        let request = selection(store, sim, &fields)?;
        return alternatives::discover(&store.export_simulation("local", sim)?, records, &request);
    }
    let id = operation
        .resource_id
        .as_deref()
        .ok_or_else(|| EngineError::invalid("alternativeId is required."))?;
    let mut record = store
        .alternative("local", sim, id)?
        .ok_or_else(|| EngineError {
            code: ErrorCode::NotFound,
            message: "Historical operation not found.".into(),
        })?;
    if operation.operation == "alternative.discard" {
        if !operation.body.is_empty() {
            return Err(EngineError::invalid(
                "Discard is idempotent by operation identity and accepts an empty body.",
            ));
        }
        record = store.settle_alternative("local", sim, id, "discarded", None)?;
    }
    alternatives::detail(store, &store.export_simulation("local", sim)?, &record)
}

fn reply(store: &Store, operation: &Value, replayed: bool) -> Result<Value> {
    let r = &operation["request"];
    let archive = store.export_simulation(string(r, "ownerScope")?, string(r, "simulationId")?)?;
    Ok(json!({"operation":alternatives::detail(store,&archive,operation)?,"replayed":replayed}))
}
pub async fn generate(
    bridge: &Bridge,
    operation: Operation,
    database: &str,
) -> std::result::Result<Value, HostError> {
    let sim = operation
        .simulation_id
        .ok_or_else(|| EngineError::invalid("simulationId is required."))?;
    let simulation = sim.clone();
    work(database, move |store| {
        if store.simulation("local", &simulation)?.is_none() {
            return Err(EngineError {
                code: ErrorCode::NotFound,
                message: format!("Simulation not found: {simulation}"),
            });
        }
        Ok(())
    })
    .await?;
    let body = operation.body;
    let mut request = if operation.operation == "alternative.retry" {
        if body.keys().any(|key| key != "commandId") {
            return Err(EngineError::invalid("Historical retry accepts only commandId.").into());
        }
        let id = operation
            .resource_id
            .ok_or_else(|| EngineError::invalid("alternativeId is required."))?;
        let simulation = sim.clone();
        let original = work(database, move |store| {
            store
                .alternative("local", &simulation, &id)?
                .ok_or_else(|| EngineError {
                    code: ErrorCode::NotFound,
                    message: "Historical operation not found.".into(),
                })
        })
        .await?;
        let mut request = original["request"].clone();
        request["commandId"] = json!(required(&body, "commandId")?);
        request["retryOf"] = original["id"].clone();
        request
    } else {
        reject_runtime_selection(&body)?;
        let mut request = Value::Object(body.clone());
        request
            .as_object_mut()
            .unwrap()
            .remove("actorConfiguration");
        request["ownerScope"] = json!("local");
        request["simulationId"] = json!(sim);
        request
    };
    let generated = request["action"] == "generate";
    if !generated && request["action"] != "manual" {
        return Err(EngineError::invalid("Invalid historical action.").into());
    }
    let configuration = if body.contains_key("actorConfiguration") {
        Some(json!(required(&body, "actorConfiguration")?))
    } else {
        None
    };
    if configuration.is_some() && !generated {
        return Err(EngineError::invalid("Only an actor uses a model configuration.").into());
    }
    let actor = request
        .get("replacementActorId")
        .unwrap_or(&request["actorId"])
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| EngineError::invalid("actorId must be a non-empty string."))?
        .to_owned();
    let description = if generated {
        describe(
            bridge,
            &actor,
            configuration,
            if operation.operation == "alternative.retry" {
                request.get("actorProfile")
            } else {
                None
            },
        )
        .await?
    } else {
        json!({"configured":false,"memoryEnabled":false})
    };
    if generated && operation.operation == "alternative.create" {
        let default = description["defaultProfile"]
            .as_bool()
            .unwrap_or(description["profile"] == json!({"id":"local-character","version":"v1"}));
        if !default {
            request["actorProfile"] = description["profile"].clone();
        }
    }
    let configured = description["configured"] == true;
    let prepared = work(database, move |store| {
        alternatives::prepare_alternative(store, request, configured)
    })
    .await?;
    if prepared.replayed {
        return work(database, move |store| {
            reply(store, &prepared.operation, true)
        })
        .await;
    }
    let mut lease = HistoricalLease {
        bridge: bridge.clone(),
        database: database.into(),
        operation: prepared.operation.clone(),
        draft: None,
        identity: json!({}),
        observation: Observation::default(),
        finished: false,
    };
    let execution: std::result::Result<(), HostError> = async {
        if !generated {
            return Ok(());
        }
        let recall = if let Some(source) = &prepared.retry_source
            && !source["draft"].is_null()
        {
            doxvelt_engine::routing::captured_episode_recall(&source["draft"]["context"])?
        } else if description["memoryEnabled"] == true {
            let r = &prepared.operation["request"];
            Some(
                crate::episode_api::recall(
                    bridge,
                    database,
                    doxvelt_engine::episode_memory::EpisodeQuery {
                        owner_scope: "local".into(),
                        simulation_id: sim.clone(),
                        branch_id: string(r, "sourceBranchId")?.into(),
                        head: Some(string(&prepared.operation, "parentCommitId")?.into()),
                    },
                    actor.clone(),
                    string(&prepared.operation, "completeWhisper")?.into(),
                )
                .await?,
            )
        } else {
            None
        };
        let record = prepared.operation.clone();
        let draft = work(database, move |store| {
            let command = alternatives::generation_command(&record)?;
            let mut view = HistoricalDraftRepository {
                repository: store,
                operation: record,
            };
            drafts::prepare_actor_draft(
                &mut view,
                command,
                PrepareOptions {
                    episode_recall: recall.as_ref(),
                    ..Default::default()
                },
            )
        })
        .await?;
        lease.draft = Some(draft.draft.clone());
        if !draft.replayed {
            let outcome = drive_model(bridge, &draft.draft, |identity, observation| {
                if let Some(identity) = identity {
                    lease.identity = identity;
                }
                lease.observation = observation;
            })
            .await;
            let record = prepared.operation.clone();
            let identity = lease.identity.clone();
            work(database, move |store| {
                let mut view = HistoricalDraftRepository {
                    repository: store,
                    operation: record,
                };
                drafts::finish_runtime(&mut view, &draft.draft, &identity, outcome)
            })
            .await?;
        }
        Ok(())
    }
    .await;
    let record = prepared.operation;
    let result = work(database, move |store| {
        let id = string(&record, "id")?;
        let result = if execution.is_err() {
            store.settle_alternative("local", &sim, id, "failed", Some("validation_failed"))?
        } else {
            alternatives::finish_alternative(store, "local", &sim, id)?
        };
        reply(store, &result, false)
    })
    .await;
    lease.finished = true;
    result
}
struct HistoricalLease {
    bridge: Bridge,
    database: String,
    operation: Value,
    draft: Option<Value>,
    identity: Value,
    observation: Observation,
    finished: bool,
}
impl Drop for HistoricalLease {
    fn drop(&mut self) {
        if let Some(draft) = &self.draft {
            let id = format!(
                "cleanup-{}",
                self.bridge.sequence.fetch_add(1, Ordering::Relaxed)
            );
            let _ = crate::publish(
                json!({"callId":id,"method":"model.close","params":{"draftId":draft["id"]}}),
            );
        }
        if !self.finished {
            let database = self.database.clone();
            let operation = self.operation.clone();
            let identity = self.identity.clone();
            let mut observation = self.observation.clone();
            observation.stop_reason = Some(StopReason::Aborted);
            tokio::task::spawn_blocking(move || {
                let r = &operation["request"];
                let Some(sim) = r["simulationId"].as_str() else {
                    return;
                };
                let Some(id) = operation["id"].as_str() else {
                    return;
                };
                let Ok(mut store) = Store::open(Path::new(&database)) else {
                    return;
                };
                let Ok(Some(current)) = store.alternative("local", sim, id) else {
                    return;
                };
                if current["status"] != "pending" {
                    return;
                }
                let failure = if !current["draft"].is_null() {
                    let draft = current["draft"].clone();
                    let mut view = HistoricalDraftRepository {
                        repository: &mut store,
                        operation: current,
                    };
                    let _ = drafts::finish_runtime(
                        &mut view,
                        &draft,
                        &identity,
                        Err(StreamFailure {
                            code: FailureCode::RuntimeFailure,
                            observation,
                        }),
                    );
                    "generation_failed"
                } else {
                    "validation_failed"
                };
                let _ = store.settle_alternative("local", sim, id, "failed", Some(failure));
            });
        }
    }
}
