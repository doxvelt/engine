use crate::{
    Bridge, HostError, Reply, generation::store as work, native::required, routes::Operation,
};
use doxvelt_engine::{
    draft_contracts,
    error::{EngineError, ErrorCode},
    model::Command,
    projection::project_branch,
    scene_store::SceneHeadingStore,
};
use serde_json::{Value, json};
use std::path::Path;
pub fn handles(operation: &str) -> bool {
    ["stage.read", "scene.create", "runtime", "draft.legacy"].contains(&operation)
}
pub async fn execute(bridge: &Bridge, operation: Operation, database: &str) -> Reply {
    match run(bridge, operation, database).await {
        Ok(body) => Reply::ok(body),
        Err(e) => Reply::error(e.status, &e.message),
    }
}
fn host_error(message: &str) -> HostError {
    HostError {
        status: 502,
        message: message.into(),
    }
}
async fn run(bridge: &Bridge, operation: Operation, database: &str) -> Result<Value, HostError> {
    if operation.operation == "runtime" {
        let status = bridge.call("model.status", json!({})).await?;
        if !status["configured"].is_boolean() {
            return Err(host_error("Invalid model status."));
        }
        return Ok(status);
    }
    let sim = operation
        .simulation_id
        .ok_or_else(|| EngineError::invalid("simulationId is required."))?;
    let simulation = sim.clone();
    let saved = work(database, move |store| {
        store
            .simulation("local", &simulation)?
            .ok_or_else(|| EngineError {
                code: ErrorCode::NotFound,
                message: format!("Simulation not found: {simulation}"),
            })
    })
    .await?;
    if operation.operation == "draft.legacy" {
        return Err(HostError {status:410,message:"turn-draft is retired; generate a durable draft with POST /simulations/:simulationId/drafts.".into()});
    }
    let features = bridge.call("host.features", json!({})).await?;
    let headings = match &features["sceneHeadingsDatabase"] {
        Value::Null => None,
        Value::String(path) => Some(path.clone()),
        _ => return Err(host_error("Invalid scene heading configuration.")),
    };
    if operation.operation == "scene.create" {
        let path = headings.ok_or_else(|| HostError {
            status: 404,
            message: "Unsupported application operation: scene.create.".into(),
        })?;
        let body = operation.body;
        let command = Command {
            owner_scope: "local".into(),
            simulation_id: sim,
            branch_id: required(&body, "branchId")?,
            expected_head: required(&body, "expectedHead")?,
            command_id: required(&body, "commandId")?,
            payload: Value::Null,
        };
        let title = required(&body, "title")?;
        return work(database,move|store|Ok(json!({"heading":SceneHeadingStore::open(Path::new(&path))?.create(store,&command,&title)?}))).await;
    }
    let branch = operation
        .query
        .get("branchId")
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or(saved.default_branch_id);
    let head = operation
        .query
        .get("head")
        .filter(|s| !s.is_empty())
        .cloned();
    let (mut result,actors)=work(database,move|store|{
        let p=project_branch(store,"local",&sim,&branch,head.as_deref())?;
        let revision=store.revision("local",&saved.content_revision_id)?.ok_or_else(||EngineError::invalid("Pinned content revision missing."))?;
        let scenario=revision.compiled.scenarios.iter().find(|s|Some(&s.id)==saved.scenario_id.as_ref());
        let scenario_name=scenario.map(|s|s.name.as_str()).filter(|s|!s.is_empty()).or(saved.scenario_id.as_deref().filter(|s|!s.is_empty())).unwrap_or("Stage");
        let actors=revision.compiled.entities.iter().filter(|a|a.kind.can_own_turn()).collect::<Vec<_>>();
        let episodes=p.episode_closures.iter().enumerate().map(|(index,c)|json!({"id":c["episode"]["id"],"label":c["episode"]["label"].as_str().filter(|s|!s.is_empty()).map(str::to_owned).unwrap_or_else(||format!("Episode {}",index+1))})).collect::<Vec<_>>();
        let scene_headings=headings.map(|path|SceneHeadingStore::open(Path::new(&path))?.list(store,"local",&sim,&branch,Some(&p.head.id))).transpose()?;
        let mut result=json!({"scenarioName":scenario_name,"branch":p.branch,"transcript":p.transcript,"episodes":episodes,"audience":p.audience,"generationActorIds":[],"actors":actors.iter().map(|a|json!({"id":a.id,"kind":a.kind,"name":if a.visibility=="public" {&a.name} else {&a.id}})).collect::<Vec<_>>()});
        if let Some(headings)=scene_headings {result["sceneHeadings"]=json!(headings);}
        Ok((result,actors.iter().map(|a|a.id.clone()).collect::<Vec<_>>()))
    }).await?;
    let catalog = bridge
        .call("model.catalog", json!({"actorIds":actors}))
        .await?;
    if catalog["generationActorIds"]
        .as_array()
        .is_none_or(|ids| ids.iter().any(|id| !id.is_string()))
    {
        return Err(host_error("Invalid model catalog."));
    }
    result["generationActorIds"] = catalog["generationActorIds"].clone();
    if let Some(configurations) = catalog.get("actorConfigurations") {
        let entries = configurations
            .as_array()
            .ok_or_else(|| host_error("Invalid actor configurations."))?;
        for entry in entries {
            draft_contracts::exact(
                entry,
                &["characterId", "key", "label", "profile"],
                &[],
                "Actor configuration",
            )?;
            for field in ["characterId", "key", "label"] {
                if !entry[field].is_string() {
                    return Err(host_error("Invalid actor configuration field."));
                }
            }
            draft_contracts::reference(&entry["profile"], "Actor configuration profile")?;
        }
        result["actorConfigurations"] = configurations.clone();
    }
    Ok(result)
}
