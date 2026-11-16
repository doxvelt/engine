//! Dated episode-memory application operations and native recall injection.
use crate::{
    Bridge, HostError, Reply,
    generation::store as work,
    native::required,
    reverie::{Reflection, Session},
    routes::Operation,
};
use doxvelt_engine::{
    commands::assert_expected_head,
    episode_memory::{EpisodeCatalog, EpisodeQuery, FormationPlan, MemoryConfiguration},
    error::{EngineError, Result},
    model::Command,
    projection::string,
    safe_fs,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub fn handles(operation: &str) -> bool {
    operation.starts_with("episode-memory.")
}
pub async fn configuration(
    bridge: &Bridge,
) -> std::result::Result<Option<MemoryConfiguration>, HostError> {
    let features = bridge.call("host.features", json!({})).await?;
    let Some(value) = features.get("episodeMemory").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let configuration: MemoryConfiguration = serde_json::from_value(value.clone())
        .map_err(|_| EngineError::invalid("Invalid memory service configuration."))?;
    if [&configuration.directory, &configuration.model_key]
        .iter()
        .any(|s| s.is_empty())
    {
        return Err(EngineError::invalid("Invalid memory service configuration.").into());
    }
    Ok(Some(configuration))
}
pub async fn execute(bridge: &Bridge, operation: Operation, database: &str) -> Reply {
    match run(bridge, operation, database).await {
        Ok(value) => Reply::ok(value),
        Err(error) => Reply::error(error.status, &error.message),
    }
}
async fn run(
    bridge: &Bridge,
    operation: Operation,
    database: &str,
) -> std::result::Result<Value, HostError> {
    let simulation = operation
        .simulation_id
        .ok_or_else(|| EngineError::invalid("simulationId is required."))?;
    let body = operation.body.clone();
    let read = operation.operation == "episode-memory.read";
    let query = work(database, move |store| {
        let simulation = store
            .simulation("local", &simulation)?
            .ok_or_else(|| EngineError {
                code: doxvelt_engine::error::ErrorCode::NotFound,
                message: format!("Simulation not found: {simulation}"),
            })?;
        if read {
            Ok(EpisodeQuery {
                owner_scope: "local".into(),
                simulation_id: simulation.id,
                branch_id: operation
                    .query
                    .get("branchId")
                    .filter(|s| !s.is_empty())
                    .cloned()
                    .unwrap_or(simulation.default_branch_id),
                head: operation
                    .query
                    .get("head")
                    .filter(|s| !s.is_empty())
                    .cloned(),
            })
        } else {
            let command = Command {
                owner_scope: "local".into(),
                simulation_id: simulation.id,
                branch_id: required(&body, "branchId")?,
                expected_head: required(&body, "expectedHead")?,
                command_id: required(&body, "commandId")?,
                payload: Value::Null,
            };
            assert_expected_head(store, &command)?;
            Ok(EpisodeQuery {
                owner_scope: command.owner_scope,
                simulation_id: command.simulation_id,
                branch_id: command.branch_id,
                head: Some(command.expected_head),
            })
        }
    })
    .await?;
    let configuration = configuration(bridge).await?.ok_or_else(|| HostError {
        status: 404,
        message: format!(
            "Unsupported application operation: {}.",
            operation.operation
        ),
    })?;
    let dir = PathBuf::from(&configuration.directory);
    let q = query.clone();
    if read {
        return work(database, move |store| {
            Ok(json!({"episodes":EpisodeCatalog::open(&dir)?.inspect(store,&q)?}))
        })
        .await;
    }
    let slot = required(&operation.body, "slot")?;
    if operation.operation == "episode-memory.date" {
        let date = required(&operation.body, "date")?;
        return work(database, move |store| {
            Ok(json!({"episodes":EpisodeCatalog::open(&dir)?.set_date(store,&q,&slot,&date)?}))
        })
        .await;
    }
    memorize(bridge, database, configuration, query, slot).await
}
async fn memorize(
    bridge: &Bridge,
    database: &str,
    configuration: MemoryConfiguration,
    query: EpisodeQuery,
    slot: String,
) -> std::result::Result<Value, HostError> {
    let dir = PathBuf::from(&configuration.directory);
    let q = query.clone();
    let plan = work(database, move |store| {
        EpisodeCatalog::open(&dir)?.prepare_memorize(store, &q, &slot)
    })
    .await?;
    let mut plan = match plan {
        FormationPlan::Current(value) => return Ok(value),
        FormationPlan::New(plan) => plan,
    };
    let mut files = CacheLease::new(Path::new(&configuration.directory))?;
    for source in &plan.scene.sources {
        let file = files.allocate()?;
        let reflection = Reflection {
            bridge: bridge.clone(),
            source: source.clone(),
            revision: plan.scene.revision.clone(),
            model_key: configuration.model_key.clone(),
            prior: plan.prior.clone(),
        };
        let mut session = Session::open(
            &configuration,
            &files.allocation.directory.join(&file).to_string_lossy(),
            &source.character_id,
            Some(reflection),
        )
        .await?;
        let generated = async {
            session.request("when",json!({"episodeId":plan.scene.revision,"position":plan.scene.date,"label":plan.scene.label})).await?;
            session.request("memorize",json!({"episodeId":plan.scene.revision,"modelKey":configuration.model_key})).await?;
            let result = session.request("inspect",json!({"episodeId":plan.scene.revision})).await?;
            let contribution = result["episodes"].as_array().and_then(|a|a.iter().find(|e|e["episode"]["id"]==plan.scene.revision)).map(|e|&e["contribution"]).filter(|c|c.is_object()).ok_or_else(|| EngineError::invalid("Reverie did not publish a contribution."))?;
            if !contribution["memories"].is_array() || !contribution["impressions"].is_array() {return Err(EngineError::invalid("Reverie returned an invalid contribution.").into());}
            Ok::<Value,HostError>(json!({"file":file,"characterId":source.character_id,"memories":contribution["memories"],"impressions":contribution["impressions"]}))
        }.await;
        session.close().await;
        plan.version["characters"]
            .as_array_mut()
            .unwrap()
            .push(generated?);
    }
    let dir = PathBuf::from(&configuration.directory);
    // The blocking publication owns a cleanup lease too. Cancellation cannot
    // delete a file while a publication is still queued or committing.
    let publication = files.allocation.clone();
    let result = work(database, move |_| {
        let _publication = publication;
        EpisodeCatalog::open(&dir)?
            .publish(&query, &plan.version)
            .map(|(result, _)| result)
    })
    .await;
    files.finish().await;
    result
}
/// Trusted local clients can exercise explicit owner scope without exposing it
/// as a browser-selectable HTTP field.
pub async fn execute_private(bridge: &Bridge, database: &str, params: Value) -> Reply {
    match private(bridge, database, params).await {
        Ok(v) => Reply::ok(v),
        Err(e) => Reply::error(e.status, &e.message),
    }
}
async fn private(
    bridge: &Bridge,
    database: &str,
    params: Value,
) -> std::result::Result<Value, HostError> {
    let query: EpisodeQuery = serde_json::from_value(params["query"].clone())
        .map_err(|_| EngineError::invalid("Invalid episode query."))?;
    let action = string(&params, "action")?;
    if action == "recall" {
        return recall(
            bridge,
            database,
            query,
            string(&params, "actorId")?.into(),
            string(&params, "cue")?.into(),
        )
        .await;
    }
    let configuration = configuration(bridge)
        .await?
        .ok_or_else(|| EngineError::invalid("Episode memory is unavailable."))?;
    if action == "memorize" {
        return memorize(
            bridge,
            database,
            configuration,
            query,
            string(&params, "slot")?.into(),
        )
        .await;
    }
    let directory = PathBuf::from(configuration.directory);
    let action = action.to_owned();
    work(database, move |store| {
        let catalog = EpisodeCatalog::open(&directory)?;
        match action.as_str() {
            "inspect" => Ok(json!(catalog.inspect(store, &query)?)),
            "scenes" => Ok(json!(catalog.scenes(store, &query)?)),
            "date" => Ok(json!(catalog.set_date(
                store,
                &query,
                string(&params, "slot")?,
                string(&params, "date")?
            )?)),
            _ => Err(EngineError::invalid("Unknown episode operation.")),
        }
    })
    .await
}
pub async fn recall(
    bridge: &Bridge,
    database: &str,
    query: EpisodeQuery,
    actor: String,
    cue: String,
) -> std::result::Result<Value, HostError> {
    let Some(configuration) = configuration(bridge).await? else {
        return Ok(json!([]));
    };
    let dir = PathBuf::from(&configuration.directory);
    let actor_id = actor.clone();
    let plan = work(database, move |store| {
        EpisodeCatalog::open(&dir)?.prepare_recall(store, &query, &actor_id, &cue)
    })
    .await?;
    let Some(plan) = plan else {
        return Ok(json!([]));
    };
    let mut recalls = Vec::new();
    for version in plan.publications {
        let Some(character) = version["characters"]
            .as_array()
            .and_then(|a| a.iter().find(|c| c["characterId"] == actor))
        else {
            continue;
        };
        let file = string(character, "file")?;
        let path = cache_path(Path::new(&configuration.directory), file)?;
        // Catalog records cannot turn a retrieval into an arbitrary host path.
        safe_fs::private_file_identity(&path)?;
        let mut session =
            Session::open(&configuration, &path.to_string_lossy(), &actor, None).await?;
        let mut params = json!({"at":plan.date});
        if !plan.search.is_empty() {
            params["cue"] = json!(plan.search);
        }
        let result = session.request("retrieve", params).await;
        session.close().await;
        let result = result?;
        let text = result["text"]
            .as_str()
            .ok_or_else(|| EngineError::invalid("Reverie returned invalid recall text."))?;
        if !text.is_empty() {
            recalls
                .push(json!({"publicationId":version["id"],"label":version["label"],"text":text}));
        }
    }
    Ok(json!(recalls))
}
fn cache_path(directory: &Path, file: &str) -> Result<PathBuf> {
    let uuid = file
        .strip_suffix(".sqlite")
        .and_then(|s| Uuid::parse_str(s).ok())
        .filter(|id| format!("{id}.sqlite") == file)
        .ok_or_else(|| EngineError::invalid("Invalid memory database identity."))?;
    let root = safe_fs::absolute(directory)?;
    safe_fs::assert_no_symlink_components(&root)?;
    let path = root.join(format!("{uuid}.sqlite"));
    if !safe_fs::contained(&root, &path) {
        return Err(EngineError::invalid(
            "Memory database escapes its directory.",
        ));
    }
    Ok(path)
}
struct CacheLease {
    allocation: Arc<CacheAllocation>,
}
struct CacheAllocation {
    directory: PathBuf,
    identity: safe_fs::Identity,
    files: Mutex<Vec<(String, safe_fs::Identity)>>,
}
impl CacheLease {
    fn new(directory: &Path) -> Result<Self> {
        let directory = safe_fs::absolute(directory)?;
        safe_fs::assert_no_symlink_components(&directory)?;
        fs::create_dir_all(&directory).map_err(safe_fs::io)?;
        Ok(Self {
            allocation: Arc::new(CacheAllocation {
                identity: safe_fs::identity(&directory, true)?,
                directory,
                files: Mutex::new(Vec::new()),
            }),
        })
    }
    fn allocate(&mut self) -> Result<String> {
        let name = format!("{}.sqlite", Uuid::new_v4());
        let path = cache_path(&self.allocation.directory, &name)?;
        drop(safe_fs::exclusive_file(&path)?);
        self.allocation
            .files
            .lock()
            .unwrap()
            .push((name.clone(), safe_fs::identity(&path, false)?));
        Ok(name)
    }
    async fn finish(&mut self) {
        let files = std::mem::take(&mut *self.allocation.files.lock().unwrap());
        let directory = self.allocation.directory.clone();
        let identity = self.allocation.identity;
        let _ = tokio::task::spawn_blocking(move || cleanup(directory, identity, files)).await;
    }
}
impl Drop for CacheAllocation {
    fn drop(&mut self) {
        let files = std::mem::take(self.files.get_mut().unwrap());
        if files.is_empty() {
            return;
        }
        let directory = self.directory.clone();
        let identity = self.identity;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(move || cleanup(directory, identity, files));
        } else {
            cleanup(directory, identity, files);
        }
    }
}
fn cleanup(
    directory: PathBuf,
    identity: safe_fs::Identity,
    files: Vec<(String, safe_fs::Identity)>,
) {
    for (name, file_identity) in files {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if !safe_fs::identity(&directory, true).is_ok_and(|id| id == identity) {
                break;
            }
            // A cancelled spawn_blocking publication may have committed after
            // its awaiting future was dropped. The catalog is authoritative.
            if EpisodeCatalog::file_referenced(&directory, &name).unwrap_or(true) {
                break;
            }
            let Ok(path) = cache_path(&directory, &name) else {
                break;
            };
            if !safe_fs::identity(&path, false).is_ok_and(|id| id == file_identity) {
                break;
            }
            let mut complete = true;
            for suffix in ["-wal", "-shm"] {
                let file = directory.join(format!("{name}{suffix}"));
                if let Ok(metadata) = fs::symlink_metadata(&file) {
                    if !metadata.is_file() || safe_fs::symlink(&metadata) {
                        complete = false;
                        continue;
                    }
                    complete &= fs::remove_file(file).is_ok();
                }
            }
            // Keep the database identity available for another ownership check
            // while Windows still has either sidecar locked.
            if complete {
                complete = fs::remove_file(&path).is_ok();
            }
            if complete || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn queued_publication_holds_cleanup_ownership_after_the_request_is_cancelled() {
        for publish in [false, true] {
            let root =
                safe_fs::TempDirectory::create(&std::env::temp_dir(), "doxvelt-publication-lease-")
                    .unwrap();
            let catalog = EpisodeCatalog::open(root.path()).unwrap();
            let mut files = CacheLease::new(root.path()).unwrap();
            let name = files.allocate().unwrap();
            let path = root.path().join(&name);
            let publication = files.allocation.clone();
            drop(files); // The awaiting request was cancelled before its worker ran.
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert!(path.exists());
            if publish {
                let query = EpisodeQuery {
                    owner_scope: "owner".into(),
                    simulation_id: "sim".into(),
                    branch_id: "main".into(),
                    head: None,
                };
                catalog.publish(&query,&json!({"id":"publication","slot":"first","characters":[{"file":name,"characterId":"actor","memories":[],"impressions":[]}]})).unwrap();
            }
            drop(publication); // Cleanup can now observe the final catalog outcome.
            if publish {
                tokio::time::sleep(Duration::from_millis(60)).await;
                assert!(path.exists());
            } else {
                for _ in 0..100 {
                    if !path.exists() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                assert!(!path.exists());
            }
        }
    }
}
