//! Structural validation for durable candidates and runtime artifacts. These
//! records contain references and provenance, never credentials or capabilities.
use crate::{
    contracts::{runtime_text, safe_identifier},
    error::{EngineError, Result},
    runtime::artifact_digest,
};
use serde_json::{Map, Value};
use std::collections::HashSet;

pub fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>> {
    value.as_object().ok_or_else(|| invalid(label))
}
fn invalid(label: &str) -> EngineError {
    EngineError::invalid(format!("{label} is invalid."))
}
pub fn text<'a>(value: &'a Value, label: &str) -> Result<&'a str> {
    value.as_str().ok_or_else(|| invalid(label))
}
pub fn exact(value: &Value, required: &[&str], optional: &[&str], label: &str) -> Result<()> {
    let value = object(value, label)?;
    if required.iter().any(|key| !value.contains_key(*key))
        || value
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(EngineError::invalid(format!(
            "{label} has unexpected fields."
        )));
    }
    Ok(())
}
pub fn identity_array(value: &Value, label: &str) -> Result<Vec<String>> {
    let values = value.as_array().ok_or_else(|| invalid(label))?;
    let mut unique = HashSet::new();
    let mut result = Vec::new();
    for value in values {
        let value = text(value, label)?;
        if safe_identifier(value, label)? != value {
            return Err(EngineError::invalid(format!("{label} is not normalized.")));
        }
        if !unique.insert(value) {
            return Err(EngineError::invalid(format!(
                "{label} contains duplicates."
            )));
        }
        result.push(value.to_owned());
    }
    Ok(result)
}
pub fn reference(value: &Value, label: &str) -> Result<()> {
    exact(value, &["id", "version"], &[], label)?;
    safe_identifier(text(&value["id"], label)?, label)?;
    safe_identifier(text(&value["version"], label)?, label)?;
    Ok(())
}
pub fn hash(value: &Value, label: &str) -> Result<()> {
    let value = text(value, label)?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(EngineError::invalid(format!(
            "{label} is not a SHA-256 digest."
        )));
    }
    Ok(())
}
pub fn valid_iso(value: &Value) -> bool {
    let Some(value) = value.as_str().filter(|s| s.len() == 24) else {
        return false;
    };
    chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|date| {
        date.to_utc()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            == value
    })
}
pub fn runtime_provenance(value: &Value, terminal: Option<&str>) -> Result<()> {
    exact(
        value,
        &[
            "adapter",
            "runtimeProfile",
            "providerId",
            "modelId",
            "usage",
            "stopReason",
            "terminalStatus",
        ],
        &[],
        "Runtime provenance",
    )?;
    reference(&value["adapter"], "Runtime adapter")?;
    reference(&value["runtimeProfile"], "Runtime profile")?;
    for key in ["providerId", "modelId"] {
        if !value[key].is_null() {
            safe_identifier(text(&value[key], key)?, key)?;
        }
    }
    let usage = &value["usage"];
    exact(
        usage,
        &["inputTokens", "outputTokens", "totalTokens"],
        &[],
        "Runtime usage",
    )?;
    let number = |key: &str| {
        usage[key]
            .as_f64()
            .filter(|n| *n >= 0.0 && *n <= 9_007_199_254_740_991.0 && n.fract() == 0.0)
            .ok_or_else(|| invalid("Runtime usage"))
    };
    let input = number("inputTokens")?;
    let output = number("outputTokens")?;
    let total = number("totalTokens")?;
    if input + output != total {
        return Err(invalid("Runtime usage total"));
    }
    if !value["stopReason"].is_null()
        && !["stop", "length", "tool_use", "error", "aborted", "other"]
            .contains(&text(&value["stopReason"], "Runtime stop reason")?)
    {
        return Err(invalid("Runtime stop reason"));
    }
    let status = text(&value["terminalStatus"], "Runtime terminal status")?;
    if !["completed", "failed"].contains(&status)
        || terminal.is_some_and(|expected| status != expected)
    {
        return Err(invalid("Runtime terminal status"));
    }
    Ok(())
}
pub fn completed_artifact(value: &Value) -> Result<()> {
    exact(
        value,
        &["text", "digest", "provenance"],
        &["proposedAudience"],
        "Generated artifact",
    )?;
    let audience = value
        .get("proposedAudience")
        .map(|v| identity_array(v, "Proposed audience"))
        .transpose()?;
    let wording = text(&value["text"], "Generated artifact text")?;
    runtime_text(wording, "Generated artifact text")?;
    hash(&value["digest"], "Generated artifact digest")?;
    if value["digest"] != artifact_digest(wording, audience.as_deref()) {
        return Err(invalid("Generated artifact digest"));
    }
    runtime_provenance(&value["provenance"], Some("completed"))?;
    if !value["provenance"]["stopReason"].is_null()
        && !["stop", "length", "other"].contains(&text(
            &value["provenance"]["stopReason"],
            "Generated artifact completion stop reason",
        )?)
    {
        return Err(invalid("Generated artifact completion stop reason"));
    }
    Ok(())
}
pub fn failure(value: &Value) -> Result<()> {
    exact(
        value,
        &["code", "message", "provenance"],
        &[],
        "Draft failure",
    )?;
    if !["runtime_failure", "invalid_stream", "output_contract"]
        .contains(&text(&value["code"], "Draft failure code")?)
    {
        return Err(invalid("Draft failure code"));
    }
    runtime_text(
        text(&value["message"], "Draft failure message")?,
        "Draft failure message",
    )?;
    runtime_provenance(&value["provenance"], Some("failed"))
}
pub fn routing_version(value: &Value) -> Result<u8> {
    match value["version"].as_f64() {
        Some(1.0) => Ok(1),
        Some(2.0) => Ok(2),
        Some(3.0) => Ok(3),
        Some(4.0) => Ok(4),
        _ => Err(EngineError::invalid("Unsupported routing version.")),
    }
}
pub fn routing_input(value: &Value) -> Result<()> {
    let version = routing_version(value)?;
    let mut required = vec![
        "version",
        "initialAudience",
        "correction",
        "correctedAudience",
        "preservedText",
        "sourceDraftId",
    ];
    if version >= 2 {
        required.push("completeWhisper");
    }
    exact(value, &required, &["audienceLimit"], "Routing input")?;
    if version >= 2
        && (text(&value["completeWhisper"], "Complete whisper")?
            .encode_utf16()
            .count()
            > 1_000_000
            || value["correction"] != "")
    {
        return Err(EngineError::invalid(
            "Complete whisper required without additive correction.",
        ));
    }
    for key in ["initialAudience", "correctedAudience"] {
        if !value[key].is_null() {
            identity_array(&value[key], key)?;
        }
    }
    if let Some(limit) = value.get("audienceLimit") {
        if version < 3
            || !value["initialAudience"].is_null()
            || !value["correctedAudience"].is_null()
            || !value["sourceDraftId"].is_null()
        {
            return Err(EngineError::invalid(
                "An audience limit requires a fresh actor choice.",
            ));
        }
        identity_array(limit, "Audience limit")?;
    }
    if text(&value["correction"], "Director correction")?
        .encode_utf16()
        .count()
        > 1_000_000
    {
        return Err(invalid("Director correction"));
    }
    if !value["sourceDraftId"].is_null() {
        safe_identifier(
            text(&value["sourceDraftId"], "Source draft")?,
            "Source draft",
        )?;
    }
    if !value["preservedText"].is_null() {
        runtime_text(
            text(&value["preservedText"], "Preserved text")?,
            "Preserved text",
        )?;
    }
    let fresh_fixed =
        version == 3 && value["initialAudience"].is_null() && !value["correctedAudience"].is_null();
    if version != 4
        && value["sourceDraftId"].is_null()
        && ((!fresh_fixed && !value["correctedAudience"].is_null())
            || !value["preservedText"].is_null()
            || value["correction"] != "")
    {
        return Err(EngineError::invalid(
            "Corrections require a source candidate.",
        ));
    }
    if version == 4
        && (!value["sourceDraftId"].is_null()
            || !value["initialAudience"].is_null()
            || !value["preservedText"].is_null())
    {
        return Err(EngineError::invalid(
            "Historical routing requires a fresh complete input and explicit or unspecified audience.",
        ));
    }
    if !value["sourceDraftId"].is_null()
        && value["correctedAudience"].is_null()
        && (version == 1 || !value["preservedText"].is_null())
    {
        return Err(EngineError::invalid(
            "Correction requires explicit recipients.",
        ));
    }
    Ok(())
}

