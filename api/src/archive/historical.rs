use super::{ArchiveReader, RecordedCommandResult, SimulationArchive, codec};
use crate::{
    audience::{AudienceSyntax, Identity, parse_performance},
    commands::normalize_audience,
    error::{EngineError, Result},
    identity::{domain_id, fingerprint},
    model::Commit,
    ports::SimulationReader,
    projection::{array, string},
};
use serde_json::{Value, json};

fn invalid(message: &str) -> EngineError {
    EngineError::invalid(format!("Historical archive {message}"))
}
fn same(a: &Value, b: &Value) -> bool {
    fingerprint(a) == fingerprint(b)
}
pub struct Selection {
    pub commit: Commit,
    pub message: Value,
    pub parent: String,
}
pub fn select(archive: &SimulationArchive, request: &Value) -> Result<Selection> {
    let reader = ArchiveReader::new(archive);
    let owner = string(request, "ownerScope")?;
    let simulation = string(request, "simulationId")?;
    let branch = reader
        .branch(owner, simulation, string(request, "sourceBranchId")?)?
        .ok_or_else(|| invalid("source branch is missing."))?;
    if !reader
        .ancestry(owner, simulation, &branch.head_commit_id)?
        .iter()
        .any(|c| c.id == request["expectedHead"])
    {
        return Err(invalid("guard is not on the source path."));
    }
    let commit = reader
        .ancestry(owner, simulation, string(request, "expectedHead")?)?
        .into_iter()
        .find(|c| c.id == request["sourceCommitId"])
        .ok_or_else(|| invalid("selection is missing from the guarded source path."))?;
    let messages: Vec<_> = commit
        .events
        .iter()
        .filter(|e| e["type"] == "message_accepted")
        .collect();
    if commit.kind != "turn" || messages.len() != 1 || commit.parent_commit_id.is_none() {
        return Err(invalid("selection must be one accepted turn."));
    }
    let message = messages[0]["message"].clone();
    if message["id"] != request["messageVersionId"]
        || message["logicalMessageId"] != request["logicalMessageId"]
        || message["actorId"] != request["actorId"]
    {
        return Err(invalid("selection identity mismatch."));
    }
    Ok(Selection {
        parent: commit.parent_commit_id.clone().unwrap(),
        commit,
        message,
    })
}
/// Derive only recorded direction. Operational candidates cannot supply or
/// repair missing historical provenance.
pub fn originating_input(archive: &SimulationArchive, request: &Value) -> Result<Value> {
    let selected = select(archive, request)?;
    let command = archive
        .command_results
        .iter()
        .find(|c| c.command_id == selected.commit.command_id)
        .map(|c| &c.canonical_input);
    let snapshots: Vec<_> = selected
        .commit
        .events
        .iter()
        .filter(|e| e["type"] == "stage_whisper_consumed")
        .map(|e| json!({"id":e["whisperId"],"text":e["text"]}))
        .collect();
    let unavailable = || json!({"kind":"unavailable","state":"unavailable","completeWhisper":null,"recordedWhispers":[],"legacyCorrection":null});
    let Some(command) = command else {
        return Ok(unavailable());
    };
    let mut result = match command["kind"].as_str() {
        Some("saved_alternative") => {
            let receipt = &command["payload"];
            json!({"kind":if receipt["generated"].is_null() {"manual"} else {"generated"},"state":if receipt["completeWhisper"].is_null() {"none"} else {"complete"},"completeWhisper":receipt["completeWhisper"],"recordedWhispers":snapshots,"legacyCorrection":null})
        }
        Some("accept_draft") => {
            let receipt = &command["payload"];
            let routing = &receipt["routing"];
            if !same(&receipt["stageWhispers"], &json!(snapshots))
                || receipt["actorId"] != selected.message["actorId"]
            {
                return Ok(unavailable());
            }
            let complete = if matches!(routing["version"].as_f64(), Some(2.0 | 3.0)) {
                routing["completeWhisper"].clone()
            } else if routing["sourceDraftId"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
                || snapshots.len() > 1
            {
                Value::Null
            } else {
                snapshots
                    .first()
                    .map(|w| w["text"].clone())
                    .unwrap_or_else(|| json!(""))
            };
            json!({"kind":"generated","state":if complete.is_null() {"legacy"} else if !snapshots.is_empty() || complete.as_str().is_some_and(|s|!s.is_empty()) {"complete"} else {"none"},"completeWhisper":complete,"recordedWhispers":snapshots,"legacyCorrection":if routing["version"].as_f64()==Some(1.0) {routing["correction"].clone()} else {Value::Null}})
        }
        Some("turn" | "edit" | "regenerate")
            if selected.message["provenance"]["mode"] == "manual" =>
        {
            json!({"kind":"manual","state":if snapshots.len()>1 {"legacy"} else if snapshots.is_empty() {"none"} else {"complete"},"completeWhisper":if snapshots.len()==1 {snapshots[0]["text"].clone()} else {Value::Null},"recordedWhispers":snapshots,"legacyCorrection":null})
        }
        _ => return Ok(unavailable()),
    };
    let receipt = if command["kind"] == "saved_alternative" {
        &command["payload"]["generated"]
    } else {
        &command["payload"]
    };
    if let Some(profile) = receipt.get("runtimeProfile")
        && !same(profile, &json!({"id":"local-character","version":"v1"}))
    {
        result["actorProfile"] = profile.clone();
    }
    Ok(result)
}
pub fn verify_alternative(
    archive: &SimulationArchive,
    record: &RecordedCommandResult,
) -> Result<()> {
    if archive.schema_version != 7 {
        return Err(invalid("receipt requires schema 7."));
    }
    let command = &record.canonical_input;
    let p = &command["payload"];
    let r = &p["request"];
    let selected = select(archive, r)?;
    if selected.commit.events.iter().any(|e| {
        !matches!(
            e["type"].as_str(),
            Some("message_accepted" | "first_impression_formed" | "stage_whisper_consumed")
        )
    }) {
        return Err(invalid("replacement cannot replay explicit world effects."));
    }
    let origin = originating_input(archive, r)?;
    let inherited =
        if r.get("replacementActorId").is_none() || r["replacementActorId"] == r["actorId"] {
            origin["completeWhisper"].clone()
        } else {
            Value::Null
        };
    if p["parentCommitId"] != selected.parent
        || p["contentRevisionId"] != archive.content_revision.id
        || !same(&p["origin"], &origin)
        || r["action"] == "generate"
            && p["completeWhisper"] != *r.get("completeWhisper").unwrap_or(&inherited)
    {
        return Err(invalid("input or origin receipt mismatch."));
    }
    let actor = r.get("replacementActorId").unwrap_or(&r["actorId"]);
    let actor = actor.as_str().ok_or_else(|| invalid("actor is invalid."))?;
    let require_actor = |id: &str| -> Result<()> {
        if archive
            .content_revision
            .compiled
            .entities
            .iter()
            .any(|e| e.id == id && e.kind.can_own_turn())
        {
            Ok(())
        } else {
            Err(invalid("actor is missing from pinned content."))
        }
    };
    require_actor(actor)?;
    let generated = !p["generated"].is_null();
    let g = &p["generated"];
    let audience = if generated {
        g["audience"].clone()
    } else {
        json!(normalize_audience(
            actor,
            &r["audience"]
                .as_array()
                .map(|a| a
                    .iter()
                    .map(|v| v.as_str().unwrap().to_owned())
                    .collect::<Vec<_>>())
                .unwrap_or_default()
        ))
    };
    for id in audience
        .as_array()
        .ok_or_else(|| invalid("audience is invalid."))?
    {
        require_actor(
            id.as_str()
                .ok_or_else(|| invalid("recipient is invalid."))?,
        )?;
    }
    if generated {
        let routing = &g["routing"];
        for id in array(routing, "availableRecipientIds")? {
            require_actor(
                id.as_str()
                    .ok_or_else(|| invalid("available recipient is invalid."))?,
            )?;
        }
        if routing["originalDraftId"] != g["draftId"]
            || routing["originalGenerationCommandId"] != g["generationCommandId"]
            || !routing["initialAudience"].is_null()
            || routing["correction"] != ""
            || !same(
                &g["generatedArtifact"]["provenance"]["runtimeProfile"],
                &g["runtimeProfile"],
            )
            || !array(g, "skillDigests")?.is_empty()
            || archive.command_results.iter().any(|other| {
                other.command_id == g["generationCommandId"]
                    || other.command_id != record.command_id
                        && other.canonical_input["kind"] == "accept_draft"
                        && other.canonical_input["payload"]["draftId"] == g["draftId"]
            })
        {
            return Err(invalid("generated provenance mismatch."));
        }
    }
    let owner = string(r, "ownerScope")?;
    let simulation = string(r, "simulationId")?;
    let id = string(r, "commandId")?;
    let mut message = json!({"id":domain_id("message_version",&[owner,simulation,id]),"logicalMessageId":r["logicalMessageId"],"actorId":actor,"text":if generated {g["generatedArtifact"]["text"].clone()} else {json!(string(r,"manualText")?.trim())},"audience":audience,"provenance":if generated {json!({"mode":"generated","operation":"regenerate","sourceArtifactDigest":g["generatedArtifact"]["digest"],"finalTextSource":"generated_verbatim"})} else {json!({"mode":"manual","operation":"edit"})}});
    if let Some(syntax) = r.get("audienceSyntax") {
        let identities = archive
            .content_revision
            .compiled
            .entities
            .iter()
            .filter(|e| e.kind.can_own_turn())
            .map(|e| Identity {
                id: e.id.clone(),
                name: e.name.clone(),
            })
            .collect::<Vec<_>>();
        let syntax: AudienceSyntax = codec::decode(syntax)?;
        let audience = r["audience"].as_array().map(|a| {
            a.iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        });
        let scoped = parse_performance(
            string(r, "manualText")?,
            actor,
            audience.as_deref(),
            &identities,
            syntax,
        )?;
        if scoped.actor_id != actor {
            return Err(invalid("scoped performer changed."));
        }
        message["audience"] = json!(scoped.audience);
        message["performance"] = serde_json::to_value(scoped.performance).unwrap();
    }
    let mut events = vec![json!({"type":"message_accepted","message":message})];
    if generated {
        events.push(json!({"type":"stage_whisper_consumed","whisperId":domain_id("alternative_input",&[&domain_id("saved_alternative",&[owner,simulation,id])]),"targetActorId":actor,"text":p["completeWhisper"]}));
    }
    let commit = codec::commit(&record.result["commit"])?;
    let branch = codec::branch(&record.result["branch"])?;
    if commit.id != domain_id("commit", &[owner, simulation, id])
        || commit.kind != "turn"
        || commit.parent_commit_id.as_deref() != Some(&selected.parent)
        || !same(&json!(commit.events), &json!(events))
        || branch.head_commit_id != commit.id
        || branch.name.as_deref() != Some(if generated { "regenerate" } else { "edit" })
    {
        return Err(invalid("replacement event or branch mismatch."));
    }
    Ok(())
}
