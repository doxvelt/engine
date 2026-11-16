use super::{RecordedCommandResult, codec::*};
use crate::{
    commands::KNOWLEDGE_POLICY,
    contracts::{runtime_text, safe_identifier},
    draft_contracts::{self, exact, text},
    error::{EngineError, Result},
    identity::{domain_id, fingerprint},
    projection::{array, string},
};
use serde_json::{Value, json};

fn invalid(message: &str) -> EngineError {
    EngineError::invalid(format!("Persisted {message}."))
}
pub fn command(value: &Value) -> Result<()> {
    let kind = string(value, "kind")?;
    let common = [
        "kind",
        "ownerScope",
        "simulationId",
        "branchId",
        "expectedHead",
        "commandId",
        "payload",
    ];
    match kind {
        "start" => {
            let mut keys = vec![
                "kind",
                "ownerScope",
                "simulationId",
                "scenarioId",
                "defaultBranchId",
                "rootCommitId",
                "commandId",
                "sourceRoot",
            ];
            keys.push(if value.get("compiled").is_some() {
                "compiled"
            } else {
                "contentRevisionId"
            });
            exact(value, &keys, &[], "Start command")?;
            strings(
                value,
                &[
                    "ownerScope",
                    "simulationId",
                    "defaultBranchId",
                    "rootCommitId",
                    "commandId",
                    "sourceRoot",
                ],
            )?;
            nullable_text(&value["scenarioId"], "scenarioId")?;
            if value.get("compiled").is_some() {
                compiled(&value["compiled"])?;
            } else {
                string(value, "contentRevisionId")?;
            }
        }
        "turn" | "edit" | "regenerate" => {
            let sibling = kind != "turn";
            let mut keys = common.to_vec();
            if sibling {
                keys.extend(["sourceBranchId", "sourceCommitId"]);
            }
            exact(
                value,
                &keys,
                if sibling { &["branchName"] } else { &[] },
                "Turn command",
            )?;
            strings(
                value,
                &[
                    "ownerScope",
                    "simulationId",
                    "branchId",
                    "expectedHead",
                    "commandId",
                ],
            )?;
            if sibling {
                strings(value, &["sourceBranchId", "sourceCommitId"])?;
            }
            if let Some(name) = value.get("branchName") {
                text(name, "branch name")?;
            }
            manual_payload(&value["payload"], sibling)?;
        }
        "effects" | "closure" | "revise_memory" | "retract_memory" | "accept_draft"
        | "correct_turn_body" => {
            let mut keys = common.to_vec();
            if kind == "correct_turn_body" {
                keys.push("sourceBranchId");
            }
            exact(value, &keys, &[], "Commit command")?;
            strings(
                value,
                &[
                    "ownerScope",
                    "simulationId",
                    "branchId",
                    "expectedHead",
                    "commandId",
                ],
            )?;
            let payload = &value["payload"];
            match kind {
                "effects" => {
                    exact(
                        payload,
                        &[],
                        &["audienceChanges", "accessChanges"],
                        "Effects payload",
                    )?;
                    effects(payload)?;
                }
                "closure" => {
                    exact(payload, &[], &["label"], "Closure payload")?;
                    if let Some(label) = payload.get("label") {
                        nullable_text(label, "label")?;
                    }
                }
                "accept_draft" => {
                    draft_contracts::accept_receipt(payload)?;
                }
                "correct_turn_body" => {
                    string(value, "sourceBranchId")?;
                    exact(
                        payload,
                        &["messageVersionId", "text"],
                        &[],
                        "Correction payload",
                    )?;
                    strings(payload, &["messageVersionId", "text"])?;
                }
                _ => {
                    let mut fields = vec!["actorId", "memoryId"];
                    if kind == "revise_memory" {
                        fields.extend(["revisesOperationId", "content"]);
                    } else {
                        fields.push("retractsOperationId");
                    }
                    exact(payload, &fields, &[], "Memory payload")?;
                    strings(payload, &fields)?;
                }
            }
        }
        "fork" => {
            let keys = [
                "kind",
                "ownerScope",
                "simulationId",
                "sourceBranchId",
                "expectedHead",
                "atCommitId",
                "branchId",
                "commandId",
            ];
            exact(value, &keys, &["name"], "Fork command")?;
            strings(value, &keys)?;
            if let Some(name) = value.get("name") {
                nullable_text(name, "name")?;
            }
        }
        "whisper" => {
            let keys = [
                "kind",
                "ownerScope",
                "simulationId",
                "branchId",
                "expectedHead",
                "commandId",
                "targetActorId",
                "text",
            ];
            exact(value, &keys, &[], "Whisper command")?;
            strings(value, &keys)?;
        }
        "saved_alternative" => alternative_command(value)?,
        _ => return Err(invalid("command kind is invalid")),
    }
    Ok(())
}
fn manual_payload(value: &Value, sibling: bool) -> Result<()> {
    let mut optional = vec![
        "logicalMessageId",
        "operation",
        "audienceChanges",
        "accessChanges",
        "stageWhisper",
        "stageWhisperIds",
        "audienceSyntax",
    ];
    if !sibling || value.get("audienceSyntax").is_some() {
        optional.push("knowledgePolicy");
    }
    exact(
        value,
        &["actorId", "text", "audience"],
        &optional,
        "Manual payload",
    )?;
    strings(value, &["actorId", "text"])?;
    if let Some(policy) = value.get("knowledgePolicy") {
        enumeration(policy, &[KNOWLEDGE_POLICY], "knowledge policy")?;
    }
    if let Some(syntax) = value.get("audienceSyntax") {
        enumeration(
            syntax,
            &["scoped-v1", "scoped-fallback-v1"],
            "audience syntax",
        )?;
        if value["knowledgePolicy"] != KNOWLEDGE_POLICY {
            return Err(invalid("scoped authoring requires actor knowledge"));
        }
    }
    if !value["audience"].is_null() || value.get("audienceSyntax").is_none() {
        string_array(&value["audience"], "audience")?;
    }
    if let Some(id) = value.get("logicalMessageId") {
        text(id, "logical message")?;
    }
    if let Some(operation) = value.get("operation") {
        enumeration(operation, &["turn", "edit", "regenerate"], "operation")?;
    }
    if let Some(whisper) = value.get("stageWhisper") {
        nullable_text(whisper, "stage whisper")?;
    }
    if let Some(ids) = value.get("stageWhisperIds") {
        string_array(ids, "whisper IDs")?;
    }
    effects(value)
}
fn effects(value: &Value) -> Result<()> {
    for (key, fields) in [
        ("audienceChanges", &["actorId", "action", "reason"][..]),
        (
            "accessChanges",
            &["action", "member", "container", "reason"][..],
        ),
    ] {
        if let Some(values) = value.get(key) {
            for change in values
                .as_array()
                .ok_or_else(|| invalid("effects array is invalid"))?
            {
                exact(change, fields, &[], "Effect")?;
                nullable_text(&change["reason"], "effect reason")?;
                if key == "audienceChanges" {
                    string(change, "actorId")?;
                    enumeration(
                        &change["action"],
                        &["add", "remove", "deactivate", "reactivate"],
                        "audience action",
                    )?;
                } else {
                    strings(change, &["member", "container"])?;
                    enumeration(&change["action"], &["grant", "revoke"], "access action")?;
                }
            }
        }
    }
    Ok(())
}
pub fn outcome(value: &Value) -> Result<()> {
    match string(value, "kind")? {
        "start" => {
            exact(
                value,
                &["kind", "simulation", "branch", "root"],
                &["contentRevision"],
                "Start outcome",
            )?;
            simulation(&value["simulation"])?;
            branch(&value["branch"])?;
            commit(&value["root"])?;
            if let Some(r) = value.get("contentRevision") {
                revision(r)?;
            }
        }
        "commit" => {
            exact(value, &["kind", "branch", "commit"], &[], "Commit outcome")?;
            branch(&value["branch"])?;
            commit(&value["commit"])?;
        }
        "branch" => {
            exact(value, &["kind", "branch"], &[], "Branch outcome")?;
            branch(&value["branch"])?;
        }
        "whisper" => {
            exact(value, &["kind", "whisper"], &[], "Whisper outcome")?;
            whisper(&value["whisper"])?;
        }
        _ => return Err(invalid("outcome kind is invalid")),
    }
    Ok(())
}
/// Decode the cache before trusting its fingerprint or identities. These checks
/// are shared by export and full archive validation.
pub fn command_result(record: &RecordedCommandResult) -> Result<()> {
    let input = &record.canonical_input;
    let result = &record.result;
    command(input)?;
    outcome(result)?;
    if input["commandId"] != record.command_id || fingerprint(input) != record.fingerprint {
        return Err(invalid("command fingerprint or identity mismatch"));
    }
    let expected = match string(input, "kind")? {
        "start" => "start",
        "fork" => "branch",
        "whisper" => "whisper",
        _ => "commit",
    };
    if result["kind"] != expected {
        return Err(invalid("command and outcome kinds do not match"));
    }
    let owner = &input["ownerScope"];
    let simulation = &input["simulationId"];
    let scope =
        |record: &Value| record["ownerScope"] == *owner && record["simulationId"] == *simulation;
    match expected {
        "start" => {
            if result["simulation"]["ownerScope"] != *owner
                || result["simulation"]["id"] != *simulation
                || !scope(&result["branch"])
                || result["branch"]["id"] != input["defaultBranchId"]
                || !scope(&result["root"])
                || result["root"]["id"] != input["rootCommitId"]
                || result["root"]["commandId"] != input["commandId"]
                || !result["root"]["parentCommitId"].is_null()
                || result
                    .get("contentRevision")
                    .is_some_and(|r| r["ownerScope"] != *owner)
            {
                return Err(invalid("start outcome identity mismatch"));
            }
        }
        "commit" => {
            if !scope(&result["branch"])
                || result["branch"]["id"] != input["branchId"]
                || !scope(&result["commit"])
                || result["commit"]["commandId"] != input["commandId"]
            {
                return Err(invalid("commit outcome identity mismatch"));
            }
        }
        "branch" => {
            if !scope(&result["branch"])
                || result["branch"]["id"] != input["branchId"]
                || result["branch"]["origin"]["commandId"] != input["commandId"]
            {
                return Err(invalid("branch outcome identity mismatch"));
            }
        }
        _ => {
            if !scope(&result["whisper"])
                || result["whisper"]["branchId"] != input["branchId"]
                || result["whisper"]["commandId"] != input["commandId"]
            {
                return Err(invalid("whisper outcome identity mismatch"));
            }
        }
    }
    Ok(())
}

