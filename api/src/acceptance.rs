//! Acceptance reprojects frozen input and stages one atomic generated turn.
use crate::{
    commands::{first_impression_events, normalize_audience, strings},
    context::{ContextOptions, inspect_actor_context},
    contracts::runtime_text,
    draft_contracts,
    drafts::captured_command,
    error::{EngineError, ErrorCode, Result},
    identity::{domain_id, fingerprint, sha256},
    model::{AcceptRequest, Command, Commit, Committed},
    ports::{ActorDraftRepository, SimulationReader},
    projection::{array, project_branch, string},
    routing::{
        captured_episode_recall, final_draft_audience, prepare_routing, project_routing_context,
    },
    runtime::canonical_context,
};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};

pub struct ValidatedDraft {
    pub draft: Value,
    pub accepted_text: String,
    pub whispers: Vec<Value>,
}
fn missing(label: &str, id: &str) -> EngineError {
    EngineError {
        code: ErrorCode::NotFound,
        message: format!("{label} not found: {id}"),
    }
}
pub fn accept_actor_draft(
    repository: &mut impl ActorDraftRepository,
    request: AcceptRequest,
) -> Result<Committed> {
    if let Some(prior) = repository.replay_accepted_draft(&request)? {
        return Ok(prior);
    }
    let preflight = (|| {
        let draft = repository
            .actor_draft(
                &request.owner_scope,
                &request.simulation_id,
                &request.draft_id,
            )?
            .ok_or_else(|| missing("Draft", &request.draft_id))?;
        validate_ready_draft(repository, &request, &draft)
    })();
    let validated = match preflight {
        Ok(ready) => ready,
        Err(error) => {
            if let Some(prior) = repository.replay_accepted_draft(&request)? {
                return Ok(prior);
            }
            return Err(error);
        }
    };
    let recorded = recorded_acceptance(&request, &validated)?;
    repository.commit_accepted_draft(
        &request,
        &recorded,
        &Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    )
}
pub fn accepted_text(receipt: &Value) -> Result<&str> {
    if receipt["accepted"]["textSource"] == "acceptor_edited" {
        string(&receipt["accepted"], "text")
    } else {
        string(&receipt["generatedArtifact"], "text")
    }
}
pub fn receipt_for(draft: &Value, text: &str) -> Result<Value> {
    let artifact = &draft["artifact"];
    if artifact.is_null() {
        return Err(EngineError::invalid(
            "Ready draft has no generated artifact.",
        ));
    }
    let mut receipt = json!({"receiptVersion":if draft.get("routing").is_some() {2} else {1},"draftId":draft["id"],"generationCommandId":draft["generationCommandId"],"contentRevisionId":draft["contentRevisionId"],
        "actorId":draft["actorId"],"audience":final_draft_audience(draft),"stageWhispers":draft["stageWhispers"],"runtimeProfile":draft["runtimeProfile"],"promptPolicy":draft["promptPolicy"],"outputSchema":draft["outputSchema"],"skillDigests":draft["skillDigests"],"capabilityGrant":[],"contextHash":draft["contextHash"],"promptHash":draft["promptHash"],"generatedArtifact":artifact,
        "accepted":if artifact["text"]==text {json!({"textSource":if !draft["routing"]["preservedText"].is_null() {"director_preserved"} else {"generated_verbatim"}})} else {json!({"textSource":"acceptor_edited","text":text})}});
    if let Some(routing) = draft.get("routing") {
        receipt["routing"] = routing.clone();
    }
    draft_contracts::accept_receipt(&receipt)?;
    Ok(receipt)
}
pub fn recorded_acceptance(request: &AcceptRequest, validated: &ValidatedDraft) -> Result<Value> {
    let command = Command {
        owner_scope: request.owner_scope.clone(),
        simulation_id: request.simulation_id.clone(),
        branch_id: string(&validated.draft, "branchId")?.into(),
        expected_head: string(&validated.draft, "basisHeadCommitId")?.into(),
        command_id: request.command_id.clone(),
        payload: receipt_for(&validated.draft, &validated.accepted_text)?,
    };
    let mut value = serde_json::to_value(command).unwrap();
    value["kind"] = json!("accept_draft");
    Ok(value)
}
pub fn validate_ready_draft(
    reader: &impl SimulationReader,
    request: &AcceptRequest,
    draft: &Value,
) -> Result<ValidatedDraft> {
    draft_contracts::draft_record(draft)?;
    if draft["ownerScope"] != request.owner_scope
        || draft["simulationId"] != request.simulation_id
        || draft["id"] != request.draft_id
    {
        return Err(EngineError::invalid(
            "Draft identity does not match acceptance request.",
        ));
    }
    if draft["status"] != "ready" {
        return Err(EngineError::invalid(format!(
            "Draft is not ready: {}",
            request.draft_id
        )));
    }
    let artifact = &draft["artifact"];
    draft_contracts::completed_artifact(artifact)?;
    if !draft["failure"].is_null() {
        return Err(EngineError::invalid(
            "Ready draft artifact state is invalid.",
        ));
    }
    let wording = request
        .final_text
        .as_deref()
        .unwrap_or(string(artifact, "text")?);
    runtime_text(wording, "Accepted text")?;
    if fingerprint(&draft["runtimeProfile"])
        != fingerprint(&artifact["provenance"]["runtimeProfile"])
    {
        return Err(EngineError::invalid(
            "Draft runtime profile provenance is invalid.",
        ));
    }
    let actor = string(draft, "actorId")?;
    let audience = strings(draft, "audience")?;
    if normalize_audience(actor, &audience) != audience {
        return Err(EngineError::invalid("Draft audience is not normalized."));
    }
    let simulation = reader
        .simulation(&request.owner_scope, &request.simulation_id)?
        .ok_or_else(|| missing("Simulation", &request.simulation_id))?;
    if draft["contentRevisionId"] != simulation.content_revision_id {
        return Err(EngineError::invalid(
            "Draft content revision does not match simulation.",
        ));
    }
    let branch_id = string(draft, "branchId")?;
    let head = string(draft, "basisHeadCommitId")?;
    let branch = reader
        .branch(&request.owner_scope, &request.simulation_id, branch_id)?
        .ok_or_else(|| missing("Branch", branch_id))?;
    if branch.head_commit_id != head {
        return Err(EngineError::branch_conflict(head, &branch.head_commit_id));
    }
    let revision = reader
        .revision(&request.owner_scope, &simulation.content_revision_id)?
        .ok_or_else(|| missing("Content revision", &simulation.content_revision_id))?;
    for id in normalize_audience(actor, &audience) {
        if !revision
            .compiled
            .entities
            .iter()
            .any(|entity| entity.id == id && entity.kind.can_own_turn())
        {
            return Err(missing("Actor", &id));
        }
    }
    let pending = reader.pending_whispers(
        &request.owner_scope,
        &request.simulation_id,
        branch_id,
        head,
        actor,
    )?;
    let whispers = array(draft, "stageWhispers")?
        .iter()
        .map(|snapshot| {
            pending
                .iter()
                .find(|whisper| {
                    whisper["id"] == snapshot["id"]
                        && whisper["text"] == snapshot["text"]
                        && whisper["ownerScope"] == draft["ownerScope"]
                        && whisper["simulationId"] == draft["simulationId"]
                        && whisper["branchId"] == draft["branchId"]
                        && whisper["expectedHead"] == draft["basisHeadCommitId"]
                        && whisper["targetActorId"] == draft["actorId"]
                })
                .cloned()
                .ok_or_else(|| {
                    EngineError::invalid(format!(
                        "Frozen stage whisper is invalid: {}",
                        snapshot["id"].as_str().unwrap_or_default()
                    ))
                })
        })
        .collect::<Result<Vec<_>>>()?;
    let (context, prompt) = if let Some(routing) = draft.get("routing") {
        let command = captured_command(draft, string(draft, "generationCommandId")?)?;
        let recall = captured_episode_recall(&draft["context"])?;
        let source = if draft["context"].get("correctionSource").is_some() {
            routing.get("source").filter(|v| !v.is_null())
        } else {
            None
        };
        let projected =
            project_routing_context(reader, &command, &whispers, source, recall.as_ref())?;
        if fingerprint(&prepare_routing(
            reader,
            &command,
            &projected.available_recipient_ids,
        )?) != fingerprint(routing)
        {
            return Err(EngineError::invalid("Source candidate provenance changed."));
        }
        if json!(projected.available_recipient_ids) != routing["availableRecipientIds"] {
            return Err(EngineError::invalid(
                "Available recipient projection changed.",
            ));
        }
        (projected.context, projected.prompt)
    } else {
        let context = inspect_actor_context(
            reader,
            &request.owner_scope,
            &request.simulation_id,
            branch_id,
            Some(head),
            actor,
            ContextOptions {
                audience: Some(&audience),
                whispers: &whispers,
                ..Default::default()
            },
        )?;
        (
            canonical_context(&context),
            string(&context, "promptPreview")?.to_owned(),
        )
    };
    if fingerprint(&context) != draft["contextHash"]
        || fingerprint(&context) != fingerprint(&draft["context"])
    {
        return Err(EngineError::invalid("Draft context hash is invalid."));
    }
    if sha256(&prompt) != draft["promptHash"] || draft["prompt"] != prompt {
        return Err(EngineError::invalid("Draft prompt hash is invalid."));
    }
    Ok(ValidatedDraft {
        draft: draft.clone(),
        accepted_text: wording.into(),
        whispers,
    })
}
pub fn build_accepted_commit(
    reader: &impl SimulationReader,
    owner: &str,
    simulation: &str,
    branch: &str,
    head: &str,
    receipt: &Value,
    command: &str,
    created: &str,
) -> Result<Commit> {
    draft_contracts::accept_receipt(receipt)?;
    let ids = [owner, simulation, command];
    let message = json!({"id":domain_id("message_version",&ids),"logicalMessageId":domain_id("message",&ids),"actorId":receipt["actorId"],"text":accepted_text(receipt)?,"audience":receipt["audience"],
        "provenance":{"mode":"generated","operation":"turn","sourceArtifactDigest":receipt["generatedArtifact"]["digest"],"finalTextSource":receipt["accepted"]["textSource"]}});
    let mut events = vec![json!({"type":"message_accepted","message":message})];
    let projection = project_branch(reader, owner, simulation, branch, Some(head))?;
    if receipt.get("routing").is_none()
        || ![Some(3.0), Some(4.0)].contains(&receipt["routing"]["version"].as_f64())
    {
        let compiled = crate::commands::compiled(reader, owner, simulation)?;
        events.extend(first_impression_events(
            &compiled,
            &strings(receipt, "audience")?,
            &projection.first_impressions,
        ));
    }
    for whisper in array(receipt, "stageWhispers")? {
        events.push(json!({"type":"stage_whisper_consumed","whisperId":whisper["id"],"targetActorId":receipt["actorId"],"text":whisper["text"]}));
    }
    Ok(Commit {
        id: domain_id("commit", &ids),
        owner_scope: owner.into(),
        simulation_id: simulation.into(),
        parent_commit_id: Some(head.into()),
        kind: "turn".into(),
        command_id: command.into(),
        events,
        created_at: created.into(),
    })
}

