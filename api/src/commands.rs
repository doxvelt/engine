//! Accepted manual turns and their staged effects. Validation completes before
//! the repository atomically compares the head and persists any event.
use crate::{
    access::{AccessChange, apply_validated_change},
    audience::{AudienceSyntax, Identity, parse_performance},
    content::CompiledWorkspace,
    error::{EngineError, ErrorCode, Result},
    identity::domain_id,
    model::{Branch, Command, Commit, Committed},
    ports::{SimulationReader, SimulationRepository},
    projection::{array, project_branch, string},
};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use std::collections::HashSet;

pub const KNOWLEDGE_POLICY: &str = "actor-knowledge-v1";
pub fn stage_whisper(
    repository: &mut impl SimulationRepository,
    mut request: Value,
) -> Result<Value> {
    request["kind"] = json!("whisper");
    request["text"] = json!(string(&request, "text")?.trim());
    if let Some(prior) = repository.replay_whisper(&request)? {
        return Ok(prior);
    }
    let envelope = Command {
        owner_scope: string(&request, "ownerScope")?.into(),
        simulation_id: string(&request, "simulationId")?.into(),
        branch_id: string(&request, "branchId")?.into(),
        expected_head: string(&request, "expectedHead")?.into(),
        command_id: string(&request, "commandId")?.into(),
        payload: Value::Null,
    };
    assert_expected_head(repository, &envelope)?;
    require_actor(
        &compiled(repository, &envelope.owner_scope, &envelope.simulation_id)?,
        string(&request, "targetActorId")?,
    )?;
    if string(&request, "text")?.is_empty() {
        return Err(EngineError::invalid("Stage whisper text is empty."));
    }
    let mut whisper = request.clone();
    whisper.as_object_mut().unwrap().remove("kind");
    whisper["id"] = json!(domain_id(
        "whisper",
        &[
            &envelope.owner_scope,
            &envelope.simulation_id,
            &envelope.command_id
        ]
    ));
    whisper["createdAt"] = json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
    repository.create_whisper(&request, whisper)
}
pub fn assert_expected_head(reader: &impl SimulationReader, command: &Command) -> Result<Branch> {
    let branch = reader
        .branch(
            &command.owner_scope,
            &command.simulation_id,
            &command.branch_id,
        )?
        .ok_or_else(|| missing("Branch", &command.branch_id))?;
    if branch.head_commit_id != command.expected_head {
        return Err(EngineError::branch_conflict(
            &command.expected_head,
            &branch.head_commit_id,
        ));
    }
    Ok(branch)
}
fn missing(label: &str, id: &str) -> EngineError {
    EngineError {
        code: ErrorCode::NotFound,
        message: format!("{label} not found: {id}"),
    }
}
pub fn compiled(
    reader: &impl SimulationReader,
    owner: &str,
    simulation: &str,
) -> Result<CompiledWorkspace> {
    let simulation = reader
        .simulation(owner, simulation)?
        .ok_or_else(|| missing("Simulation", simulation))?;
    Ok(reader
        .revision(owner, &simulation.content_revision_id)?
        .ok_or_else(|| missing("Content revision", &simulation.content_revision_id))?
        .compiled)
}
fn require_actor(compiled: &CompiledWorkspace, actor: &str) -> Result<()> {
    if compiled
        .entities
        .iter()
        .any(|e| e.id == actor && e.kind.can_own_turn())
    {
        Ok(())
    } else {
        Err(missing("Actor", actor))
    }
}
pub fn strings(value: &Value, key: &str) -> Result<Vec<String>> {
    array(value, key)?
        .iter()
        .map(|id| {
            id.as_str()
                .map(str::to_owned)
                .ok_or_else(|| EngineError::invalid(format!("{key} must be strings.")))
        })
        .collect()
}
pub fn normalize_audience(actor: &str, audience: &[String]) -> Vec<String> {
    let mut result = vec![actor.to_owned()];
    for id in audience {
        if !result.contains(id) {
            result.push(id.clone());
        }
    }
    result
}
fn normalize_effects(payload: &mut Value) -> Result<()> {
    for key in ["audienceChanges", "accessChanges"] {
        if let Some(changes) = payload.get_mut(key) {
            let changes = changes
                .as_array_mut()
                .ok_or_else(|| EngineError::invalid(format!("{key} must be an array.")))?;
            for change in changes {
                if !change.is_object() {
                    return Err(EngineError::invalid(format!("{key} must contain objects.")));
                }
                if change
                    .get("reason")
                    .is_none_or(|r| r.is_null() || r.as_str() == Some(""))
                {
                    change["reason"] = Value::Null;
                } else {
                    string(change, "reason")?;
                }
            }
        }
    }
    if let Some(whisper) = payload.get_mut("stageWhisper").filter(|v| v.is_string()) {
        let text = whisper.as_str().unwrap().trim();
        *whisper = if text.is_empty() {
            Value::Null
        } else {
            json!(text)
        };
    }
    Ok(())
}
pub fn record_manual(command: &Command) -> Result<Value> {
    let mut result = serde_json::to_value(command).unwrap();
    result["kind"] = json!("turn");
    let payload = &mut result["payload"];
    let actor = string(payload, "actorId")?.to_owned();
    let text = string(payload, "text")?.trim().to_owned();
    let object = payload.as_object_mut().unwrap();
    object.remove("logicalMessageId");
    object.remove("operation");
    payload["text"] = json!(text);
    if payload.get("knowledgePolicy").is_some() && payload["knowledgePolicy"] != KNOWLEDGE_POLICY {
        return Err(EngineError::invalid("Unsupported manual knowledge policy."));
    }
    if let Some(syntax) = payload.get("audienceSyntax") {
        serde_json::from_value::<AudienceSyntax>(syntax.clone())
            .map_err(|_| EngineError::invalid("Unsupported audience syntax."))?;
        if payload["knowledgePolicy"] != KNOWLEDGE_POLICY {
            return Err(EngineError::invalid(
                "Scoped authoring requires the actor-knowledge policy.",
            ));
        }
        if !payload["audience"].is_null() {
            strings(payload, "audience")?;
        }
        if payload.get("audience").is_none() {
            return Err(EngineError::invalid("Invalid composer audience."));
        }
    } else {
        payload["audience"] = json!(normalize_audience(&actor, &strings(payload, "audience")?));
    }
    normalize_effects(payload)?;
    Ok(result)
}
pub fn commit_manual_turn(
    repository: &mut impl SimulationRepository,
    command: Command,
) -> Result<Committed> {
    let recorded = record_manual(&command)?;
    if let Some(prior) = repository.replay_commit(&recorded)? {
        return Ok(prior);
    }
    let mut normalized = command;
    normalized.payload = recorded["payload"].clone();
    assert_expected_head(repository, &normalized)?;
    let commit = build_manual_commit(repository, &normalized)?;
    repository.append_commit(&recorded, commit)
}

