//! Historical selection and recovery projections use accepted receipts. Their
//! operational records are application state, not another simulation branch.
use crate::{
    archive::{SimulationArchive, historical, recorded},
    error::{EngineError, Result},
    identity::{domain_id, fingerprint},
    ports::SimulationReader,
    projection::string,
};
use serde_json::{Value, json};
pub mod view;

pub struct PreparedAlternative {
    pub operation: Value,
    pub replayed: bool,
    pub retry_source: Option<Value>,
}
fn invalid(message: &str) -> EngineError {
    EngineError::invalid(message)
}
pub fn select_live(
    reader: &impl crate::ports::AlternativeReader,
    request: &Value,
    guard: bool,
) -> Result<historical::Selection> {
    let owner = string(request, "ownerScope")?;
    let simulation = string(request, "simulationId")?;
    let branch = reader
        .branch(owner, simulation, string(request, "sourceBranchId")?)?
        .ok_or_else(|| EngineError {
            code: crate::error::ErrorCode::NotFound,
            message: "Historical source not found.".into(),
        })?;
    if guard && branch.head_commit_id != string(request, "expectedHead")? {
        return Err(EngineError::branch_conflict(
            string(request, "expectedHead")?,
            &branch.head_commit_id,
        ));
    }
    historical::select(&reader.export_archive(owner, simulation)?, request)
}
pub fn assert_supported_effects(commit: &crate::model::Commit) -> Result<()> {
    if commit.events.iter().any(|e| {
        !matches!(
            e["type"].as_str(),
            Some("message_accepted" | "first_impression_formed" | "stage_whisper_consumed")
        )
    }) {
        return Err(invalid(
            "Historical replacement of explicit world/access/audience changes is unsupported pending policy.",
        ));
    }
    Ok(())
}
pub fn prepare_alternative(
    repository: &mut impl crate::ports::SavedAlternativeRepository,
    request: Value,
    configured: bool,
) -> Result<PreparedAlternative> {
    recorded::alternative_request(&request)?;
    let id = id(&request)?;
    let hash = fingerprint(&request);
    let owner = string(&request, "ownerScope")?;
    let sim = string(&request, "simulationId")?;
    if let Some(existing) = repository.alternative(owner, sim, &id)? {
        if existing["fingerprint"] != hash {
            return Err(EngineError::command_conflict(string(
                &request,
                "commandId",
            )?));
        }
        return Ok(PreparedAlternative {
            operation: existing,
            replayed: true,
            retry_source: None,
        });
    }
    let selected = select_live(repository, &request, true)?;
    assert_supported_effects(&selected.commit)?;
    let simulation = repository
        .simulation(owner, sim)?
        .ok_or_else(|| invalid("Historical simulation is missing."))?;
    let origin = historical::originating_input(&repository.export_archive(owner, sim)?, &request)?;
    let actor = request
        .get("replacementActorId")
        .unwrap_or(&request["actorId"]);
    let complete = if request["action"] == "manual" {
        Value::Null
    } else {
        request.get("completeWhisper").cloned().unwrap_or_else(|| {
            if actor == &request["actorId"] {
                origin["completeWhisper"].clone()
            } else {
                Value::Null
            }
        })
    };
    if request["action"] == "generate" && complete.is_null() {
        return Err(invalid(
            "Origin requires an explicit complete replacement whisper (empty is permitted).",
        ));
    }
    let retry_source = if let Some(retry) = request.get("retryOf") {
        let source = repository
            .alternative(owner, sim, retry.as_str().unwrap())?
            .ok_or_else(|| invalid("Retry requires failed or discarded historical work."))?;
        if source["request"]["action"] != "generate"
            || !matches!(source["status"].as_str(), Some("failed" | "discarded"))
        {
            return Err(invalid(
                "Retry requires failed or discarded historical work.",
            ));
        }
        let strip = |value: &Value| {
            let mut v = value.clone();
            let object = v.as_object_mut().unwrap();
            object.remove("commandId");
            object.remove("retryOf");
            v
        };
        if fingerprint(&strip(&source["request"])) != fingerprint(&strip(&request))
            || source["completeWhisper"] != complete
        {
            return Err(invalid("Retry must repeat the frozen historical request."));
        }
        Some(source)
    } else {
        None
    };
    if request["action"] == "generate" && !configured {
        return Err(invalid("No actor-turn runtime configured."));
    }
    let created = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let (operation,replayed)=repository.reserve_alternative(json!({"id":id,"request":request,"fingerprint":hash,"parentCommitId":selected.parent,"contentRevisionId":simulation.content_revision_id,"completeWhisper":complete,"origin":origin,"status":"pending","failure":null,"draft":null,"outcome":null,"createdAt":created,"updatedAt":created}))?;
    Ok(PreparedAlternative {
        operation,
        replayed,
        retry_source,
    })
}
pub fn generation_command(operation: &Value) -> Result<crate::model::Command> {
    let r = &operation["request"];
    let actor = r
        .get("replacementActorId")
        .unwrap_or(&r["actorId"])
        .as_str()
        .ok_or_else(|| invalid("Historical actor is missing."))?;
    let audience = if r["audience"].is_null() {
        Vec::new()
    } else {
        crate::commands::strings(r, "audience")?
    };
    let mut routing = json!({"version":4,"completeWhisper":operation["completeWhisper"],"initialAudience":null,"correctedAudience":r["audience"],"correction":"","preservedText":null,"sourceDraftId":null});
    if let Some(limit) = r.get("audienceLimit") {
        routing["audienceLimit"] = limit.clone();
    }
    Ok(crate::model::Command {
        owner_scope: string(r, "ownerScope")?.into(),
        simulation_id: string(r, "simulationId")?.into(),
        branch_id: string(r, "sourceBranchId")?.into(),
        expected_head: string(operation, "parentCommitId")?.into(),
        command_id: domain_id("alternative_generation", &[string(operation, "id")?]),
        payload: json!({"actorId":actor,"audience":crate::commands::normalize_audience(actor,&audience),"stageWhisperIds":[],"runtimeProfile":r.get("actorProfile").cloned().unwrap_or_else(||json!({"id":"local-character","version":"v1"})),"promptPolicy":{"id":"actor-knowledge-v1","version":"v1"},"outputSchema":{"id":"audience-proposal","digest":"v1"},"skillDigests":[],"routing":routing}),
    })
}
pub fn finish_alternative(
    repository: &mut impl crate::ports::SavedAlternativeRepository,
    owner: &str,
    simulation: &str,
    id: &str,
) -> Result<Value> {
    let current = repository
        .alternative(owner, simulation, id)?
        .ok_or_else(|| invalid("Historical operation is missing."))?;
    if current["status"] != "pending" {
        return Ok(current);
    }
    if current["request"]["action"] == "generate"
        && (current["draft"]["status"] != "ready"
            || current["draft"]["artifact"]["provenance"]["stopReason"] == "length")
    {
        return repository.settle_alternative(
            owner,
            simulation,
            id,
            "failed",
            Some("generation_failed"),
        );
    }
    match repository.save_alternative(owner, simulation, id) {
        Ok(saved) => Ok(saved),
        Err(_) => repository.settle_alternative(
            owner,
            simulation,
            id,
            "failed",
            Some("validation_failed"),
        ),
    }
}
pub fn build_alternative_commit(
    repository: &impl crate::ports::SavedAlternativeRepository,
    operation: &Value,
) -> Result<(Value, crate::model::Commit, crate::model::Branch)> {
    use crate::{
        acceptance, commands,
        model::{AcceptRequest, Branch, BranchOrigin, Command},
    };
    let r = &operation["request"];
    let actor = r.get("replacementActorId").unwrap_or(&r["actorId"]);
    let selected = select_live(repository, r, true)?;
    assert_supported_effects(&selected.commit)?;
    if operation["parentCommitId"] != selected.parent {
        return Err(invalid("Historical parent mismatch."));
    }
    let owner = string(r, "ownerScope")?;
    let simulation = string(r, "simulationId")?;
    let command_id = string(r, "commandId")?;
    let source = string(r, "sourceBranchId")?;
    let created = string(operation, "createdAt")?;
    let mut generated = Value::Null;
    let mut commit = if r["action"] == "generate" {
        let draft = &operation["draft"];
        if draft["branchId"] != source
            || draft["basisHeadCommitId"] != operation["parentCommitId"]
            || draft["ownerScope"] != owner
            || draft["simulationId"] != simulation
            || &draft["actorId"] != actor
        {
            return Err(invalid("Historical candidate basis mismatch."));
        }
        let context = view::HistoricalContext {
            repository,
            operation,
        };
        let validated = acceptance::validate_ready_draft(
            &context,
            &AcceptRequest {
                owner_scope: owner.into(),
                simulation_id: simulation.into(),
                draft_id: string(draft, "id")?.into(),
                command_id: command_id.into(),
                final_text: None,
            },
            draft,
        )?;
        generated = acceptance::receipt_for(&validated.draft, &validated.accepted_text)?;
        let mut commit = acceptance::build_accepted_commit(
            &context,
            owner,
            simulation,
            source,
            &selected.parent,
            &generated,
            command_id,
            created,
        )?;
        commit.events[0]["message"]["logicalMessageId"] = r["logicalMessageId"].clone();
        commit.events[0]["message"]["provenance"]["operation"] = json!("regenerate");
        commit.events.push(json!({"type":"stage_whisper_consumed","whisperId":domain_id("alternative_input",&[string(operation,"id")?]),"targetActorId":actor,"text":operation["completeWhisper"]}));
        commit
    } else {
        let mut payload = json!({"actorId":actor,"text":r["manualText"],"audience":r["audience"],"stageWhisperIds":[],"knowledgePolicy":"actor-knowledge-v1"});
        if let Some(syntax) = r.get("audienceSyntax") {
            payload["audienceSyntax"] = syntax.clone();
        }
        commands::build_historical_commit(
            repository,
            &Command {
                owner_scope: owner.into(),
                simulation_id: simulation.into(),
                branch_id: source.into(),
                expected_head: selected.parent.clone(),
                command_id: command_id.into(),
                payload,
            },
            string(r, "logicalMessageId")?,
            "edit",
        )?
    };
    commit.created_at = created.into();
    let retry = if let Some(id) = r.get("retryOf") {
        repository.alternative(owner, simulation, id.as_str().unwrap())?
    } else {
        None
    };
    let branch_id = domain_id("alternative_branch", &[owner, simulation, command_id]);
    let recorded = json!({"kind":"saved_alternative","ownerScope":owner,"simulationId":simulation,"commandId":command_id,"branchId":branch_id,"sourceBranchId":source,"expectedHead":r["expectedHead"],"sourceCommitId":r["sourceCommitId"],"payload":{"version":1,"request":r,"parentCommitId":operation["parentCommitId"],"contentRevisionId":operation["contentRevisionId"],"completeWhisper":operation["completeWhisper"],"origin":operation["origin"],"generated":generated,"retrySource":retry.map(|retry|json!({"request":retry["request"],"promptHash":retry["draft"]["promptHash"],"contextHash":retry["draft"]["contextHash"]}))}});
    recorded::command(&recorded)?;
    if fingerprint(&operation["origin"])
        != fingerprint(&historical::originating_input(
            &repository.export_archive(owner, simulation)?,
            r,
        )?)
    {
        return Err(invalid("Historical origin changed."));
    }
    let kind = if r["action"] == "manual" {
        "edit"
    } else {
        "regenerate"
    };
    let origin = if kind == "edit" {
        BranchOrigin::Edit {
            command_id: command_id.into(),
            source_branch_id: source.into(),
            source_head_commit_id: string(r, "expectedHead")?.into(),
            base_commit_id: selected.parent,
        }
    } else {
        BranchOrigin::Regenerate {
            command_id: command_id.into(),
            source_branch_id: source.into(),
            source_head_commit_id: string(r, "expectedHead")?.into(),
            base_commit_id: selected.parent,
        }
    };
    let branch = Branch {
        id: branch_id,
        owner_scope: owner.into(),
        simulation_id: simulation.into(),
        name: Some(kind.into()),
        head_commit_id: commit.id.clone(),
        origin,
        created_at: created.into(),
    };
    Ok((recorded, commit, branch))
}

