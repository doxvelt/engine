//! Durable candidate preparation is separate from model execution. No provider
//! request starts until the frozen input and command identity are reserved.
use crate::{
    commands::{assert_expected_head, normalize_audience, strings},
    context::{ContextOptions, inspect_actor_context},
    contracts::safe_identifier,
    draft_contracts,
    error::{EngineError, ErrorCode, Result},
    identity::{domain_id, fingerprint, sha256},
    model::Command,
    ports::ActorDraftRepository,
    projection::{array, string},
    routing::{
        captured_episode_recall, parse_audience_proposal, prepare_routing, preserved_artifact,
        project_routing_context, routing_direction,
    },
    runtime::{
        FailureCode, Observation, StreamFailure, StreamOutcome, artifact_digest, canonical_context,
        provenance,
    },
};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Default)]
pub struct PrepareOptions<'a> {
    pub retry_draft_id: Option<&'a str>,
    pub episode_recall: Option<&'a Value>,
}
pub struct PreparedDraft {
    pub draft: Value,
    pub replayed: bool,
}
fn missing(label: &str, id: &str) -> EngineError {
    EngineError {
        code: ErrorCode::NotFound,
        message: format!("{label} not found: {id}"),
    }
}
pub fn normalize_generation(mut command: Command) -> Result<Command> {
    let p = &mut command.payload;
    p["actorId"] = json!(string(p, "actorId")?.trim());
    p["audience"] = json!(normalize_audience(
        string(p, "actorId")?,
        &strings(p, "audience")?
    ));
    for (key, second) in [
        ("runtimeProfile", "version"),
        ("promptPolicy", "version"),
        ("outputSchema", "digest"),
    ] {
        p[key] = json!({"id":safe_identifier(string(&p[key],"id")?,&format!("{key} ID"))?,second:safe_identifier(string(&p[key],second)?,&format!("{key} {second}"))?});
    }
    let skills = strings(p, "skillDigests")?
        .iter()
        .map(|id| safe_identifier(id, "skill digest"))
        .collect::<Result<Vec<_>>>()?;
    p["skillDigests"] = json!(skills);
    for key in ["stageWhisperIds", "skillDigests"] {
        let ids = strings(p, key)?;
        let mut seen = HashSet::new();
        if ids.iter().any(|id| id.is_empty()) {
            return Err(EngineError::invalid(format!(
                "{key} must contain non-empty strings."
            )));
        }
        if ids.iter().any(|id| !seen.insert(id)) {
            return Err(EngineError::invalid(format!(
                "{key} must not contain duplicates."
            )));
        }
    }
    if string(p, "actorId")?.is_empty() {
        return Err(EngineError::invalid(
            "Draft generation input is incomplete.",
        ));
    }
    if let Some(routing) = p.get("routing") {
        draft_contracts::routing_input(routing)?;
        let selected = if !routing["correctedAudience"].is_null() {
            &routing["correctedAudience"]
        } else {
            &routing["initialAudience"]
        };
        let ids = if selected.is_null() {
            vec![]
        } else {
            draft_contracts::identity_array(selected, "Directed recipients")?
        };
        if p["audience"] != json!(normalize_audience(string(p, "actorId")?, &ids)) {
            return Err(EngineError::invalid(
                "Routing direction and audience disagree.",
            ));
        }
    }
    Ok(command)
}
pub fn captured_command(draft: &Value, command_id: &str) -> Result<Command> {
    let mut payload = json!({"actorId":draft["actorId"],"audience":draft["audience"],"stageWhisperIds":array(draft,"stageWhispers")?.iter().map(|w| &w["id"]).collect::<Vec<_>>(),
        "runtimeProfile":draft["runtimeProfile"],"promptPolicy":draft["promptPolicy"],"outputSchema":draft["outputSchema"],"skillDigests":draft["skillDigests"]});
    if let Some(routing) = draft.get("routing") {
        payload["routing"] = routing_direction(routing)?;
    }
    normalize_generation(Command {
        owner_scope: string(draft, "ownerScope")?.into(),
        simulation_id: string(draft, "simulationId")?.into(),
        branch_id: string(draft, "branchId")?.into(),
        expected_head: string(draft, "basisHeadCommitId")?.into(),
        command_id: command_id.into(),
        payload,
    })
}
pub fn prepare_actor_draft(
    repository: &mut impl ActorDraftRepository,
    command: Command,
    options: PrepareOptions<'_>,
) -> Result<PreparedDraft> {
    let command = normalize_generation(command)?;
    let digest = fingerprint(&serde_json::to_value(&command).unwrap());
    let id = domain_id(
        "actor_turn_draft",
        &[
            &command.owner_scope,
            &command.simulation_id,
            &command.command_id,
        ],
    );
    if let Some(existing) =
        repository.actor_draft(&command.owner_scope, &command.simulation_id, &id)?
    {
        let (draft, replayed) = repository.reserve_actor_draft(existing, &digest)?;
        return Ok(PreparedDraft { draft, replayed });
    }
    let simulation = repository
        .simulation(&command.owner_scope, &command.simulation_id)?
        .ok_or_else(|| missing("Simulation", &command.simulation_id))?;
    assert_expected_head(repository, &command)?;
    let revision = repository
        .revision(&command.owner_scope, &simulation.content_revision_id)?
        .ok_or_else(|| missing("Content revision", &simulation.content_revision_id))?;
    let actor = string(&command.payload, "actorId")?;
    for id in normalize_audience(actor, &strings(&command.payload, "audience")?) {
        if !revision
            .compiled
            .entities
            .iter()
            .any(|e| e.id == id && e.kind.can_own_turn())
        {
            return Err(missing("Actor", &id));
        }
    }
    let captured = options
        .retry_draft_id
        .map(|id| {
            repository
                .actor_draft(&command.owner_scope, &command.simulation_id, id)?
                .ok_or_else(|| missing("Retry source", id))
        })
        .transpose()?;
    if let Some(captured) = &captured {
        if fingerprint(
            &serde_json::to_value(captured_command(captured, &command.command_id)?).unwrap(),
        ) != digest
        {
            return Err(EngineError::invalid("Retry must repeat captured input."));
        }
    }
    let pending = repository.pending_whispers(
        &command.owner_scope,
        &command.simulation_id,
        &command.branch_id,
        &command.expected_head,
        actor,
    )?;
    let whispers = strings(&command.payload, "stageWhisperIds")?
        .into_iter()
        .map(|id| {
            pending
                .iter()
                .find(|w| w["id"] == id)
                .cloned()
                .ok_or_else(|| EngineError::invalid(format!("Stage whisper not found: {id}")))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut routing = command
        .payload
        .get("routing")
        .map(|_| prepare_routing(repository, &command, &[]))
        .transpose()?;
    let recall = if let Some(captured) = &captured {
        captured_episode_recall(&captured["context"])?
    } else {
        options.episode_recall.cloned()
    };
    let (context, prompt) = if let Some(routing) = &mut routing {
        let source = if routing["preservedText"].is_null()
            && captured
                .as_ref()
                .is_none_or(|d| d["context"].get("correctionSource").is_some())
        {
            routing.get("source").filter(|v| !v.is_null())
        } else {
            None
        };
        let routed =
            project_routing_context(repository, &command, &whispers, source, recall.as_ref())?;
        routing["availableRecipientIds"] = json!(routed.available_recipient_ids);
        (routed.context, routed.prompt)
    } else {
        let audience = strings(&command.payload, "audience")?;
        let context = inspect_actor_context(
            repository,
            &command.owner_scope,
            &command.simulation_id,
            &command.branch_id,
            Some(&command.expected_head),
            actor,
            ContextOptions {
                audience: Some(&audience),
                whispers: &whispers,
                ..Default::default()
            },
        )?;
        (
            canonical_context(&context),
            string(&context, "promptPreview")?.into(),
        )
    };
    let context_hash = fingerprint(&context);
    let prompt_hash = sha256(&prompt);
    if captured.as_ref().is_some_and(|captured| {
        captured["contextHash"] != context_hash || captured["promptHash"] != prompt_hash
    }) {
        return Err(EngineError::invalid(
            "Retry context differs from captured input.",
        ));
    }
    let created = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut draft = json!({"id":id,"ownerScope":command.owner_scope,"simulationId":command.simulation_id,"generationCommandId":command.command_id,"branchId":command.branch_id,"basisHeadCommitId":command.expected_head,"contentRevisionId":revision.id,
        "actorId":actor,"audience":command.payload["audience"],"stageWhispers":whispers.iter().map(|w| json!({"id":w["id"],"text":w["text"]})).collect::<Vec<_>>(),
        "runtimeProfile":command.payload["runtimeProfile"],"promptPolicy":command.payload["promptPolicy"],"outputSchema":command.payload["outputSchema"],"skillDigests":command.payload["skillDigests"],"capabilityGrant":[],
        "context":context,"contextHash":context_hash,"prompt":prompt,"promptHash":prompt_hash,"status":"generating","artifact":null,"failure":null,"createdAt":created,"updatedAt":created});
    if let Some(routing) = routing {
        draft["routing"] = routing;
    }
    draft_contracts::draft_record(&draft)?;
    let (draft, replayed) = repository.reserve_actor_draft(draft, &digest)?;
    Ok(PreparedDraft { draft, replayed })
}
pub fn frozen_runtime_request(draft: &Value) -> Value {
    let mut request = serde_json::Map::new();
    for key in [
        "ownerScope",
        "simulationId",
        "branchId",
        "basisHeadCommitId",
        "contentRevisionId",
        "actorId",
        "audience",
        "context",
        "contextHash",
        "prompt",
        "promptHash",
        "runtimeProfile",
        "promptPolicy",
        "outputSchema",
        "skillDigests",
    ] {
        request.insert(key.into(), draft[key].clone());
    }
    request.insert("draftId".into(), draft["id"].clone());
    request.insert("capabilityGrant".into(), json!([]));
    Value::Object(request)
}
pub fn finish_preserved(
    repository: &mut impl ActorDraftRepository,
    draft: &Value,
) -> Result<Option<Value>> {
    if draft.get("routing").is_none() || draft["routing"]["preservedText"].is_null() {
        return Ok(None);
    }
    let artifact = preserved_artifact(draft)?;
    settle(repository, draft, Some(&artifact), None).map(Some)
}
pub fn finish_runtime(
    repository: &mut impl ActorDraftRepository,
    draft: &Value,
    identity: &Value,
    outcome: std::result::Result<StreamOutcome, StreamFailure>,
) -> Result<Value> {
    let (text, observation, failure) = match outcome {
        Ok(StreamOutcome::Completed { text, observation }) => (Some(text), observation, None),
        Ok(StreamOutcome::Failed { observation }) => {
            (None, observation, Some(FailureCode::RuntimeFailure))
        }
        Err(failure) => (None, failure.observation, Some(failure.code)),
    };
    if let Some(code) = failure {
        return settle_failure(repository, draft, identity, observation, code);
    }
    let text = text.unwrap();
    let (text, audience) = if draft.get("routing").is_some() {
        match parse_audience_proposal(&text, draft) {
            Ok((text, audience)) => (text, Some(audience)),
            Err(_) => {
                return settle_failure(
                    repository,
                    draft,
                    identity,
                    observation,
                    FailureCode::OutputContract,
                );
            }
        }
    } else {
        (text, None)
    };
    let mut artifact = json!({"text":text,"digest":artifact_digest(&text,audience.as_deref()),"provenance":provenance(identity,&draft["runtimeProfile"],&observation,true)});
    if let Some(audience) = audience {
        artifact["proposedAudience"] = json!(audience);
    }
    if draft_contracts::completed_artifact(&artifact).is_err() {
        return settle_failure(
            repository,
            draft,
            identity,
            observation,
            FailureCode::InvalidStream,
        );
    }
    settle(repository, draft, Some(&artifact), None)
}
fn settle_failure(
    repository: &mut impl ActorDraftRepository,
    draft: &Value,
    identity: &Value,
    observation: Observation,
    code: FailureCode,
) -> Result<Value> {
    let failure = StreamFailure { code, observation };
    let value = json!({"code":code,"message":failure.message(),"provenance":provenance(identity,&draft["runtimeProfile"],&failure.observation,false)});
    settle(repository, draft, None, Some(&value))
}
fn settle(
    repository: &mut impl ActorDraftRepository,
    draft: &Value,
    artifact: Option<&Value>,
    failure: Option<&Value>,
) -> Result<Value> {
    let owner = string(draft, "ownerScope")?;
    let simulation = string(draft, "simulationId")?;
    let id = string(draft, "id")?;
    let current = repository
        .actor_draft(owner, simulation, id)?
        .ok_or_else(|| missing("Draft", id))?;
    if current["status"] != "generating" {
        return Ok(current);
    }
    repository.transition_actor_draft(owner, simulation, id, artifact, failure)
}
