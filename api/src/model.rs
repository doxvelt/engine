use crate::content::CompiledWorkspace;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentRevision {
    pub id: String,
    pub owner_scope: String,
    pub digest: String,
    pub compiled: CompiledWorkspace,
    pub created_at: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Simulation {
    pub id: String,
    pub owner_scope: String,
    pub content_revision_id: String,
    pub source_root: String,
    pub scenario_id: Option<String>,
    pub default_branch_id: String,
    pub created_at: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BranchOrigin {
    Root {
        command_id: String,
        base_commit_id: String,
    },
    Fork {
        command_id: String,
        source_branch_id: String,
        source_head_commit_id: String,
        base_commit_id: String,
    },
    Edit {
        command_id: String,
        source_branch_id: String,
        source_head_commit_id: String,
        base_commit_id: String,
    },
    Regenerate {
        command_id: String,
        source_branch_id: String,
        source_head_commit_id: String,
        base_commit_id: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Branch {
    pub id: String,
    pub owner_scope: String,
    pub simulation_id: String,
    pub name: Option<String>,
    pub head_commit_id: String,
    pub origin: BranchOrigin,
    pub created_at: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Commit {
    pub id: String,
    pub owner_scope: String,
    pub simulation_id: String,
    pub parent_commit_id: Option<String>,
    pub kind: String,
    pub command_id: String,
    pub events: Vec<Value>,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartSimulation {
    pub owner_scope: String,
    pub simulation_id: String,
    pub source_root: String,
    pub compiled: CompiledWorkspace,
    pub scenario_id: Option<String>,
    pub default_branch_id: String,
    pub root_commit_id: String,
    pub command_id: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartedSimulation {
    pub simulation: Simulation,
    pub branch: Branch,
    pub root: Commit,
    pub content_revision: ContentRevision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub owner_scope: String,
    pub simulation_id: String,
    pub branch_id: String,
    pub expected_head: String,
    pub command_id: String,
    pub payload: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Committed {
    pub branch: Branch,
    pub commit: Commit,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchOutcome {
    pub branch: Branch,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<Commit>,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptRequest {
    pub owner_scope: String,
    pub simulation_id: String,
    pub draft_id: String,
    pub command_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_text"
    )]
    pub final_text: Option<String>,
}
fn present_text<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}