pub fn id(request: &Value) -> Result<String> {
    Ok(domain_id(
        "saved_alternative",
        &[
            string(request, "ownerScope")?,
            string(request, "simulationId")?,
            string(request, "commandId")?,
        ],
    ))
}
pub fn from_receipt(command: &Value, branch: &Value, commit: &Value) -> Result<Value> {
    recorded::command(command)?;
    let p = &command["payload"];
    let request = &p["request"];
    Ok(
        json!({"id":id(request)?,"request":request,"fingerprint":fingerprint(request),"parentCommitId":p["parentCommitId"],"contentRevisionId":p["contentRevisionId"],"completeWhisper":p["completeWhisper"],"origin":p["origin"],"status":"saved","failure":null,"draft":null,"outcome":{"branchId":branch["id"],"commitId":commit["id"]},"createdAt":commit["createdAt"],"updatedAt":commit["createdAt"]}),
    )
}
pub fn summary(operation: &Value) -> Value {
    let r = &operation["request"];
    json!({"id":operation["id"],"commandId":r["commandId"],"sourceBranchId":r["sourceBranchId"],"expectedHead":r["expectedHead"],"sourceCommitId":r["sourceCommitId"],"messageVersionId":r["messageVersionId"],"logicalMessageId":r["logicalMessageId"],"actorId":r["actorId"],"action":r["action"],"retryOf":r["retryOf"],"parentCommitId":operation["parentCommitId"],"status":operation["status"],"failure":operation["failure"],"outcome":operation["outcome"],"createdAt":operation["createdAt"],"updatedAt":operation["updatedAt"]})
}
pub fn detail(
    reader: &impl SimulationReader,
    archive: &SimulationArchive,
    operation: &Value,
) -> Result<Value> {
    let request = &operation["request"];
    let message = if !operation["outcome"].is_null() {
        reader
            .commit(
                string(request, "ownerScope")?,
                string(request, "simulationId")?,
                string(&operation["outcome"], "commitId")?,
            )?
            .and_then(|c| {
                c.events
                    .into_iter()
                    .find(|e| e["type"] == "message_accepted")
            })
            .map(|e| e["message"].clone())
    } else {
        None
    };
    let receipt = if !operation["outcome"].is_null() {
        archive
            .command_results
            .iter()
            .find(|c| {
                c.command_id == request["commandId"]
                    && c.canonical_input["kind"] == "saved_alternative"
            })
            .map(|c| &c.canonical_input)
    } else {
        None
    };
    let artifact = operation["draft"]
        .get("artifact")
        .filter(|a| !a.is_null())
        .or_else(|| {
            receipt
                .map(|r| &r["payload"]["generated"]["generatedArtifact"])
                .filter(|a| !a.is_null())
        });
    let text = message
        .as_ref()
        .map(|m| &m["text"])
        .or_else(|| artifact.map(|a| &a["text"]))
        .unwrap_or(&request["manualText"]);
    let audience = message
        .as_ref()
        .map(|m| &m["audience"])
        .or_else(|| {
            artifact
                .map(|a| &a["proposedAudience"])
                .filter(|a| !a.is_null())
        })
        .unwrap_or(&request["audience"]);
    let mut result = summary(operation);
    result["review"] = json!({"completeWhisper":operation["completeWhisper"],"text":text,"audience":audience,"attribution":if request["action"]=="manual" {"manual"} else {"generated"},"runtime":artifact.map(|a|json!({"adapter":a["provenance"]["adapter"],"providerId":a["provenance"]["providerId"],"modelId":a["provenance"]["modelId"]}))});
    Ok(result)
}
pub fn discover(
    archive: &SimulationArchive,
    operations: Vec<Value>,
    selection: &Value,
) -> Result<Value> {
    let selected = historical::select(archive, selection)?;
    let reader = crate::archive::ArchiveReader::new(archive);
    let sim = &archive.simulation;
    let operations = operations
        .into_iter()
        .filter(|o| {
            o["parentCommitId"] == selected.parent
                && o["request"]["logicalMessageId"] == selection["logicalMessageId"]
        })
        .map(|o| summary(&o))
        .collect::<Vec<_>>();
    let mut paths = Vec::new();
    for branch in &archive.branches {
        let replacement = reader
            .ancestry(&sim.owner_scope, &sim.id, &branch.head_commit_id)?
            .into_iter()
            .find(|c| {
                c.parent_commit_id.as_deref() == Some(&selected.parent)
                    && c.events.iter().any(|e| {
                        e["type"] == "message_accepted"
                            && e["message"]["logicalMessageId"] == selection["logicalMessageId"]
                    })
            });
        if let Some(commit) = replacement {
            let message = commit
                .events
                .iter()
                .find(|e| e["type"] == "message_accepted")
                .ok_or_else(|| {
                    EngineError::invalid("Historical replacement message is missing.")
                })?;
            let m = &message["message"];
            paths.push(json!({"branchId":branch.id,"headCommitId":branch.head_commit_id,"commitId":commit.id,"messageVersionId":m["id"],"logicalMessageId":m["logicalMessageId"],"actorId":m["actorId"],"text":m["text"],"audience":m["audience"]}));
        }
    }
    Ok(json!({"parentCommitId":selected.parent,"operations":operations,"paths":paths}))
}
