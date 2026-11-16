//! Branch creation and replacement preserve the accepted source path.
use crate::{
    audience::{Identity, ScopedPerformance, parse_performance},
    commands::{self, compiled},
    contracts::{runtime_text, safe_identifier},
    error::{EngineError, ErrorCode, Result},
    identity::domain_id,
    model::{Branch, BranchOrigin, BranchOutcome, Command, Commit},
    ports::SimulationRepository,
    projection::{project_branch, string},
};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};

fn command(request: &Value) -> Result<Command> {
    Ok(Command {
        owner_scope: string(request, "ownerScope")?.into(),
        simulation_id: string(request, "simulationId")?.into(),
        branch_id: string(request, "sourceBranchId")?.into(),
        expected_head: string(request, "expectedHead")?.into(),
        command_id: string(request, "commandId")?.into(),
        payload: request.get("payload").cloned().unwrap_or(Value::Null),
    })
}
fn branch(
    request: &Value,
    base: &str,
    head: &str,
    kind: &str,
    name: Option<&str>,
) -> Result<Branch> {
    let origin: BranchOrigin = serde_json::from_value(json!({"kind":kind,"commandId":string(request,"commandId")?,"sourceBranchId":string(request,"sourceBranchId")?,"sourceHeadCommitId":string(request,"expectedHead")?,"baseCommitId":base})).map_err(|e| EngineError::invalid(e.to_string()))?;
    Ok(Branch {
        id: string(request, "branchId")?.into(),
        owner_scope: string(request, "ownerScope")?.into(),
        simulation_id: string(request, "simulationId")?.into(),
        name: name.filter(|n| !n.is_empty()).map(str::to_owned),
        head_commit_id: head.into(),
        origin,
        created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}
pub fn fork_branch(
    repository: &mut impl SimulationRepository,
    mut request: Value,
) -> Result<BranchOutcome> {
    request["kind"] = json!("fork");
    if let Some(prior) = repository.replay_branch(&request)? {
        return Ok(prior);
    }
    let source = command(&request)?;
    commands::assert_expected_head(repository, &source)?;
    let base = string(&request, "atCommitId")?;
    let next = branch(&request, base, base, "fork", request["name"].as_str())?;
    repository.create_branch(&request, next, None)
}
pub fn replace_turn(
    repository: &mut impl SimulationRepository,
    mut request: Value,
    regenerate: bool,
) -> Result<BranchOutcome> {
    let kind = if regenerate { "regenerate" } else { "edit" };
    let source = command(&request)?;
    if request["payload"].get("knowledgePolicy").is_some()
        && request["payload"].get("audienceSyntax").is_none()
    {
        return Err(EngineError::invalid("Unsupported manual knowledge policy."));
    }
    request["payload"] = commands::record_manual(&source)?["payload"].clone();
    request["kind"] = json!(kind);
    if let Some(prior) = repository.replay_branch(&request)? {
        return Ok(prior);
    }
    commands::assert_expected_head(repository, &source)?;
    let id = string(&request, "sourceCommitId")?;
    let ancestry = repository.ancestry(
        &source.owner_scope,
        &source.simulation_id,
        &source.expected_head,
    )?;
    let original = ancestry.iter().find(|c| c.id == id).ok_or_else(|| {
        EngineError::invalid(format!(
            "Source commit {id} is not on source branch {}.",
            source.branch_id
        ))
    })?;
    let message = original
        .events
        .iter()
        .find(|e| e["type"] == "message_accepted")
        .ok_or_else(|| EngineError::invalid("Source commit has no accepted message."))?;
    if message["message"]["actorId"] != request["payload"]["actorId"] {
        return Err(EngineError::invalid(if regenerate {
            "A regenerated response must retain its original actor."
        } else {
            "An edited message must retain its original actor."
        }));
    }
    let parent = original
        .parent_commit_id
        .as_deref()
        .ok_or_else(|| EngineError::invalid("The root commit cannot be replaced."))?;
    let mut target = source;
    target.expected_head = parent.into();
    target.payload = request["payload"].clone();
    let commit = commands::build_historical_commit(
        repository,
        &target,
        string(&message["message"], "logicalMessageId")?,
        kind,
    )?;
    let next = branch(
        &request,
        parent,
        &commit.id,
        kind,
        Some(
            request["branchName"]
                .as_str()
                .filter(|n| !n.is_empty())
                .unwrap_or(kind),
        ),
    )?;
    repository.create_branch(&request, next, Some(commit))
}
pub fn correct_turn_body(
    repository: &mut impl SimulationRepository,
    mut request: Value,
) -> Result<BranchOutcome> {
    let source = command(&request)?;
    let version = string(&source.payload, "messageVersionId")?;
    safe_identifier(version, "messageVersionId")?;
    let text = string(&source.payload, "text")?;
    runtime_text(text, "Corrected performance")?;
    let text = text.trim();
    request["kind"] = json!("correct_turn_body");
    request["branchId"] = json!(domain_id(
        "correction_branch",
        &[
            &source.owner_scope,
            &source.simulation_id,
            &source.command_id
        ]
    ));
    request["payload"] = json!({"messageVersionId":version,"text":text});
    if let Some(prior) = repository.replay_branch(&request)? {
        return Ok(prior);
    }
    commands::assert_expected_head(repository, &source)?;
    let p = project_branch(
        repository,
        &source.owner_scope,
        &source.simulation_id,
        &source.branch_id,
        Some(&source.expected_head),
    )?;
    let turn = p
        .transcript
        .iter()
        .find(|t| t["messageVersionId"] == version)
        .ok_or_else(|| EngineError {
            code: ErrorCode::NotFound,
            message: "The selected turn is unavailable on this path.".into(),
        })?;
    if turn["text"] == text {
        return Err(EngineError::invalid(
            "Change the wording before saving a correction.",
        ));
    }
    let mut event = json!({"type":"message_body_corrected","messageVersionId":version,"text":text});
    if !turn["performance"].is_null() {
        let compiled = compiled(repository, &source.owner_scope, &source.simulation_id)?;
        let identities = compiled
            .entities
            .iter()
            .filter(|e| e.kind.can_own_turn())
            .map(|e| Identity {
                id: e.id.clone(),
                name: e.name.clone(),
            })
            .collect::<Vec<_>>();
        let original: ScopedPerformance = serde_json::from_value(turn["performance"].clone())
            .map_err(|e| EngineError::invalid(e.to_string()))?;
        let next = parse_performance(
            text,
            string(turn, "actorId")?,
            original.base_audience.as_deref(),
            &identities,
            original.syntax,
        )?;
        let routing = |p: &ScopedPerformance| {
            json!([
                p.base_audience,
                p.spans
                    .iter()
                    .map(|s| json!([s.audience, s.fallback.is_some()]))
                    .collect::<Vec<_>>()
            ])
        };
        let mut audience = commands::strings(turn, "audience")?;
        audience.sort();
        let mut next_audience = next.audience;
        next_audience.sort();
        if next.actor_id != string(turn, "actorId")?
            || routing(&original) != routing(&next.performance)
            || audience != next_audience
        {
            return Err(EngineError::invalid(
                "Audience changes require a replacement turn rather than a body-only correction.",
            ));
        }
        event["performance"] = serde_json::to_value(next.performance).unwrap();
    }
    let commit = Commit {
        id: domain_id(
            "commit",
            &[
                &source.owner_scope,
                &source.simulation_id,
                &source.command_id,
            ],
        ),
        owner_scope: source.owner_scope.clone(),
        simulation_id: source.simulation_id.clone(),
        parent_commit_id: Some(source.expected_head.clone()),
        kind: "effects".into(),
        command_id: source.command_id,
        events: vec![event],
        created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    let next = branch(
        &request,
        &source.expected_head,
        &commit.id,
        "edit",
        Some("correction"),
    )?;
    repository.create_branch(&request, next, Some(commit))
}
