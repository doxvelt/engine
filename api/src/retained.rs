//! Access loss can retain a weakened subjective belief; it never grants the
//! actor another entity's current knowledge after the access path disappears.
use crate::{
    access::{AccessChange, apply_change},
    content::{CompiledWorkspace, EntityKind},
    context::resolve_belief_access,
    error::{EngineError, Result},
    identity::domain_id,
    model::Commit,
    projection::{array, string},
};
use serde_json::{Value, json};
use std::collections::HashSet;

fn access_key(access: &Value) -> Result<String> {
    Ok(format!(
        "{}\0{}",
        string(&access["provenance"], "sourceHolder")?,
        string(&access["belief"], "propositionText")?
    ))
}
pub fn derive_retained_beliefs(
    compiled: &CompiledWorkspace,
    commits: &[Commit],
    excluded: &HashSet<String>,
    simulation: &str,
    command: &str,
    episode: &str,
    created: &str,
) -> Result<Vec<Value>> {
    let actors = compiled
        .entities
        .iter()
        .filter(|e| e.kind == EntityKind::Agent)
        .collect::<Vec<_>>();
    let mut lost: Vec<Vec<(String, Value, String)>> = actors.iter().map(|_| vec![]).collect();
    let mut links = compiled.access_links.clone();
    let mut beliefs = compiled
        .beliefs
        .iter()
        .map(|b| serde_json::to_value(b).unwrap())
        .collect::<Vec<_>>();
    let mut impression_index = 0;
    for commit in commits {
        for (index, event) in commit.events.iter().enumerate() {
            match string(event, "type")? {
                "access_changed" => {
                    let before = actors
                        .iter()
                        .map(|a| resolve_belief_access(&a.id, &beliefs, &links))
                        .collect::<Result<Vec<_>>>()?;
                    let change: AccessChange = serde_json::from_value(json!({"action":event["action"],"member":event["member"],"container":event["container"],"reason":event["reason"]})).map_err(|e| EngineError::invalid(e.to_string()))?;
                    links = apply_change(&links, &change);
                    if event["action"] != "revoke" {
                        continue;
                    }
                    for (i, actor) in actors.iter().enumerate() {
                        let after: HashSet<_> = resolve_belief_access(&actor.id, &beliefs, &links)?
                            .iter()
                            .map(access_key)
                            .collect::<Result<_>>()?;
                        for access in &before[i] {
                            let key = access_key(access)?;
                            if access["provenance"]["mode"] != "accessed_through_membership"
                                || after.contains(&key)
                            {
                                continue;
                            }
                            let value = (
                                key.clone(),
                                access.clone(),
                                format!("{}:event:{index}", commit.id),
                            );
                            if let Some(position) = lost[i].iter().position(|(k, _, _)| k == &key) {
                                lost[i][position] = value;
                            } else {
                                lost[i].push(value);
                            }
                        }
                    }
                }
                "first_impression_formed" => {
                    let mut impression = event["impression"].clone();
                    impression["id"] =
                        json!(format!("{}:impression:{impression_index}", commit.id));
                    impression_index += 1;
                    impression["simulationId"] = json!(simulation);
                    impression["createdAt"] = json!(commit.created_at);
                    beliefs.push(impression);
                }
                "episode_closed" if !excluded.contains(&commit.id) => {
                    beliefs.extend_from_slice(array(&event["closure"], "extractedBeliefs")?);
                    beliefs.extend_from_slice(array(&event["closure"], "retainedBeliefs")?);
                }
                _ => (),
            }
        }
    }
    let mut retained = Vec::new();
    for (i, actor) in actors.iter().enumerate() {
        let current: HashSet<_> = resolve_belief_access(&actor.id, &beliefs, &links)?
            .iter()
            .map(access_key)
            .collect::<Result<_>>()?;
        let mut index = 0;
        for (key, access, event) in &lost[i] {
            if access["provenance"]["mode"] != "accessed_through_membership"
                || current.contains(key)
                || access["belief"].get("sourceBelief").is_some()
            {
                continue;
            }
            let strength = access["belief"]["strength"]
                .as_i64()
                .ok_or_else(|| EngineError::invalid("Invalid belief strength."))?
                .signum();
            retained.push(json!({"id":domain_id("retained",&[command,&actor.id,&index.to_string()]),"episodeId":episode,"simulationId":simulation,"holder":actor.id,"strength":strength,
                "propositionText":access["belief"]["propositionText"],"sourceHolder":access["provenance"]["sourceHolder"],"accessPath":access["provenance"]["accessPath"],"sourceBelief":access["belief"],"runtimeAccessEventId":event,"createdAt":created}));
            index += 1;
        }
    }
    Ok(retained)
}
