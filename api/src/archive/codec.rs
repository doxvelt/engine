//! Strict durable record decoding. Unlike runtime identity contracts these
//! legacy archive strings are not constrained to the runtime identifier alphabet.
use crate::{
    audience::ScopedPerformance,
    content::CompiledWorkspace,
    draft_contracts::{exact, text},
    error::{EngineError, Result},
    model::{Branch, Commit, ContentRevision, Simulation},
    projection::{array, string},
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashSet;

fn invalid(label: &str) -> EngineError {
    EngineError::invalid(format!("Persisted {label} is invalid."))
}
pub fn decode<T: DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone())
        .map_err(|e| EngineError::invalid(format!("Persisted record structure is invalid: {e}")))
}
pub fn strings(value: &Value, keys: &[&str]) -> Result<()> {
    for key in keys {
        string(value, key)?;
    }
    Ok(())
}
pub fn nullable_text(value: &Value, label: &str) -> Result<()> {
    if !value.is_null() {
        text(value, label)?;
    }
    Ok(())
}
pub fn string_array(value: &Value, label: &str) -> Result<()> {
    for value in value.as_array().ok_or_else(|| invalid(label))? {
        text(value, label)?;
    }
    Ok(())
}
pub fn enumeration(value: &Value, choices: &[&str], label: &str) -> Result<()> {
    if !choices.contains(&text(value, label)?) {
        return Err(invalid(label));
    }
    Ok(())
}
fn number(value: &Value, label: &str) -> Result<()> {
    if !value.is_number() {
        return Err(invalid(label));
    }
    Ok(())
}
fn metadata(value: &Value) -> Result<()> {
    for value in value
        .as_object()
        .ok_or_else(|| invalid("frontmatter"))?
        .values()
    {
        if !(value.is_null()
            || value.is_string()
            || value.is_boolean()
            || value
                .as_array()
                .is_some_and(|a| a.iter().all(Value::is_string)))
        {
            return Err(invalid("frontmatter value"));
        }
    }
    Ok(())
}
pub fn compiled(value: &Value) -> Result<CompiledWorkspace> {
    let result: CompiledWorkspace = decode(value)?;
    for key in ["models", "worlds", "scenarios", "formats", "connections"] {
        for asset in array(value, key)? {
            enumeration(
                &asset["kind"],
                &["model", "world", "scenario", "format", "connection"],
                "asset kind",
            )?;
            metadata(&asset["metadata"])?;
        }
    }
    for entity in array(value, "entities")? {
        if let Some(raw) = entity.get("rawKind") {
            metadata(&serde_json::json!({"rawKind": raw}))?;
        }
    }
    for line in array(value, "taggedLines")? {
        let context = &line["context"];
        if context.get("connectionId").is_some() {
            exact(context, &["connectionId"], &[], "Tagged-line context")?;
            strings(context, &["connectionId"])?;
        } else {
            exact(context, &["holder", "section"], &[], "Tagged-line context")?;
            strings(context, &["holder", "section"])?;
        }
    }
    for link in array(value, "accessLinks")? {
        enumeration(&link["mode"], &["member"], "access mode")?;
    }
    for diagnostic in array(value, "diagnostics")? {
        enumeration(
            &diagnostic["severity"],
            &["warning", "error"],
            "diagnostic severity",
        )?;
    }
    Ok(result)
}
pub fn revision(value: &Value) -> Result<ContentRevision> {
    let result = decode(value)?;
    compiled(&value["compiled"])?;
    Ok(result)
}
pub fn scoped_performance(value: &Value) -> Result<()> {
    // Option<T> permits absent fields in serde; the portable contract requires
    // explicit null for unresolved audiences and missing fallbacks.
    exact(
        value,
        &["version", "syntax", "baseAudience", "spans", "projections"],
        &[],
        "Scoped performance",
    )?;
    let performance: ScopedPerformance = decode(value)?;
    if performance.version != 1 {
        return Err(invalid("scoped performance version"));
    }
    let ids = |values: &Option<Vec<String>>| -> Result<()> {
        if let Some(values) = values {
            let unique: HashSet<_> = values.iter().collect();
            if values.iter().any(String::is_empty) || unique.len() != values.len() {
                return Err(invalid("scoped audience"));
            }
        }
        Ok(())
    };
    ids(&performance.base_audience)?;
    for span in array(value, "spans")? {
        exact(
            span,
            &["audience", "primary", "fallback"],
            &[],
            "Performance span",
        )?;
    }
    for span in &performance.spans {
        ids(&span.audience)?;
    }
    let mut actors = HashSet::new();
    for projection in &performance.projections {
        if projection.actor_id.is_empty()
            || projection.text.trim().is_empty()
            || !actors.insert(&projection.actor_id)
        {
            return Err(invalid("character projection"));
        }
    }
    Ok(())
}
pub fn branch(value: &Value) -> Result<Branch> {
    exact(
        value,
        &[
            "id",
            "ownerScope",
            "simulationId",
            "name",
            "headCommitId",
            "origin",
            "createdAt",
        ],
        &[],
        "Branch",
    )?;
    decode(value)
}
pub fn simulation(value: &Value) -> Result<Simulation> {
    exact(
        value,
        &[
            "id",
            "ownerScope",
            "contentRevisionId",
            "sourceRoot",
            "scenarioId",
            "defaultBranchId",
            "createdAt",
        ],
        &[],
        "Simulation",
    )?;
    decode(value)
}
pub fn commit(value: &Value) -> Result<Commit> {
    exact(
        value,
        &[
            "id",
            "ownerScope",
            "simulationId",
            "parentCommitId",
            "kind",
            "commandId",
            "events",
            "createdAt",
        ],
        &[],
        "Commit",
    )?;
    let result: Commit = decode(value)?;
    enumeration(
        &value["kind"],
        &["root", "turn", "effects", "episode_closure", "memory"],
        "commit kind",
    )?;
    for event in &result.events {
        runtime_event(event)?;
    }
    Ok(result)
}
pub fn whisper(value: &Value) -> Result<()> {
    let keys = [
        "id",
        "simulationId",
        "ownerScope",
        "branchId",
        "expectedHead",
        "commandId",
        "targetActorId",
        "text",
        "createdAt",
    ];
    exact(value, &keys, &[], "Whisper")?;
    strings(value, &keys)
}
pub fn runtime_event(value: &Value) -> Result<()> {
    match string(value, "type")? {
        "message_accepted" => {
            exact(value, &["type", "message"], &[], "Accepted message event")?;
            message(&value["message"])?;
        }
        "message_body_corrected" => {
            exact(
                value,
                &["type", "messageVersionId", "text"],
                &["performance"],
                "Body correction event",
            )?;
            strings(value, &["messageVersionId", "text"])?;
            if let Some(p) = value.get("performance") {
                scoped_performance(p)?;
            }
        }
        "audience_changed" => {
            exact(
                value,
                &["type", "actorId", "action", "reason"],
                &[],
                "Audience event",
            )?;
            string(value, "actorId")?;
            enumeration(
                &value["action"],
                &["add", "remove", "deactivate", "reactivate"],
                "audience action",
            )?;
            nullable_text(&value["reason"], "audience reason")?;
        }
        "access_changed" => {
            exact(
                value,
                &["type", "action", "member", "container", "mode", "reason"],
                &[],
                "Access event",
            )?;
            strings(value, &["member", "container"])?;
            enumeration(&value["action"], &["grant", "revoke"], "access action")?;
            enumeration(&value["mode"], &["member"], "access mode")?;
            nullable_text(&value["reason"], "access reason")?;
        }
        "first_impression_formed" => {
            exact(value, &["type", "impression"], &[], "Impression event")?;
            impression(&value["impression"], false)?;
        }
        "stage_whisper_consumed" => {
            exact(
                value,
                &["type", "whisperId", "targetActorId", "text"],
                &[],
                "Whisper event",
            )?;
            strings(value, &["whisperId", "targetActorId", "text"])?;
        }
        "episode_closed" => {
            exact(value, &["type", "closure"], &[], "Closure event")?;
            closure(&value["closure"])?;
        }
        "memory_operation" => {
            exact(value, &["type", "operation"], &[], "Memory event")?;
            memory_operation(&value["operation"])?;
        }
        _ => return Err(invalid("runtime event type")),
    }
    Ok(())
}
fn message(value: &Value) -> Result<()> {
    exact(
        value,
        &[
            "id",
            "logicalMessageId",
            "actorId",
            "text",
            "audience",
            "provenance",
        ],
        &["performance"],
        "Message",
    )?;
    strings(value, &["id", "logicalMessageId", "actorId", "text"])?;
    string_array(&value["audience"], "message audience")?;
    if let Some(p) = value.get("performance") {
        scoped_performance(p)?;
    }
    let provenance = &value["provenance"];
    match string(provenance, "mode")? {
        "manual" => {
            exact(provenance, &["mode", "operation"], &[], "Manual provenance")?;
            enumeration(
                &provenance["operation"],
                &["turn", "edit", "regenerate"],
                "manual operation",
            )?;
        }
        "generated" => {
            exact(
                provenance,
                &[
                    "mode",
                    "operation",
                    "sourceArtifactDigest",
                    "finalTextSource",
                ],
                &[],
                "Generated provenance",
            )?;
            enumeration(
                &provenance["operation"],
                &["turn", "regenerate"],
                "generated operation",
            )?;
            string(provenance, "sourceArtifactDigest")?;
            enumeration(
                &provenance["finalTextSource"],
                &[
                    "generated_verbatim",
                    "director_preserved",
                    "acceptor_edited",
                ],
                "final text source",
            )?;
        }
        _ => return Err(invalid("message mode")),
    }
    Ok(())
}
fn source_span(value: &Value) -> Result<()> {
    exact(value, &["file", "line", "quote"], &[], "Source span")?;
    strings(value, &["file", "quote"])?;
    number(&value["line"], "source span line")
}
fn impression(value: &Value, complete: bool) -> Result<()> {
    let mut keys = vec![
        "holder",
        "observerId",
        "entityId",
        "strength",
        "propositionText",
        "surfaceSourceSpan",
    ];
    let mut string_keys = vec!["holder", "observerId", "entityId", "propositionText"];
    if complete {
        keys.extend(["id", "simulationId", "createdAt"]);
        string_keys.extend(["id", "simulationId", "createdAt"]);
    }
    exact(value, &keys, &[], "Impression")?;
    strings(value, &string_keys)?;
    number(&value["strength"], "impression strength")?;
    source_span(&value["surfaceSourceSpan"])
}
fn source_belief(value: &Value) -> Result<()> {
    if value.get("memoryId").is_some() {
        extracted_belief(value)
    } else if value.get("observerId").is_some() {
        impression(value, true)
    } else {
        exact(
            value,
            &[
                "holder",
                "strength",
                "propositionText",
                "mentions",
                "sourceSpan",
            ],
            &[],
            "Authored belief",
        )?;
        strings(value, &["holder", "propositionText"])?;
        number(&value["strength"], "belief strength")?;
        string_array(&value["mentions"], "belief mentions")?;
        source_span(&value["sourceSpan"])
    }
}
fn extracted_belief(value: &Value) -> Result<()> {
    let keys = [
        "id",
        "episodeId",
        "memoryId",
        "simulationId",
        "holder",
        "propositionText",
        "createdAt",
    ];
    let mut required = keys.to_vec();
    required.push("strength");
    exact(value, &required, &[], "Extracted belief")?;
    strings(value, &keys)?;
    number(&value["strength"], "belief strength")
}
pub fn closure(value: &Value) -> Result<()> {
    exact(
        value,
        &[
            "episode",
            "memories",
            "longTermMemories",
            "extractedBeliefs",
            "retainedBeliefs",
        ],
        &["memoryOperations"],
        "Closure",
    )?;
    let episode = &value["episode"];
    exact(
        episode,
        &["id", "simulationId", "commitId", "label", "closedAt"],
        &[],
        "Episode",
    )?;
    strings(episode, &["id", "simulationId", "commitId", "closedAt"])?;
    nullable_text(&episode["label"], "episode label")?;
    for memory in array(value, "memories")? {
        exact(
            memory,
            &[
                "id",
                "episodeId",
                "simulationId",
                "actorId",
                "text",
                "sourceTurnIds",
                "createdAt",
            ],
            &[
                "sourcePerceptionIds",
                "sourceEventIds",
                "sourceMessageVersionIds",
            ],
            "Episode memory",
        )?;
        strings(
            memory,
            &[
                "id",
                "episodeId",
                "simulationId",
                "actorId",
                "text",
                "createdAt",
            ],
        )?;
        string_array(&memory["sourceTurnIds"], "source turn IDs")?;
        for key in [
            "sourcePerceptionIds",
            "sourceEventIds",
            "sourceMessageVersionIds",
        ] {
            if let Some(v) = memory.get(key) {
                string_array(v, key)?;
            }
        }
    }
    for memory in array(value, "longTermMemories")? {
        let keys = [
            "id",
            "episodeId",
            "episodeMemoryId",
            "simulationId",
            "actorId",
            "text",
            "createdAt",
        ];
        exact(memory, &keys, &[], "Long-term memory")?;
        strings(memory, &keys)?;
    }
    for belief in array(value, "extractedBeliefs")? {
        extracted_belief(belief)?;
    }
    for belief in array(value, "retainedBeliefs")? {
        exact(
            belief,
            &[
                "id",
                "episodeId",
                "simulationId",
                "holder",
                "strength",
                "propositionText",
                "sourceHolder",
                "accessPath",
                "sourceBelief",
                "runtimeAccessEventId",
                "createdAt",
            ],
            &[],
            "Retained belief",
        )?;
        strings(
            belief,
            &[
                "id",
                "episodeId",
                "simulationId",
                "holder",
                "propositionText",
                "sourceHolder",
                "runtimeAccessEventId",
                "createdAt",
            ],
        )?;
        number(&belief["strength"], "retained belief strength")?;
        string_array(&belief["accessPath"], "retained belief access path")?;
        source_belief(&belief["sourceBelief"])?;
    }
    if let Some(ops) = value.get("memoryOperations") {
        for op in ops.as_array().ok_or_else(|| invalid("memory operations"))? {
            memory_operation(op)?;
        }
    }
    Ok(())
}
pub fn memory_operation(value: &Value) -> Result<()> {
    let kind = string(value, "type")?;
    let tail: &[&str] = match kind {
        "asserted" => &["content"],
        "consolidated" => &["content", "episodeMemoryId"],
        "revised" => &["content", "revisesOperationId"],
        "retracted" => &["retractsOperationId"],
        _ => return Err(invalid("memory operation type")),
    };
    let mut keys = vec![
        "id",
        "memoryId",
        "simulationId",
        "actorId",
        "memoryKind",
        "type",
        "basisCommitId",
        "closureCommitId",
        "sourcePerceptionIds",
        "sourceEventIds",
        "sourceMessageVersionIds",
        "producer",
        "createdAt",
    ];
    keys.extend(tail);
    exact(value, &keys, &[], "Memory operation")?;
    strings(
        value,
        &[
            "id",
            "memoryId",
            "simulationId",
            "actorId",
            "basisCommitId",
            "createdAt",
        ],
    )?;
    strings(value, tail)?;
    nullable_text(&value["closureCommitId"], "closure commit")?;
    enumeration(
        &value["memoryKind"],
        &["episode", "long_term"],
        "memory kind",
    )?;
    for key in [
        "sourcePerceptionIds",
        "sourceEventIds",
        "sourceMessageVersionIds",
    ] {
        string_array(&value[key], key)?;
    }
    exact(
        &value["producer"],
        &["mode", "commandId"],
        &[],
        "Memory producer",
    )?;
    enumeration(
        &value["producer"]["mode"],
        &["episode_closure", "manual", "legacy_closure"],
        "memory producer mode",
    )?;
    string(&value["producer"], "commandId")?;
    Ok(())
}