pub fn alternative_request(value: &Value) -> Result<()> {
    let required = [
        "ownerScope",
        "simulationId",
        "commandId",
        "sourceBranchId",
        "expectedHead",
        "sourceCommitId",
        "messageVersionId",
        "logicalMessageId",
        "actorId",
        "action",
        "audience",
    ];
    exact(
        value,
        &required,
        &[
            "completeWhisper",
            "manualText",
            "retryOf",
            "replacementActorId",
            "audienceLimit",
            "actorProfile",
            "audienceSyntax",
        ],
        "Historical request",
    )?;
    for key in &required[..9] {
        safe_identifier(string(value, key)?, key)?;
    }
    enumeration(
        &value["action"],
        &["generate", "manual"],
        "historical action",
    )?;
    if !value["audience"].is_null() {
        draft_contracts::identity_array(&value["audience"], "Historical audience")?;
    }
    let generated = value["action"] == "generate";
    if let Some(limit) = value.get("audienceLimit") {
        if !generated || !value["audience"].is_null() {
            return Err(invalid("historical audience limit requires actor choice"));
        }
        draft_contracts::identity_array(limit, "Historical audience limit")?;
    }
    if let Some(whisper) = value.get("completeWhisper") {
        if text(whisper, "complete whisper")?.encode_utf16().count() > 100_000 {
            return Err(invalid("complete whisper exceeds bounds"));
        }
    }
    for key in ["retryOf", "replacementActorId"] {
        if let Some(id) = value.get(key) {
            safe_identifier(text(id, key)?, key)?;
        }
    }
    if let Some(profile) = value.get("actorProfile") {
        if !generated {
            return Err(invalid("manual alternative cannot use an actor profile"));
        }
        draft_contracts::reference(profile, "Actor profile")?;
    }
    if generated {
        if value.get("manualText").is_some() || value.get("audienceSyntax").is_some() {
            return Err(invalid("generation cannot supply manual authoring"));
        }
    } else {
        if let Some(syntax) = value.get("audienceSyntax") {
            enumeration(
                syntax,
                &["scoped-v1", "scoped-fallback-v1"],
                "audience syntax",
            )?;
        }
        runtime_text(
            text(&value["manualText"], "Manual performance")?,
            "Manual performance",
        )?;
        if (value["audience"].is_null() && value.get("audienceSyntax").is_none())
            || value.get("completeWhisper").is_some()
            || value.get("retryOf").is_some()
        {
            return Err(invalid(
                "manual alternative requires audience and performance only",
            ));
        }
    }
    Ok(())
}
fn alternative_id(request: &Value) -> Result<String> {
    Ok(domain_id(
        "saved_alternative",
        &[
            string(request, "ownerScope")?,
            string(request, "simulationId")?,
            string(request, "commandId")?,
        ],
    ))
}
fn alternative_command(value: &Value) -> Result<()> {
    exact(
        value,
        &[
            "kind",
            "ownerScope",
            "simulationId",
            "commandId",
            "branchId",
            "sourceBranchId",
            "expectedHead",
            "sourceCommitId",
            "payload",
        ],
        &[],
        "Historical command",
    )?;
    let p = &value["payload"];
    let r = &p["request"];
    exact(
        p,
        &[
            "version",
            "request",
            "parentCommitId",
            "contentRevisionId",
            "completeWhisper",
            "origin",
            "generated",
            "retrySource",
        ],
        &[],
        "Historical receipt",
    )?;
    alternative_request(r)?;
    exact(
        &p["origin"],
        &[
            "kind",
            "state",
            "completeWhisper",
            "recordedWhispers",
            "legacyCorrection",
        ],
        &["actorProfile"],
        "Historical origin",
    )?;
    if let Some(profile) = p["origin"].get("actorProfile") {
        draft_contracts::reference(profile, "Origin actor profile")?;
    }
    if p["version"].as_f64() != Some(1.0)
        || [
            "ownerScope",
            "simulationId",
            "commandId",
            "sourceBranchId",
            "sourceCommitId",
            "expectedHead",
        ]
        .iter()
        .any(|key| value[*key] != r[*key])
        || value["branchId"]
            != domain_id(
                "alternative_branch",
                &[
                    string(r, "ownerScope")?,
                    string(r, "simulationId")?,
                    string(r, "commandId")?,
                ],
            )
    {
        return Err(invalid("historical receipt identity mismatch"));
    }
    if r.get("retryOf").is_some() {
        let retry = &p["retrySource"];
        exact(
            retry,
            &["request", "promptHash", "contextHash"],
            &[],
            "Historical retry",
        )?;
        let source = &retry["request"];
        alternative_request(source)?;
        let strip = |value: &Value| {
            let mut v = value.clone();
            let o = v.as_object_mut().unwrap();
            o.remove("commandId");
            o.remove("retryOf");
            v
        };
        if alternative_id(source)? != r["retryOf"]
            || source["commandId"] == r["commandId"]
            || fingerprint(&strip(source)) != fingerprint(&strip(r))
            || ["promptHash", "contextHash"]
                .iter()
                .any(|key| !retry[*key].is_null() && retry[*key] != p["generated"][*key])
        {
            return Err(invalid("historical retry receipt mismatch"));
        }
    } else if !p["retrySource"].is_null() {
        return Err(invalid("unexpected historical retry provenance"));
    }
    safe_identifier(string(p, "parentCommitId")?, "parent")?;
    safe_identifier(string(p, "contentRevisionId")?, "content revision")?;
    if r["action"] == "generate" {
        let g = &p["generated"];
        let routing = &g["routing"];
        draft_contracts::accept_receipt(g)?;
        let generation = domain_id("alternative_generation", &[&alternative_id(r)?]);
        let profile = r
            .get("actorProfile")
            .cloned()
            .unwrap_or_else(|| json!({"id":"local-character","version":"v1"}));
        if !p["completeWhisper"].is_string()
            || routing["version"].as_f64() != Some(4.0)
            || routing["completeWhisper"] != p["completeWhisper"]
            || !routing["source"].is_null()
            || !routing["sourceDraftId"].is_null()
            || !routing["preservedText"].is_null()
            || !array(g, "stageWhispers")?.is_empty()
            || g["actorId"] != *r.get("replacementActorId").unwrap_or(&r["actorId"])
            || g["contentRevisionId"] != p["contentRevisionId"]
            || fingerprint(&g["runtimeProfile"]) != fingerprint(&profile)
            || g["generatedArtifact"]["provenance"]["stopReason"] == "length"
            || g["accepted"]["textSource"] != "generated_verbatim"
            || routing["correctedAudience"] != r["audience"]
            || routing["audienceLimit"] != r["audienceLimit"]
            || g["generationCommandId"] != generation
            || g["draftId"]
                != domain_id(
                    "actor_turn_draft",
                    &[
                        string(r, "ownerScope")?,
                        string(r, "simulationId")?,
                        &generation,
                    ],
                )
        {
            return Err(invalid("historical generated receipt mismatch"));
        }
    } else if !p["generated"].is_null() || !p["completeWhisper"].is_null() {
        return Err(invalid("manual alternative claims generation"));
    }
    Ok(())
}