fn common_snapshot(value: &Value, receipt: bool) -> Result<()> {
    for key in ["audience", "skillDigests"] {
        let mut seen = HashSet::new();
        for id in value[key].as_array().ok_or_else(|| invalid(key))? {
            let id = text(id, key)?;
            safe_identifier(id, key)?;
            if !seen.insert(id) {
                return Err(EngineError::invalid(format!("{key} contains duplicates.")));
            }
        }
    }
    let mut whispers = HashSet::new();
    for whisper in value["stageWhispers"]
        .as_array()
        .ok_or_else(|| invalid("Draft stage whispers"))?
    {
        exact(whisper, &["id", "text"], &[], "Draft stage whisper")?;
        if !whispers.insert(safe_identifier(
            text(&whisper["id"], "Whisper ID")?,
            "Whisper ID",
        )?) {
            return Err(invalid("Duplicate stage whispers"));
        }
        runtime_text(text(&whisper["text"], "Whisper text")?, "Whisper text")?;
    }
    reference(&value["runtimeProfile"], "Draft runtime profile")?;
    reference(&value["promptPolicy"], "Draft prompt policy")?;
    exact(
        &value["outputSchema"],
        &["id", "digest"],
        &[],
        "Draft output schema",
    )?;
    for key in ["id", "digest"] {
        safe_identifier(text(&value["outputSchema"][key], key)?, key)?;
    }
    if value["capabilityGrant"]
        .as_array()
        .is_none_or(|grant| !grant.is_empty())
    {
        return Err(invalid("Draft capability grant"));
    }
    hash(&value["contextHash"], "Draft context hash")?;
    hash(&value["promptHash"], "Draft prompt hash")?;
    if !receipt {
        runtime_text(text(&value["prompt"], "Draft prompt")?, "Draft prompt")?;
    }
    Ok(())
}
pub fn draft_record(value: &Value) -> Result<()> {
    exact(
        value,
        &[
            "id",
            "ownerScope",
            "simulationId",
            "generationCommandId",
            "branchId",
            "basisHeadCommitId",
            "contentRevisionId",
            "actorId",
            "audience",
            "stageWhispers",
            "runtimeProfile",
            "promptPolicy",
            "outputSchema",
            "skillDigests",
            "capabilityGrant",
            "context",
            "contextHash",
            "prompt",
            "promptHash",
            "status",
            "artifact",
            "failure",
            "createdAt",
            "updatedAt",
        ],
        &["routing"],
        "Actor turn draft",
    )?;
    for key in [
        "id",
        "ownerScope",
        "simulationId",
        "generationCommandId",
        "branchId",
        "basisHeadCommitId",
        "contentRevisionId",
        "actorId",
    ] {
        safe_identifier(text(&value[key], key)?, key)?;
    }
    let owner = safe_identifier(text(&value["ownerScope"], "Draft owner")?, "Draft owner")?;
    let simulation = safe_identifier(
        text(&value["simulationId"], "Draft simulation")?,
        "Draft simulation",
    )?;
    let generation = safe_identifier(
        text(&value["generationCommandId"], "Draft generation")?,
        "Draft generation",
    )?;
    if safe_identifier(text(&value["id"], "Draft ID")?, "Draft ID")?
        != crate::identity::domain_id("actor_turn_draft", &[&owner, &simulation, &generation])
    {
        return Err(EngineError::invalid(
            "Draft ID is not bound to its generation identity.",
        ));
    }
    common_snapshot(value, false)?;
    if !valid_iso(&value["createdAt"]) || !valid_iso(&value["updatedAt"]) {
        return Err(invalid("Draft timestamps"));
    }
    let artifact = &value["artifact"];
    let failed = &value["failure"];
    match text(&value["status"], "Draft status")? {
        "generating" => {
            if !artifact.is_null() || !failed.is_null() {
                return Err(invalid("Generating draft state"));
            }
        }
        "ready" | "accepted" => {
            completed_artifact(artifact)?;
            if !failed.is_null() {
                return Err(invalid("Ready draft failure state"));
            }
        }
        "failed" => {
            if !artifact.is_null() {
                return Err(invalid("Failed draft artifact state"));
            }
            failure(failed)?;
        }
        "discarded" => {
            if !artifact.is_null() {
                completed_artifact(artifact)?;
            }
            if !failed.is_null() {
                failure(failed)?;
            }
            if !artifact.is_null() && !failed.is_null() {
                return Err(invalid("Discarded draft state"));
            }
        }
        _ => return Err(invalid("Draft status")),
    }
    routing_binding(value, false)
}
pub fn accept_receipt(value: &Value) -> Result<()> {
    exact(
        value,
        &[
            "receiptVersion",
            "draftId",
            "generationCommandId",
            "contentRevisionId",
            "actorId",
            "audience",
            "stageWhispers",
            "runtimeProfile",
            "promptPolicy",
            "outputSchema",
            "skillDigests",
            "capabilityGrant",
            "contextHash",
            "promptHash",
            "generatedArtifact",
            "accepted",
        ],
        &["routing"],
        "Accept draft receipt",
    )?;
    let routed = value.get("routing").is_some();
    if !matches!(value["receiptVersion"].as_f64(), Some(1.0 | 2.0))
        || (value["receiptVersion"].as_f64() == Some(2.0)) != routed
    {
        return Err(invalid("Accept draft receipt version"));
    }
    for key in [
        "draftId",
        "generationCommandId",
        "contentRevisionId",
        "actorId",
    ] {
        safe_identifier(text(&value[key], key)?, key)?;
    }
    common_snapshot(value, true)?;
    completed_artifact(&value["generatedArtifact"])?;
    let accepted = &value["accepted"];
    let source = text(&accepted["textSource"], "Accept draft text source")?;
    match source {
        "generated_verbatim" | "director_preserved" => {
            exact(accepted, &["textSource"], &[], "Accept draft accepted text")?
        }
        "acceptor_edited" => {
            exact(
                accepted,
                &["textSource", "text"],
                &[],
                "Accept draft accepted text",
            )?;
            runtime_text(
                text(&accepted["text"], "Accept draft edited text")?,
                "Accept draft edited text",
            )?;
        }
        _ => return Err(invalid("Accept draft text source")),
    }
    if source != "acceptor_edited"
        && (source == "director_preserved") != !value["routing"]["preservedText"].is_null()
    {
        return Err(EngineError::invalid(
            "Accepted text attribution contradicts derivation.",
        ));
    }
    let mut binding = value.clone();
    binding["id"] = value["draftId"].clone();
    binding["artifact"] = value["generatedArtifact"].clone();
    routing_binding(&binding, true)
}
fn same_identities(left: &Value, right: &Value) -> bool {
    let Some(left) = left.as_array() else {
        return false;
    };
    let Some(right) = right.as_array() else {
        return false;
    };
    let left: HashSet<_> = left.iter().filter_map(Value::as_str).collect();
    let right: HashSet<_> = right.iter().filter_map(Value::as_str).collect();
    left == right
}
pub fn routing_binding(draft: &Value, receipt: bool) -> Result<()> {
    let Some(routing) = draft.get("routing") else {
        if ["audience-proposal-v1", "actor-knowledge-v1"]
            .iter()
            .any(|policy| draft["promptPolicy"]["id"] == *policy)
            || draft["outputSchema"]["id"] == "audience-proposal"
        {
            return Err(EngineError::invalid(
                "Routing policy requires routing ancestry.",
            ));
        }
        if draft["artifact"].get("proposedAudience").is_some() {
            return Err(EngineError::invalid(
                "Audience proposal requires routing policy.",
            ));
        }
        return Ok(());
    };
    let version = routing_version(routing)?;
    let mut fields = vec![
        "version",
        "initialAudience",
        "correction",
        "correctedAudience",
        "preservedText",
        "sourceDraftId",
        "availableRecipientIds",
        "originalDraftId",
        "originalGenerationCommandId",
        "source",
    ];
    if version >= 2 {
        fields.push("completeWhisper");
    }
    exact(routing, &fields, &["audienceLimit"], "Routing")?;
    let mut input = routing.clone();
    for key in [
        "availableRecipientIds",
        "originalDraftId",
        "originalGenerationCommandId",
        "source",
    ] {
        input.as_object_mut().unwrap().remove(key);
    }
    routing_input(&input)?;
    let available = identity_array(&routing["availableRecipientIds"], "Available recipients")?;
    for key in ["originalDraftId", "originalGenerationCommandId"] {
        safe_identifier(text(&routing[key], key)?, key)?;
    }
    let actor = text(&draft["actorId"], "Draft actor")?;
    if !receipt
        && routing["originalDraftId"]
            != crate::identity::domain_id(
                "actor_turn_draft",
                &[
                    text(&draft["ownerScope"], "Draft owner")?,
                    text(&draft["simulationId"], "Draft simulation")?,
                    text(
                        &routing["originalGenerationCommandId"],
                        "Original generation",
                    )?,
                ],
            )
    {
        return Err(EngineError::invalid("Original routing identity mismatch."));
    }
    let selected = if !routing["correctedAudience"].is_null() {
        &routing["correctedAudience"]
    } else {
        &routing["initialAudience"]
    };
    let selected_ids = if selected.is_null() {
        vec![]
    } else {
        identity_array(selected, "Directed recipients")?
    };
    if !receipt
        && draft["audience"]
            != serde_json::json!(crate::commands::normalize_audience(actor, &selected_ids))
    {
        return Err(EngineError::invalid("Draft direction audience mismatch."));
    }
    if !available.iter().any(|id| id == actor) {
        return Err(EngineError::invalid(
            "Actor missing from available identities.",
        ));
    }
    if let Some(limit) = routing.get("audienceLimit") {
        let limit = identity_array(limit, "Audience limit")?;
        if !same_identities(
            &routing["availableRecipientIds"],
            &serde_json::json!(crate::commands::normalize_audience(actor, &limit)),
        ) {
            return Err(EngineError::invalid(
                "Available identities exceed the audience limit.",
            ));
        }
    }
    let mut directed = selected_ids;
    if version == 1 {
        directed = Vec::new();
        for key in ["initialAudience", "correctedAudience"] {
            if !routing[key].is_null() {
                directed.extend(identity_array(&routing[key], key)?);
            }
        }
    }
    if directed.iter().any(|id| !available.contains(id)) {
        return Err(EngineError::invalid("Directed identity is unavailable."));
    }
    let policy = if version >= 3 {
        "actor-knowledge-v1"
    } else {
        "audience-proposal-v1"
    };
    if draft["promptPolicy"]["id"] != policy
        || draft["promptPolicy"]["version"] != "v1"
        || draft["outputSchema"]["id"] != "audience-proposal"
        || draft["outputSchema"]["digest"] != "v1"
    {
        return Err(EngineError::invalid("Routing policy/schema mismatch."));
    }
    if routing["sourceDraftId"].is_null() {
        if !routing["source"].is_null()
            || routing["originalDraftId"] != draft["id"]
            || routing["originalGenerationCommandId"] != draft["generationCommandId"]
        {
            return Err(EngineError::invalid(
                "Original candidate identity mismatch.",
            ));
        }
    } else {
        if routing["originalDraftId"] == draft["id"]
            || routing["originalGenerationCommandId"] == draft["generationCommandId"]
        {
            return Err(EngineError::invalid(
                "Sourced candidate cannot be its own original routing ancestor.",
            ));
        }
        let source = &routing["source"];
        exact(
            source,
            &[
                "draftId",
                "generationCommandId",
                "actorId",
                "branchId",
                "basisHeadCommitId",
                "contentRevisionId",
                "audience",
                "artifact",
                "contextHash",
                "promptHash",
            ],
            &[],
            "Routing source",
        )?;
        for key in [
            "draftId",
            "generationCommandId",
            "actorId",
            "branchId",
            "basisHeadCommitId",
            "contentRevisionId",
        ] {
            safe_identifier(text(&source[key], key)?, key)?;
        }
        identity_array(&source["audience"], "Source audience")?;
        if source["audience"].get(0) != Some(&draft["actorId"]) {
            return Err(EngineError::invalid(
                "Source audience must include its actor first.",
            ));
        }
        completed_artifact(&source["artifact"])?;
        hash(&source["contextHash"], "Source context hash")?;
        hash(&source["promptHash"], "Source prompt hash")?;
        if !receipt
            && source["draftId"]
                != crate::identity::domain_id(
                    "actor_turn_draft",
                    &[
                        text(&draft["ownerScope"], "Draft owner")?,
                        text(&draft["simulationId"], "Draft simulation")?,
                        text(&source["generationCommandId"], "Source generation")?,
                    ],
                )
        {
            return Err(EngineError::invalid("Source generation identity mismatch."));
        }
        if source["draftId"] != routing["sourceDraftId"]
            || source["draftId"] == draft["id"]
            || source["generationCommandId"] == draft["generationCommandId"]
            || (source["draftId"] == routing["originalDraftId"])
                != (source["generationCommandId"] == routing["originalGenerationCommandId"])
            || source["actorId"] != draft["actorId"]
            || source["contentRevisionId"] != draft["contentRevisionId"]
            || (!receipt
                && (source["branchId"] != draft["branchId"]
                    || source["basisHeadCommitId"] != draft["basisHeadCommitId"]))
        {
            return Err(EngineError::invalid("Routing source basis mismatch."));
        }
        if source["artifact"].get("proposedAudience") != Some(&source["audience"]) {
            return Err(EngineError::invalid("Source artifact audience mismatch."));
        }
    }
    if !draft["artifact"].is_null() {
        let proposed = draft["artifact"]
            .get("proposedAudience")
            .ok_or_else(|| invalid("Proposed recipient binding"))?;
        let proposed_ids = identity_array(proposed, "Proposed audience")?;
        if proposed_ids.first().map(String::as_str) != Some(actor)
            || proposed_ids.iter().any(|id| !available.contains(id))
        {
            return Err(invalid("Proposed recipient binding"));
        }
        if !routing["correctedAudience"].is_null()
            && !same_identities(
                proposed,
                &serde_json::json!(crate::commands::normalize_audience(
                    actor,
                    &identity_array(&routing["correctedAudience"], "Corrected recipients")?
                )),
            )
        {
            return Err(EngineError::invalid(
                "Artifact contradicts director recipients.",
            ));
        }
        if receipt && proposed != &draft["audience"] {
            return Err(EngineError::invalid(
                "Receipt audience differs from proposal.",
            ));
        }
        let p = &draft["artifact"]["provenance"];
        if !routing["preservedText"].is_null() {
            if draft["artifact"]["text"] != routing["preservedText"]
                || p["adapter"]["id"] != "director-preserved"
                || p["adapter"]["version"] != "v1"
                || !p["providerId"].is_null()
                || !p["modelId"].is_null()
                || p["usage"]["totalTokens"].as_f64() != Some(0.0)
                || p["stopReason"] != "stop"
            {
                return Err(invalid("Director-preserved artifact provenance"));
            }
        } else if p["adapter"]["id"] == "director-preserved" {
            return Err(EngineError::invalid(
                "Preserved provenance requires explicit director wording.",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{Observation, provenance};
    use serde_json::json;
    #[test]
    fn artifact_integrity_binds_wording_delivery_and_safe_completion_provenance() {
        let audience = vec!["corin".into(), "mara".into()];
        let wording = "A private word.";
        assert_eq!(
            artifact_digest(wording, Some(&audience)),
            "4eafbb4171b5926e8127d37edaf064f1c1f4028fa9b9ab81d952e9c0e580e2a8"
        );
        let mut artifact = json!({"text":wording,"proposedAudience":audience,"digest":artifact_digest(wording,Some(&audience)),"provenance":provenance(&json!({"id":"dsh","version":"v1"}),&json!({"id":"local-character","version":"v1"}),&Observation::default(),true)});
        completed_artifact(&artifact).unwrap();
        artifact["proposedAudience"] = json!(["corin", "nell"]);
        assert!(completed_artifact(&artifact).is_err());
        artifact["proposedAudience"] = json!(audience);
        artifact["provenance"]["modelId"] = json!("sk-live-secret");
        assert!(completed_artifact(&artifact).is_err());
        artifact["provenance"]["modelId"] = Value::Null;
        artifact["provenance"]["stopReason"] = json!("tool_use");
        assert!(completed_artifact(&artifact).is_err());
    }
    #[test]
    fn routing_versions_preserve_unresolved_audiences_and_forbid_invented_correction_sources() {
        let fresh = json!({"version":3,"completeWhisper":"","initialAudience":null,"correction":"","correctedAudience":null,"preservedText":null,"sourceDraftId":null});
        routing_input(&fresh).unwrap();
        let mut fixed = fresh.clone();
        fixed["correctedAudience"] = json!(["mara"]);
        routing_input(&fixed).unwrap();
        let mut preserved = fixed;
        preserved["preservedText"] = json!("Words.");
        assert!(routing_input(&preserved).is_err());
        let mut historical = fresh.clone();
        historical["version"] = json!(4);
        routing_input(&historical).unwrap();
        historical["sourceDraftId"] = json!("old-draft");
        assert!(routing_input(&historical).is_err());
        let mut limit = fresh;
        limit["audienceLimit"] = json!(["mara", "mara"]);
        assert!(routing_input(&limit).is_err());
    }
}
