//! Subjective context is a pure projection; caller-supplied turn text is never
//! trusted as an alternative to the authoritative branch transcript.
use crate::{
    access::resolve_paths,
    audience::project_turn,
    content::{Asset, Entity},
    error::{EngineError, ErrorCode, Result},
    ports::SimulationReader,
    projection::{array, project_branch, string},
};
use regex::Regex;
use serde_json::{Value, json};
use std::{collections::HashSet, sync::LazyLock};

#[derive(Default)]
pub struct ContextOptions<'a> {
    pub audience: Option<&'a [String]>,
    pub whispers: &'a [Value],
    pub selected_turn_ids: Option<&'a HashSet<String>>,
    pub exclude_long_term_memories: bool,
}
fn missing(label: &str, id: &str) -> EngineError {
    EngineError {
        code: ErrorCode::NotFound,
        message: format!("{label} not found: {id}"),
    }
}
pub fn inspect_actor_context(
    reader: &impl SimulationReader,
    owner: &str,
    simulation_id: &str,
    branch: &str,
    head: Option<&str>,
    actor_id: &str,
    options: ContextOptions<'_>,
) -> Result<Value> {
    let p = project_branch(reader, owner, simulation_id, branch, head)?;
    let simulation = reader
        .simulation(owner, simulation_id)?
        .ok_or_else(|| missing("Simulation", simulation_id))?;
    let revision = reader
        .revision(owner, &simulation.content_revision_id)?
        .ok_or_else(|| missing("Content revision", &simulation.content_revision_id))?;
    let compiled = revision.compiled;
    let actor = compiled
        .entities
        .iter()
        .find(|e| e.id == actor_id)
        .ok_or_else(|| missing("Actor", actor_id))?;
    let active = options.audience.map(<[String]>::to_vec).unwrap_or_else(|| {
        p.audience
            .iter()
            .filter(|a| a["status"] == "active")
            .filter_map(|a| a["actorId"].as_str().map(str::to_owned))
            .collect()
    });
    for id in &active {
        if !compiled
            .entities
            .iter()
            .any(|e| &e.id == id && e.kind.can_own_turn())
        {
            return Err(missing("Actor", id));
        }
    }
    let observed = active
        .iter()
        .filter(|id| id.as_str() != actor_id)
        .collect::<Vec<_>>();
    let mut current_audience = vec![actor_id.to_owned()];
    current_audience.extend(observed.iter().map(|id| (*id).clone()));
    let turns = p
        .transcript
        .iter()
        .filter(|turn| {
            options
                .selected_turn_ids
                .is_none_or(|ids| turn["id"].as_str().is_some_and(|id| ids.contains(id)))
        })
        .filter_map(|turn| project_turn(turn, actor_id))
        .collect::<Vec<_>>();
    let worlds = compiled
        .worlds
        .iter()
        .map(|world| filter_asset(world, actor))
        .collect::<Vec<_>>();
    let scenario = compiled
        .scenarios
        .iter()
        .find(|s| Some(&s.id) == simulation.scenario_id.as_ref())
        .map(|s| filter_asset(s, actor));
    let history = resolve_belief_access(actor_id, &p.beliefs, &p.access_links)?;
    let resolution = resolve_current_beliefs(&history)?;
    let surfaces = compiled
        .surfaces
        .iter()
        .filter(|s| s.entity == actor_id || observed.iter().any(|id| ***id == s.entity))
        .collect::<Vec<_>>();
    let memories = p
        .long_term_memories
        .iter()
        .filter(|m| !options.exclude_long_term_memories && m["actorId"] == actor_id)
        .cloned()
        .collect::<Vec<_>>();
    let mut sections = vec![
        format!(
            "# Actor\n{} ({}, {})",
            actor.name,
            actor.id,
            serde_json::to_value(&actor.kind).unwrap().as_str().unwrap()
        ),
        render_assets("World", &worlds),
        scenario
            .as_ref()
            .map(|s| render_asset("Scenario", s))
            .unwrap_or_else(|| "# Scenario\nNo scenario selected.".into()),
        render_assets("Format", &compiled.formats),
    ];
    let current = array(&resolution, "current")?;
    let conflicting = array(&resolution, "conflicting")?;
    let mut belief_section = if current.is_empty() {
        "# Current Subjective Beliefs\nNone.".into()
    } else {
        format!(
            "# Current Subjective Beliefs\n{}",
            current
                .iter()
                .map(render_belief_access)
                .collect::<Result<Vec<_>>>()?
                .join("\n")
        )
    };
    if !current.is_empty() && !conflicting.is_empty() {
        belief_section.push_str(&format!(
            "\n\n# Conflicting Belief History\n{}",
            conflicting
                .iter()
                .map(render_belief_access)
                .collect::<Result<Vec<_>>>()?
                .join("\n")
        ));
    }
    sections.push(belief_section);
    sections.push(render_lines(
        "Long-Term Memories",
        memories
            .iter()
            .map(|m| format!("- {}", m["text"].as_str().unwrap_or_default()))
            .collect(),
        "None.",
    ));
    sections.push(render_lines(
        "Projected Surfaces",
        surfaces
            .iter()
            .map(|s| {
                format!(
                    "- @{}{}: {}",
                    s.entity,
                    if s.channels.is_empty() {
                        String::new()
                    } else {
                        format!(" [{}]", s.channels.join(","))
                    },
                    s.text
                )
            })
            .collect(),
        "None.",
    ));
    let mut listeners: Vec<&str> = Vec::new();
    for id in &current_audience {
        if id != actor_id && !listeners.contains(&id.as_str()) {
            listeners.push(id);
        }
    }
    sections.push(if listeners.is_empty() { format!("# Current Turn Audience\nOnly @{actor_id} is in the audience for this turn.\nWrite as if this is private self-directed speech, narration, notes, or internal reflection unless the stage whisper or scenario says otherwise.") }
        else { format!("# Current Turn Audience\n@{actor_id} is speaking where these entities can hear or observe this turn: {}.",listeners.iter().map(|id| format!("@{id}")).collect::<Vec<_>>().join(", ")) });
    sections.push(render_lines(
        "Private Stage Whispers",
        options
            .whispers
            .iter()
            .map(|w| format!("- {}", w["text"].as_str().unwrap_or_default()))
            .collect(),
        "None.",
    ));
    sections.push(render_lines(
        "Accessible Transcript",
        turns
            .iter()
            .map(|t| {
                format!(
                    "{}: {}",
                    t["actorId"].as_str().unwrap_or_default(),
                    t["text"].as_str().unwrap_or_default()
                )
            })
            .collect(),
        "No accessible turns yet.",
    ));
    Ok(
        json!({"simulation":{"id":simulation.id,"scenarioId":simulation.scenario_id,"sourceRoot":simulation.source_root},"actor":actor,
        "assets":{"worlds":worlds,"scenario":scenario,"formats":compiled.formats},
        "subjective":{"beliefs":current.iter().map(|a| &a["belief"]).collect::<Vec<_>>(),"beliefAccess":current,"beliefHistoryAccess":history,"beliefResolution":resolution,
            "longTermMemories":memories,"surfaces":surfaces,"transcript":turns,"stageWhispers":options.whispers,"currentAudience":current_audience},
        "diagnostics":[],"promptPreview":sections.join("\n\n")}),
    )
}
fn render_lines(label: &str, lines: Vec<String>, empty: &str) -> String {
    format!(
        "# {label}\n{}",
        if lines.is_empty() {
            empty.into()
        } else {
            lines.join("\n")
        }
    )
}
fn render_asset(label: &str, asset: &Asset) -> String {
    format!(
        "# {label}: {}\n{}",
        asset.name,
        if asset.body.is_empty() {
            "(No body text.)"
        } else {
            &asset.body
        }
    )
}
fn render_assets(label: &str, assets: &[Asset]) -> String {
    if assets.is_empty() {
        format!("# {label}\nNone.")
    } else {
        assets
            .iter()
            .map(|a| render_asset(label, a))
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}
fn filter_asset(asset: &Asset, actor: &Entity) -> Asset {
    static HOLDER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"@([a-zA-Z0-9_-]+)").unwrap());
    let mut filtered = asset.clone();
    filtered.body = asset
        .body
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| {
            !line.contains(":hidden")
                || HOLDER
                    .captures(line)
                    .is_some_and(|capture| capture.get(1).unwrap().as_str() == actor.id)
        })
        .collect::<Vec<_>>()
        .join("\n");
    filtered
}
pub fn resolve_belief_access(
    actor: &str,
    beliefs: &[Value],
    links: &[crate::content::AccessLink],
) -> Result<Vec<Value>> {
    let paths = resolve_paths(actor, links);
    let mut direct = Vec::new();
    let mut membership = Vec::new();
    for belief in beliefs {
        let holder = string(belief, "holder")?;
        if holder == actor {
            let (mode, source, path) =
                if belief.get("sourceHolder").is_some() && belief.get("accessPath").is_some() {
                    (
                        "retained_after_access_loss",
                        belief["sourceHolder"].clone(),
                        belief["accessPath"].clone(),
                    )
                } else if belief.get("observerId").is_some() && belief.get("entityId").is_some() {
                    (
                        "observed",
                        belief["entityId"].clone(),
                        json!([actor, belief["entityId"]]),
                    )
                } else {
                    ("held", json!(holder), json!([actor]))
                };
            direct.push(json!({"belief":belief,"provenance":{"mode":mode,"holder":actor,"sourceHolder":source,"accessPath":path}}));
        } else if let Some(path) = paths.get(holder) {
            membership.push(json!({"belief":belief,"provenance":{"mode":"accessed_through_membership","holder":actor,"sourceHolder":holder,"accessPath":path}}));
        }
    }
    direct.extend(membership);
    Ok(direct)
}
pub fn resolve_current_beliefs(accesses: &[Value]) -> Result<Value> {
    static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
    let mut grouped: Vec<(String, Vec<Value>)> = Vec::new();
    for access in accesses {
        let p = &access["provenance"];
        let scope = match string(p, "mode")? {
            "accessed_through_membership" => "live",
            "retained_after_access_loss" => "retained",
            "observed" => "observed",
            _ => "held",
        };
        let holder = string(
            p,
            if scope == "held" {
                "holder"
            } else {
                "sourceHolder"
            },
        )?;
        let lower = string(&access["belief"], "propositionText")?.to_lowercase();
        let normalized = SPACE.replace_all(&lower, " ");
        let key = format!(
            "{scope}:{holder}:{}",
            normalized.trim_end_matches(['.', '!', '?']).trim()
        );
        if let Some((_, values)) = grouped.iter_mut().find(|(k, _)| k == &key) {
            values.push(access.clone());
        } else {
            grouped.push((key, vec![access.clone()]));
        }
    }
    let mut current = Vec::new();
    let mut superseded = Vec::new();
    let mut conflicting = Vec::new();
    let mut groups = Vec::new();
    for (key, mut values) in grouped {
        values.sort_by(|a, b| {
            strength(b)
                .abs()
                .total_cmp(&strength(a).abs())
                .then_with(|| recency(&b["belief"]).total_cmp(&recency(&a["belief"])))
                .then_with(|| strength(b).total_cmp(&strength(a)))
        });
        let first = values.remove(0);
        let mut superseded_group = Vec::new();
        let mut conflicting_group = Vec::new();
        for access in values {
            if strength(&first) != 0.0
                && strength(&access) != 0.0
                && strength(&first).signum() != strength(&access).signum()
            {
                conflicting_group.push(access);
            } else {
                superseded_group.push(access);
            }
        }
        groups.push(json!({"key":key,"current":[first],"superseded":superseded_group,"conflicting":conflicting_group}));
        current.push(first);
        superseded.extend(superseded_group);
        conflicting.extend(conflicting_group);
    }
    Ok(json!({"current":current,"superseded":superseded,"conflicting":conflicting,"groups":groups}))
}
fn strength(access: &Value) -> f64 {
    access["belief"]["strength"].as_f64().unwrap_or(0.0)
}
fn recency(belief: &Value) -> f64 {
    let numeric = belief
        .get("id")
        .and_then(|id| {
            id.as_f64().or_else(|| {
                id.as_str().and_then(|s| {
                    if s.trim().is_empty() {
                        Some(0.0)
                    } else {
                        s.parse::<f64>().ok()
                    }
                })
            })
        })
        .filter(|n| n.is_finite());
    if let Some(time) = belief["createdAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    {
        return time.timestamp_millis() as f64 + numeric.unwrap_or(0.0) / 1_000_000.0;
    }
    if belief.get("id").is_some() {
        numeric.unwrap_or(0.0)
    } else {
        belief["sourceSpan"]["line"].as_f64().unwrap_or(0.0)
    }
}
pub fn render_belief_access(access: &Value) -> Result<String> {
    let p = &access["provenance"];
    let source = string(p, "sourceHolder")?;
    let path = array(p, "accessPath")?
        .iter()
        .map(|id| format!("@{}", id.as_str().unwrap_or_default()))
        .collect::<Vec<_>>()
        .join(" -> ");
    let suffix = match string(p, "mode")? {
        "accessed_through_membership" => format!(" (held by @{source}; accessed through {path})"),
        "observed" => format!(" (first impression of @{source})"),
        "retained_after_access_loss" => {
            format!(" (retained after losing access to @{source}; old path {path})")
        }
        _ => String::new(),
    };
    let strength = strength(access);
    Ok(format!(
        "- [{}{}]{suffix} {}",
        if strength > 0.0 { "+" } else { "" },
        strength,
        string(&access["belief"], "propositionText")?
    ))
}
