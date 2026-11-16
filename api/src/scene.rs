//! Scene headings are player annotations. They never enter accepted events,
//! actor context, memory formation or portable simulation truth.
use crate::{
    commands::assert_expected_head,
    error::{EngineError, Result},
    model::Command,
    ports::SimulationReader,
    projection::{project_branch, string},
};
use serde_json::{Value, json};
use std::collections::HashSet;
pub fn validate(command: &Command, title: &str) -> Result<String> {
    if title.trim().is_empty()
        || title.encode_utf16().count() > 160
        || title.chars().any(|c| c <= '\u{1f}')
    {
        return Err(EngineError::invalid(
            "Enter a one-line scene heading of at most 160 characters.",
        ));
    }
    if command.command_id.is_empty()
        || command.command_id.len() > 100
        || !command
            .command_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(EngineError::invalid(
            "A scene heading needs a stable command ID.",
        ));
    }
    Ok(serde_json::to_string(&json!([command.branch_id, command.expected_head, title])).unwrap())
}
pub fn make(reader: &impl SimulationReader, command: &Command, title: &str) -> Result<Value> {
    validate(command, title)?;
    assert_expected_head(reader, command)?;
    let p = project_branch(
        reader,
        &command.owner_scope,
        &command.simulation_id,
        &command.branch_id,
        None,
    )?;
    let last = p.transcript.iter().rev().find(|t| t["episodeId"].is_null());
    Ok(
        json!({"id":format!("scene:{}",command.command_id),"title":title.trim(),"branchId":command.branch_id,"anchor":command.expected_head,"slot":p.episode_closures.last().map(|c|c["episode"]["id"].clone()).unwrap_or_else(||json!("first")),"after":last.map(|t|t.get("logicalMessageId").filter(|id|!id.is_null()).unwrap_or(&t["id"]).clone())}),
    )
}
pub fn public(heading: &Value, episode: Option<&str>) -> Value {
    json!({"id":heading["id"],"title":heading["title"],"after":heading["after"],"episodeId":episode})
}
pub fn project(
    reader: &impl SimulationReader,
    owner: &str,
    simulation: &str,
    branch: &str,
    head: Option<&str>,
    records: &[Value],
) -> Result<Vec<Value>> {
    let p = project_branch(reader, owner, simulation, branch, head)?;
    let mut branches = HashSet::new();
    let mut current = p.branch.clone();
    loop {
        if !branches.insert(current.id.clone()) {
            break;
        }
        let value = serde_json::to_value(&current.origin).unwrap();
        if value["kind"] == "root" {
            break;
        }
        let Some(next) = reader.branch(owner, simulation, string(&value, "sourceBranchId")?)?
        else {
            break;
        };
        current = next;
    }
    let commits: HashSet<_> = p.commits.iter().map(|c| c.id.as_str()).collect();
    let turns: HashSet<_> = p
        .transcript
        .iter()
        .map(|t| {
            t.get("logicalMessageId")
                .filter(|v| !v.is_null())
                .unwrap_or(&t["id"])
        })
        .collect();
    let episodes: Vec<_> = p
        .episode_closures
        .iter()
        .map(|c| c["episode"]["id"].as_str().unwrap())
        .collect();
    let mut result = Vec::new();
    for heading in records {
        if !branches.contains(string(heading, "branchId")?)
            || !commits.contains(string(heading, "anchor")?)
                && (heading["after"].is_null() || !turns.contains(&heading["after"]))
        {
            continue;
        }
        let index = if heading["slot"] == "first" {
            0
        } else if let Some(index) = episodes.iter().position(|id| *id == heading["slot"]) {
            index + 1
        } else {
            continue;
        };
        result.push(public(heading, episodes.get(index).copied()));
    }
    Ok(result)
}