pub fn mutate_memory(
    repository: &mut impl SimulationRepository,
    mut command: Command,
    retract: bool,
) -> Result<Committed> {
    let kind = if retract {
        "retract_memory"
    } else {
        "revise_memory"
    };
    if !retract {
        command.payload["content"] = json!(string(&command.payload, "content")?.trim());
    }
    let mut recorded = serde_json::to_value(&command).unwrap();
    recorded["kind"] = json!(kind);
    if let Some(prior) = repository.replay_commit(&recorded)? {
        return Ok(prior);
    }
    assert_expected_head(repository, &command)?;
    let p = project_branch(
        repository,
        &command.owner_scope,
        &command.simulation_id,
        &command.branch_id,
        None,
    )?;
    let memory_id = string(&command.payload, "memoryId")?;
    let current = p
        .memory_operations
        .iter()
        .rev()
        .find(|op| op["memoryId"] == memory_id)
        .ok_or_else(|| missing("Memory", memory_id))?;
    if current["actorId"] != command.payload["actorId"] {
        return Err(EngineError::invalid(
            "An actor cannot change another actor's memory.",
        ));
    }
    if current["type"] == "retracted" {
        return Err(EngineError::invalid("Memory is already retracted."));
    }
    let target = if retract {
        "retractsOperationId"
    } else {
        "revisesOperationId"
    };
    if command.payload[target] != current["id"] {
        return Err(EngineError::invalid("Memory operation chain is stale."));
    }
    if !retract && string(&command.payload, "content")?.is_empty() {
        return Err(EngineError::invalid("Replacement memory content is empty."));
    }
    let ids = [
        &*command.owner_scope,
        &*command.simulation_id,
        &*command.command_id,
    ];
    let created = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut operation = json!({"id":domain_id("memory_operation",&ids),"memoryId":current["memoryId"],"simulationId":current["simulationId"],"actorId":current["actorId"],
        "memoryKind":current["memoryKind"],"basisCommitId":command.expected_head,"closureCommitId":null,"sourcePerceptionIds":current["sourcePerceptionIds"],
        "sourceEventIds":current["sourceEventIds"],"sourceMessageVersionIds":current["sourceMessageVersionIds"],"producer":{"mode":"manual","commandId":command.command_id},"createdAt":created,
        "type":if retract {"retracted"} else {"revised"}});
    operation[target] = current["id"].clone();
    if !retract {
        operation["content"] = command.payload["content"].clone();
    }
    let commit = Commit {
        id: domain_id("commit", &ids),
        owner_scope: command.owner_scope,
        simulation_id: command.simulation_id,
        parent_commit_id: Some(command.expected_head),
        kind: "memory".into(),
        command_id: command.command_id,
        events: vec![json!({"type":"memory_operation","operation":operation})],
        created_at: created,
    };
    repository.append_commit(&recorded, commit)
}

