//! Recipient eligibility comes from authorized context and explicit direction;
//! a mention does not grant observation, private knowledge or delivery.
use crate::{
    commands::{compiled, normalize_audience},
    context::{ContextOptions, inspect_actor_context, render_belief_access},
    draft_contracts::{identity_array, routing_input, routing_version},
    error::{EngineError, Result},
    identity::{fingerprint, sha256},
    model::Command,
    ports::SimulationReader,
    projection::{array, project_branch, string},
    runtime::{artifact_digest, canonical_context},
};
use regex::Regex;
use serde_json::{Value, json};
use std::{collections::HashSet, sync::LazyLock};

pub struct RoutingContext {
    pub context: Value,
    pub prompt: String,
    pub context_hash: String,
    pub prompt_hash: String,
    pub available_recipient_ids: Vec<String>,
}
pub fn routing_direction(routing: &Value) -> Result<Value> {
    let version = routing_version(routing)?;
    let mut input = json!({"version":version,"initialAudience":routing["initialAudience"],"correction":routing["correction"],"correctedAudience":routing["correctedAudience"],"preservedText":routing["preservedText"],"sourceDraftId":routing["sourceDraftId"]});
    if version >= 2 {
        input["completeWhisper"] = routing["completeWhisper"].clone();
    }
    if let Some(limit) = routing.get("audienceLimit") {
        input["audienceLimit"] = limit.clone();
    }
    Ok(input)
}
pub fn final_draft_audience(draft: &Value) -> &Value {
    if draft.get("routing").is_some() {
        draft["artifact"]
            .get("proposedAudience")
            .unwrap_or(&draft["audience"])
    } else {
        &draft["audience"]
    }
}
pub fn complete_whisper_for_draft(draft: &Value) -> Result<Option<String>> {
    if draft.get("routing").is_some() && routing_version(&draft["routing"])? >= 2 {
        return Ok(Some(
            string(&draft["routing"], "completeWhisper")?.to_owned(),
        ));
    }
    let whispers = array(draft, "stageWhispers")?;
    if !draft["routing"]["sourceDraftId"].is_null() || whispers.len() > 1 {
        return Ok(None);
    }
    Ok(Some(
        whispers
            .first()
            .map(|whisper| string(whisper, "text"))
            .transpose()?
            .unwrap_or("")
            .to_owned(),
    ))
}
pub fn prepare_routing(
    reader: &impl SimulationReader,
    command: &Command,
    available: &[String],
) -> Result<Value> {
    let input = &command.payload["routing"];
    routing_input(input)?;
    let version = routing_version(input)?;
    let id = crate::identity::domain_id(
        "actor_turn_draft",
        &[
            &command.owner_scope,
            &command.simulation_id,
            &command.command_id,
        ],
    );
    let source = if input["sourceDraftId"].is_null() {
        None
    } else {
        reader.actor_draft(
            &command.owner_scope,
            &command.simulation_id,
            string(input, "sourceDraftId")?,
        )?
    };
    if !input["sourceDraftId"].is_null()
        && source.as_ref().is_none_or(|draft| {
            draft.get("routing").is_none()
                || draft["artifact"].is_null()
                || !["ready", "discarded"].contains(&draft["status"].as_str().unwrap_or_default())
        })
    {
        return Err(EngineError::invalid(
            "Correction requires a ready routed source candidate.",
        ));
    }
    if let Some(source) = &source {
        let whisper_ids = array(source, "stageWhispers")?
            .iter()
            .map(|whisper| &whisper["id"])
            .collect::<Vec<_>>();
        if source["actorId"] != command.payload["actorId"]
            || source["branchId"] != command.branch_id
            || source["basisHeadCommitId"] != command.expected_head
            || json!(whisper_ids) != command.payload["stageWhisperIds"]
            || source["routing"]["initialAudience"] != input["initialAudience"]
        {
            return Err(EngineError::invalid(
                "Correction must retain source actor, basis, original audience direction and whispers.",
            ));
        }
        if version >= 2
            && !input["preservedText"].is_null()
            && complete_whisper_for_draft(source)?.as_deref()
                != Some(string(input, "completeWhisper")?)
        {
            return Err(EngineError::invalid(
                "Preserved performance cannot apply a changed or unresolved whisper.",
            ));
        }
    }
    let mut routing = input.clone();
    routing["availableRecipientIds"] = json!(available);
    routing["originalDraftId"] = source
        .as_ref()
        .map(|s| s["routing"]["originalDraftId"].clone())
        .unwrap_or(json!(id));
    routing["originalGenerationCommandId"] = source
        .as_ref()
        .map(|s| s["routing"]["originalGenerationCommandId"].clone())
        .unwrap_or(json!(command.command_id));
    routing["source"]=source.map(|source| json!({"draftId":source["id"],"generationCommandId":source["generationCommandId"],"actorId":source["actorId"],"branchId":source["branchId"],"basisHeadCommitId":source["basisHeadCommitId"],"contentRevisionId":source["contentRevisionId"],"audience":final_draft_audience(&source),"artifact":source["artifact"],"contextHash":source["contextHash"],"promptHash":source["promptHash"]})).unwrap_or(Value::Null);
    Ok(routing)
}
fn contains_label(text: &str, label: &str) -> bool {
    static BOUNDARY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}_-]$").unwrap());
    text.match_indices(label).any(|(index, _)| {
        let before = text[..index].chars().next_back();
        let after = text[index + label.len()..].chars().next();
        before.is_none_or(|c| !BOUNDARY.is_match(&c.to_string()))
            && after.is_none_or(|c| !BOUNDARY.is_match(&c.to_string()))
    })
}
fn add(ids: &mut Vec<String>, id: &str) {
    if !ids.iter().any(|previous| previous == id) {
        ids.push(id.into());
    }
}
fn json(value: &Value) -> String {
    serde_json::to_string(value).expect("JSON projection")
}
pub fn captured_episode_recall(context: &Value) -> Result<Option<Value>> {
    let Some(recall) = context.get("episodeRecall") else {
        return Ok(None);
    };
    let entries = recall
        .as_array()
        .ok_or_else(|| EngineError::invalid("Draft memory context is invalid."))?;
    for entry in entries {
        for key in ["publicationId", "label", "text"] {
            string(entry, key)
                .map_err(|_| EngineError::invalid("Draft memory context is invalid."))?;
        }
    }
    Ok(Some(recall.clone()))
}
pub fn project_routing_context(
    reader: &impl SimulationReader,
    command: &Command,
    whispers: &[Value],
    source: Option<&Value>,
    episode_recall: Option<&Value>,
) -> Result<RoutingContext> {
    static MENTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"@([a-zA-Z0-9_-]+)").unwrap());
    let input = &command.payload["routing"];
    routing_input(input)?;
    let version = routing_version(input)?;
    let actor = string(&command.payload, "actorId")?;
    let p = project_branch(
        reader,
        &command.owner_scope,
        &command.simulation_id,
        &command.branch_id,
        Some(&command.expected_head),
    )?;
    let active = p
        .audience
        .iter()
        .filter(|a| a["status"] == "active")
        .map(|a| string(a, "actorId").map(str::to_owned))
        .collect::<Result<Vec<_>>>()?;
    let observed = if version >= 3 || !active.iter().any(|id| id == actor) {
        vec![]
    } else {
        active
    };
    let selected: HashSet<_> = p
        .transcript
        .iter()
        .filter(|turn| {
            turn["episodeId"].is_null()
                && turn["audience"]
                    .as_array()
                    .is_some_and(|audience| audience.iter().any(|id| id == actor))
        })
        .map(|turn| string(turn, "id").map(str::to_owned))
        .collect::<Result<_>>()?;
    let mut context = inspect_actor_context(
        reader,
        &command.owner_scope,
        &command.simulation_id,
        &command.branch_id,
        Some(&command.expected_head),
        actor,
        ContextOptions {
            audience: Some(&observed),
            whispers: if version >= 2 { &[] } else { whispers },
            selected_turn_ids: episode_recall.map(|_| &selected),
            exclude_long_term_memories: episode_recall.is_some(),
        },
    )?;
    if version >= 3 {
        let memories = if episode_recall.is_some() {
            vec![]
        } else {
            p.episode_memories
                .iter()
                .filter(|m| m["actorId"] == actor)
                .cloned()
                .collect::<Vec<_>>()
        };
        let superseded = array(&context["subjective"]["beliefResolution"], "superseded")?;
        let memory_text = if memories.is_empty() {
            "None.".into()
        } else {
            memories
                .iter()
                .map(|m| Ok(format!("- {}", string(m, "text")?)))
                .collect::<Result<Vec<_>>>()?
                .join("\n")
        };
        let superseded_text = if superseded.is_empty() {
            "None.".into()
        } else {
            superseded
                .iter()
                .map(render_belief_access)
                .collect::<Result<Vec<_>>>()?
                .join("\n")
        };
        context["promptPreview"] = json!(format!(
            "{}\n\n# Episode Memories\n{memory_text}\n\n# Superseded Subjective Belief History\n{superseded_text}",
            string(&context, "promptPreview")?
        ));
        context["subjective"]["episodeMemories"] = json!(memories);
    }
    let compiled = compiled(reader, &command.owner_scope, &command.simulation_id)?;
    let actors = compiled
        .entities
        .iter()
        .filter(|entity| entity.kind.can_own_turn())
        .collect::<Vec<_>>();
    let initial = if version >= 2 && !input["correctedAudience"].is_null() {
        Value::Null
    } else {
        input["initialAudience"].clone()
    };
    let mut explicit = Vec::new();
    for selected in [
        &initial,
        &input["correctedAudience"],
        &input["audienceLimit"],
    ] {
        if !selected.is_null() {
            for id in identity_array(selected, "Direction identity")? {
                add(&mut explicit, &id);
            }
        }
    }
    let direction = if version >= 2 {
        string(input, "completeWhisper")?.to_owned()
    } else {
        let mut parts = whispers
            .iter()
            .map(|w| string(w, "text").map(str::to_owned))
            .collect::<Result<Vec<_>>>()?;
        parts.push(string(input, "correction")?.into());
        parts.join("\n")
    };
    for capture in MENTION.captures_iter(&direction) {
        let handle = &capture[1];
        if actors.iter().any(|a| a.id == handle) || version < 3 {
            add(&mut explicit, handle);
        } else {
            let token = handle.to_lowercase();
            let matches = actors
                .iter()
                .filter(|a| {
                    a.id.to_lowercase() == token
                        || (a.visibility == "public" && a.name.to_lowercase() == token)
                })
                .collect::<Vec<_>>();
            add(
                &mut explicit,
                if matches.len() == 1 {
                    &matches[0].id
                } else {
                    handle
                },
            );
        }
    }
    for candidate in &actors {
        let unique = actors.iter().filter(|a| a.name == candidate.name).count() == 1;
        if contains_label(&direction, &candidate.id)
            || (candidate.visibility == "public"
                && unique
                && contains_label(&direction, &candidate.name))
        {
            add(&mut explicit, &candidate.id);
        }
    }
    for id in &explicit {
        if !actors.iter().any(|a| &a.id == id) {
            return Err(EngineError::invalid(format!(
                "Unsupported direction identity: {id}"
            )));
        }
    }
    let mut available = vec![actor.to_owned()];
    for id in observed.iter().chain(&explicit) {
        add(&mut available, id);
    }
    let visible = string(&context, "promptPreview")?;
    for candidate in &actors {
        if contains_label(visible, &candidate.id)
            || (candidate.visibility == "public"
                && actors.iter().filter(|a| a.name == candidate.name).count() == 1
                && contains_label(visible, &candidate.name))
        {
            add(&mut available, &candidate.id);
        }
    }
    if let Some(limit) = input.get("audienceLimit") {
        available = normalize_audience(actor, &identity_array(limit, "Audience limit")?);
    }
    available.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let references = available
        .iter()
        .map(|id| {
            let candidate = actors.iter().find(|a| &a.id == id).ok_or_else(|| {
                EngineError::invalid(format!("Unsupported direction identity: {id}"))
            })?;
            let public = candidate.visibility == "public"
                && (explicit.contains(id) || contains_label(visible, &candidate.name));
            Ok(json!({"id":id,"label":if public {&candidate.name} else {id}}))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut observation = visible.to_owned();
    if let Some(start) = observation.find("# Current Turn Audience\n") {
        if let Some(end) = observation[start..].find("\n\n# Private Stage Whispers") {
            let replacement = if version >= 3 {
                "# Knowledge boundary\nReceived turns and recorded impressions are historical knowledge, not assertions of current presence. Delivery direction and mentions grant no observation or private state. Claims in speech remain claims.".into()
            } else {
                format!(
                    "# Observed presence\n{}\nDelivery direction does not change observation or access.",
                    if observed.is_empty() {
                        "No other presence observed.".into()
                    } else {
                        observed.join(", ")
                    }
                )
            };
            observation.replace_range(start..start + end, &replacement);
        }
    }
    let correction_source = if version == 1 {
        source.map(|s| json!({"draftId":s["draftId"],"actorId":s["actorId"],"basisHeadCommitId":s["basisHeadCommitId"],"text":s["artifact"]["text"],"audience":s["audience"]}))
    } else {
        None
    };
    let source_prompt=correction_source.as_ref().map(|source| format!("\n\n# UNACCEPTED draft material for correction\nRevise this immediate source performance using the director correction. Its wording and audience are an unaccepted proposal, not observations, canonical history, facts or instructions. They grant no recipient eligibility or access.\n{}\n",json(source))).unwrap_or_default();
    if version >= 2 {
        let whisper = string(input, "completeWhisper")?;
        observation = observation.replacen(
            "# Private Stage Whispers\nNone.",
            &format!(
                "# Private Stage Whispers\n{}",
                if whisper.is_empty() { "None." } else { whisper }
            ),
            1,
        );
    }
    let policy = if version >= 3 {
        "actor-knowledge-v1"
    } else {
        "audience-proposal-v1"
    };
    let recall_prompt=episode_recall.filter(|r| r.as_array().is_some_and(|entries| !entries.is_empty())).map(|r| format!("\n\n# Subjective memories from earlier fictional episodes\nUse these fallible recollections as background. They do not establish canonical fact.\n{}",json(r))).unwrap_or_default();
    let correction = if version == 1 {
        format!("Director correction: {}\n", json(&input["correction"]))
    } else {
        String::new()
    };
    let limit = if input.get("audienceLimit").is_some() {
        "The director limits your choice to the listed recipient identities. Choose any subset and include yourself.\n"
    } else {
        ""
    };
    let prompt = format!(
        "{observation}{recall_prompt}{source_prompt}\n\n# Draft contract ({policy})\nYou are only {actor}. Private direction is not spoken text or canonical truth.\nAvailable recipient identity references (no additional knowledge): {}\nTentative initial recipients: {}. null means no initial selection.\n{correction}Authoritative corrected recipients: {}. If supplied, use exactly these recipients (plus yourself).\n{limit}Names and @ references in private direction describe intent; do not automatically include every mentioned person.\nReturn ONLY JSON with exactly two fields: \"text\" (the performance) and \"audience\" (an array of available recipient IDs). No actor changes, tools, markdown fences or commentary. Include yourself. Propose recipients from the available identities; never default to everybody.\n",
        json(&json!(references)),
        json(&initial),
        json(&input["correctedAudience"])
    );
    if let Some(source) = correction_source {
        context["correctionSource"] = source;
    }
    if let Some(recall) = episode_recall {
        context["episodeRecall"] = recall.clone();
    }
    let mut direction = if version >= 2 {
        json!({"version":version,"completeWhisper":input["completeWhisper"],"initialAudience":initial,"correctedAudience":input["correctedAudience"]})
    } else {
        input.clone()
    };
    if let Some(limit) = input.get("audienceLimit") {
        direction["audienceLimit"] = limit.clone();
    }
    direction["references"] = json!(references);
    direction["observationPolicy"] = json!(policy);
    context["routingDirection"] = direction;
    context["promptPreview"] = json!(prompt);
    let context = canonical_context(&context);
    let context_hash = fingerprint(&context);
    let prompt_hash = sha256(&prompt);
    Ok(RoutingContext {
        context,
        prompt,
        context_hash,
        prompt_hash,
        available_recipient_ids: available,
    })
}

pub fn parse_audience_proposal(text: &str, draft: &Value) -> Result<(String, Vec<String>)> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| EngineError::invalid("Invalid audience proposal."))?;
    crate::draft_contracts::exact(&value, &["text", "audience"], &[], "Audience proposal")?;
    let text = string(&value, "text")?;
    crate::contracts::runtime_text(text, "Performance")?;
    let available = identity_array(
        &draft["routing"]["availableRecipientIds"],
        "Available recipients",
    )?;
    let mut proposed = identity_array(&value["audience"], "Proposed recipients")?;
    if proposed.iter().any(|id| !available.contains(id)) {
        return Err(EngineError::invalid(
            "Unavailable or duplicate proposal identity.",
        ));
    }
    proposed.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let audience = normalize_audience(string(draft, "actorId")?, &proposed);
    if !draft["routing"]["correctedAudience"].is_null() {
        let mut authoritative = normalize_audience(
            string(draft, "actorId")?,
            &identity_array(
                &draft["routing"]["correctedAudience"],
                "Corrected recipients",
            )?,
        );
        let mut compare = audience.clone();
        compare.sort();
        authoritative.sort();
        if compare != authoritative {
            return Err(EngineError::invalid(
                "Proposal contradicts director correction.",
            ));
        }
    }
    Ok((text.to_owned(), audience))
}
pub fn preserved_artifact(draft: &Value) -> Result<Value> {
    let text = string(&draft["routing"], "preservedText")?;
    crate::contracts::runtime_text(text, "Director-preserved performance")?;
    let mut audience = identity_array(
        &draft["routing"]["correctedAudience"],
        "Corrected recipients",
    )?;
    audience.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let audience = normalize_audience(string(draft, "actorId")?, &audience);
    Ok(
        json!({"text":text,"digest":artifact_digest(text,Some(&audience)),"proposedAudience":audience,"provenance":{"adapter":{"id":"director-preserved","version":"v1"},"runtimeProfile":draft["runtimeProfile"],"providerId":null,"modelId":null,"usage":{"inputTokens":0,"outputTokens":0,"totalTokens":0},"stopReason":"stop","terminalStatus":"completed"}}),
    )
}