/// Imported receipts carry recorded context/prompt claims. Verify their shape,
/// identities, recipients, snapshots and event derivation against accepted history.
pub fn verify_recorded_acceptance(
    reader: &impl SimulationReader,
    command: &Value,
    commit: &Commit,
) -> Result<()> {
    draft_contracts::exact(
        command,
        &[
            "kind",
            "ownerScope",
            "simulationId",
            "branchId",
            "expectedHead",
            "commandId",
            "payload",
        ],
        &[],
        "Accepted draft command",
    )?;
    if command["kind"] != "accept_draft" {
        return Err(EngineError::invalid("Expected an accepted draft command."));
    }
    let receipt = &command["payload"];
    draft_contracts::accept_receipt(receipt)?;
    let owner = string(command, "ownerScope")?;
    let simulation = string(command, "simulationId")?;
    let id = string(command, "commandId")?;
    let branch_id = string(command, "branchId")?;
    let head = string(command, "expectedHead")?;
    let actor = string(receipt, "actorId")?;
    let sim = reader
        .simulation(owner, simulation)?
        .ok_or_else(|| missing("Simulation", simulation))?;
    if receipt["draftId"]
        != domain_id(
            "actor_turn_draft",
            &[owner, simulation, string(receipt, "generationCommandId")?],
        )
        || receipt["contentRevisionId"] != sim.content_revision_id
    {
        return Err(EngineError::invalid(
            "Accepted draft receipt has invalid identity.",
        ));
    }
    let branch = reader
        .branch(owner, simulation, branch_id)?
        .ok_or_else(|| missing("Branch", branch_id))?;
    let base = match &branch.origin {
        crate::model::BranchOrigin::Root { base_commit_id, .. }
        | crate::model::BranchOrigin::Fork { base_commit_id, .. }
        | crate::model::BranchOrigin::Edit { base_commit_id, .. }
        | crate::model::BranchOrigin::Regenerate { base_commit_id, .. } => base_commit_id,
    };
    let prefix = reader.ancestry(owner, simulation, head)?;
    if !prefix.iter().any(|c| &c.id == base)
        || !reader
            .ancestry(owner, simulation, &branch.head_commit_id)?
            .iter()
            .any(|c| c.id == commit.id)
    {
        return Err(EngineError::invalid(
            "Accepted draft basis is not on its branch.",
        ));
    }
    let compiled = crate::commands::compiled(reader, owner, simulation)?;
    let require_actor = |id: &str| {
        if compiled
            .entities
            .iter()
            .any(|e| e.id == id && e.kind.can_own_turn())
        {
            Ok(())
        } else {
            Err(missing("Actor", id))
        }
    };
    require_actor(actor)?;
    let audience = strings(receipt, "audience")?;
    if audience != normalize_audience(actor, &audience) {
        return Err(EngineError::invalid(
            "Accepted draft audience is not normalized.",
        ));
    }
    for id in &audience {
        require_actor(id)?;
    }
    if let Some(routing) = receipt.get("routing") {
        if routing["version"].as_f64() == Some(4.0) {
            return Err(EngineError::invalid(
                "Historical routing requires a historical receipt.",
            ));
        }
        if routing["originalDraftId"]
            != domain_id(
                "actor_turn_draft",
                &[
                    owner,
                    simulation,
                    string(routing, "originalGenerationCommandId")?,
                ],
            )
        {
            return Err(EngineError::invalid("Original routing identity mismatch."));
        }
        for id in strings(routing, "availableRecipientIds")? {
            require_actor(&id)?;
        }
        if !routing["source"].is_null() {
            let source = &routing["source"];
            for id in strings(source, "audience")? {
                require_actor(&id)?;
            }
            if source["draftId"]
                != domain_id(
                    "actor_turn_draft",
                    &[owner, simulation, string(source, "generationCommandId")?],
                )
                || source["branchId"] != branch_id
                || source["basisHeadCommitId"] != head
            {
                return Err(EngineError::invalid("Source routing identity mismatch."));
            }
        }
    }
    if fingerprint(&receipt["runtimeProfile"])
        != fingerprint(&receipt["generatedArtifact"]["provenance"]["runtimeProfile"])
    {
        return Err(EngineError::invalid(
            "Accepted draft artifact provenance is invalid.",
        ));
    }
    if receipt["accepted"]["textSource"] == "acceptor_edited"
        && receipt["accepted"]["text"] == receipt["generatedArtifact"]["text"]
    {
        return Err(EngineError::invalid(
            "Accepted draft edit must differ from generated text.",
        ));
    }
    let pending = reader.pending_whispers(owner, simulation, branch_id, head, actor)?;
    for snapshot in array(receipt, "stageWhispers")? {
        if !pending
            .iter()
            .any(|w| w["id"] == snapshot["id"] && w["text"] == snapshot["text"])
        {
            return Err(EngineError::invalid(
                "Accepted draft whisper snapshot is invalid.",
            ));
        }
        if prefix
            .iter()
            .flat_map(|c| &c.events)
            .any(|e| e["type"] == "stage_whisper_consumed" && e["whisperId"] == snapshot["id"])
        {
            return Err(EngineError::invalid(
                "Accepted draft whisper was already consumed.",
            ));
        }
    }
    let expected = build_accepted_commit(
        reader,
        owner,
        simulation,
        branch_id,
        head,
        receipt,
        id,
        &commit.created_at,
    )?;
    if &expected != commit {
        return Err(EngineError::invalid(
            "Accepted draft event sequence does not match its receipt.",
        ));
    }
    Ok(())
}