pub fn commit_effects(
    repository: &mut impl SimulationRepository,
    mut command: Command,
) -> Result<Committed> {
    normalize_effects(&mut command.payload)?;
    let mut recorded = serde_json::to_value(&command).unwrap();
    recorded["kind"] = json!("effects");
    if let Some(prior) = repository.replay_commit(&recorded)? {
        return Ok(prior);
    }
    assert_expected_head(repository, &command)?;
    let p = project_branch(
        repository,
        &command.owner_scope,
        &command.simulation_id,
        &command.branch_id,
        Some(&command.expected_head),
    )?;
    let compiled = compiled(repository, &command.owner_scope, &command.simulation_id)?;
    let mut events = Vec::new();
    append_effect_events(&compiled, p.access_links, &command.payload, &mut events)?;
    if events.is_empty() {
        return Err(EngineError::invalid(
            "Runtime effects command has no effects.",
        ));
    }
    let commit = Commit {
        id: domain_id(
            "commit",
            &[
                &command.owner_scope,
                &command.simulation_id,
                &command.command_id,
            ],
        ),
        owner_scope: command.owner_scope,
        simulation_id: command.simulation_id,
        parent_commit_id: Some(command.expected_head),
        kind: "effects".into(),
        command_id: command.command_id,
        events,
        created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    repository.append_commit(&recorded, commit)
}
pub fn build_manual_commit(reader: &impl SimulationReader, command: &Command) -> Result<Commit> {
    build_manual_commit_with(reader, command, None)
}
pub fn build_historical_commit(
    reader: &impl SimulationReader,
    command: &Command,
    logical: &str,
    operation: &str,
) -> Result<Commit> {
    build_manual_commit_with(reader, command, Some((logical, operation)))
}
fn build_manual_commit_with(
    reader: &impl SimulationReader,
    command: &Command,
    provenance: Option<(&str, &str)>,
) -> Result<Commit> {
    let payload = &command.payload;
    let text = string(payload, "text")?.trim();
    if text.is_empty() {
        return Err(EngineError::invalid("Turn text is empty."));
    }
    let compiled = compiled(reader, &command.owner_scope, &command.simulation_id)?;
    let actor = string(payload, "actorId")?;
    let scoped = payload
        .get("audienceSyntax")
        .map(|syntax| {
            if payload["knowledgePolicy"] != KNOWLEDGE_POLICY {
                return Err(EngineError::invalid(
                    "Scoped authoring requires the actor-knowledge policy.",
                ));
            }
            let syntax: AudienceSyntax = serde_json::from_value(syntax.clone())
                .map_err(|_| EngineError::invalid("Unsupported audience syntax."))?;
            let audience = if payload["audience"].is_null() {
                None
            } else {
                Some(strings(payload, "audience")?)
            };
            let identities = compiled
                .entities
                .iter()
                .filter(|e| e.kind.can_own_turn())
                .map(|e| Identity {
                    id: e.id.clone(),
                    name: e.name.clone(),
                })
                .collect::<Vec<_>>();
            parse_performance(text, actor, audience.as_deref(), &identities, syntax)
        })
        .transpose()?;
    let actor = scoped
        .as_ref()
        .map(|s| s.actor_id.as_str())
        .unwrap_or(actor);
    if provenance.is_some() && actor != string(payload, "actorId")? {
        return Err(EngineError::invalid(
            "An edited performance must retain its original actor.",
        ));
    }
    require_actor(&compiled, actor)?;
    let audience = if let Some(scoped) = &scoped {
        scoped.audience.clone()
    } else {
        normalize_audience(actor, &strings(payload, "audience")?)
    };
    for id in &audience {
        require_actor(&compiled, id)?;
    }
    let ids = [
        &*command.owner_scope,
        &*command.simulation_id,
        &*command.command_id,
    ];
    let mut message = json!({"id":domain_id("message_version",&ids),"logicalMessageId":provenance.map(|p| p.0.to_owned()).unwrap_or_else(|| domain_id("message",&ids)),"actorId":actor,"text":text,"audience":audience,"provenance":{"mode":"manual","operation":provenance.map(|p| p.1).unwrap_or("turn")} });
    if let Some(scoped) = &scoped {
        message["performance"] = serde_json::to_value(&scoped.performance).unwrap();
    }
    let mut events = vec![json!({"type":"message_accepted","message":message})];
    // Current-policy turns without access changes use no historical state:
    // receipts do not derive first impressions, and audience validation only
    // needs pinned identities. Preserve full projection for legacy turns,
    // access mutations and historical selections, including all their checks.
    let branch = reader
        .branch(
            &command.owner_scope,
            &command.simulation_id,
            &command.branch_id,
        )?
        .ok_or_else(|| missing("Branch", &command.branch_id))?;
    let needs_access = payload
        .get("accessChanges")
        .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()));
    let p = if payload["knowledgePolicy"] != KNOWLEDGE_POLICY
        || needs_access
        || branch.head_commit_id != command.expected_head
    {
        Some(project_branch(
            reader,
            &command.owner_scope,
            &command.simulation_id,
            &command.branch_id,
            Some(&command.expected_head),
        )?)
    } else {
        if reader
            .commit(
                &command.owner_scope,
                &command.simulation_id,
                &command.expected_head,
            )?
            .is_none()
        {
            return Err(missing("Commit", &command.expected_head));
        }
        None
    };
    append_effect_events(
        &compiled,
        p.as_ref()
            .map_or_else(|| compiled.access_links.clone(), |p| p.access_links.clone()),
        payload,
        &mut events,
    )?;
    if payload["knowledgePolicy"] != KNOWLEDGE_POLICY {
        events.extend(first_impression_events(
            &compiled,
            &audience,
            &p.as_ref().unwrap().first_impressions,
        ));
    }
    let pending = reader.pending_whispers(
        &command.owner_scope,
        &command.simulation_id,
        &command.branch_id,
        &command.expected_head,
        actor,
    )?;
    let selected = if payload.get("stageWhisperIds").is_some() {
        let ids = strings(payload, "stageWhisperIds")?;
        let mut seen = HashSet::new();
        for id in &ids {
            if id.is_empty() {
                return Err(EngineError::invalid(
                    "stageWhisperIds must contain non-empty strings.",
                ));
            }
            if !seen.insert(id) {
                return Err(EngineError::invalid(
                    "stageWhisperIds must not contain duplicates.",
                ));
            }
        }
        ids.into_iter()
            .map(|id| {
                pending
                    .iter()
                    .find(|w| w["id"] == id)
                    .cloned()
                    .ok_or_else(|| {
                        EngineError::invalid(format!(
                            "Stage whisper {id} is not pending for this actor and branch head."
                        ))
                    })
            })
            .collect::<Result<Vec<_>>>()?
    } else {
        pending
    };
    for whisper in selected {
        events.push(json!({"type":"stage_whisper_consumed","whisperId":whisper["id"],"targetActorId":actor,"text":whisper["text"]}));
    }
    if let Some(inline) = payload["stageWhisper"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        events.push(json!({"type":"stage_whisper_consumed","whisperId":domain_id("whisper",&ids),"targetActorId":actor,"text":inline}));
    }
    Ok(Commit {
        id: domain_id("commit", &ids),
        owner_scope: command.owner_scope.clone(),
        simulation_id: command.simulation_id.clone(),
        parent_commit_id: Some(command.expected_head.clone()),
        kind: "turn".into(),
        command_id: command.command_id.clone(),
        events,
        created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}
pub fn first_impression_events(
    compiled: &CompiledWorkspace,
    audience: &[String],
    existing: &[Value],
) -> Vec<Value> {
    let mut events = Vec::new();
    for observer in audience {
        for entity in audience {
            if observer == entity
                || existing
                    .iter()
                    .any(|i| i["observerId"] == *observer && i["entityId"] == *entity)
            {
                continue;
            }
            if let Some(surface) = compiled.surfaces.iter().find(|s| &s.entity == entity) {
                events.push(json!({"type":"first_impression_formed","impression":{"holder":observer,"observerId":observer,"entityId":entity,"strength":1,
                "propositionText":format!("@{observer} forms a first impression that {}",surface.text),"surfaceSourceSpan":surface.source_span}}));
            }
        }
    }
    events
}
fn append_effect_events(
    compiled: &CompiledWorkspace,
    mut access: Vec<crate::content::AccessLink>,
    payload: &Value,
    events: &mut Vec<Value>,
) -> Result<()> {
    if payload.get("audienceChanges").is_some() {
        for change in array(payload, "audienceChanges")? {
            require_actor(compiled, string(change, "actorId")?)?;
            if !["add", "remove", "deactivate", "reactivate"].contains(&string(change, "action")?) {
                return Err(EngineError::invalid("Invalid audience action."));
            }
            events.push(json!({"type":"audience_changed","actorId":change["actorId"],"action":change["action"],"reason":change["reason"]}));
        }
    }
    if payload.get("accessChanges").is_some() {
        for change in array(payload, "accessChanges")? {
            let change: AccessChange = serde_json::from_value(change.clone())
                .map_err(|e| EngineError::invalid(e.to_string()))?;
            for id in [&change.member, &change.container] {
                if !compiled.entities.iter().any(|e| &e.id == id) {
                    return Err(missing("Entity", id));
                }
            }
            access = apply_validated_change(&access, &change)?;
            events.push(json!({"type":"access_changed","action":change.action,"member":change.member,"container":change.container,"mode":"member","reason":change.reason}));
        }
    }
    Ok(())
}
